interface Env {
  GITHUB_TOKEN: string;
  FEEDBACK_CONTACTS: KVNamespace;
}

interface SyncRunInfo {
  source: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  messages_added: number;
  error_message: string | null;
}

interface LogEntry {
  level: "error" | "warn";
  message: string;
  timestamp: number;
}

interface DiagnosticSnapshot {
  userName?: string;
  userEmail?: string;
  syncStatus: {
    latest_by_source: Record<string, SyncRunInfo>;
    has_sync_runs: boolean;
  } | null;
  appVersion: string;
  os: string;
  windowSize: { width: number; height: number };
  url: string;
  userAgent: string;
  consoleLogs: LogEntry[];
  conversation: string[] | null;
  sessionKind: string;
  timestamp: string;
}

interface FeedbackRequest {
  type: "bug" | "feedback";
  message: string;
  email?: string;
  appVersion?: string;
  os?: string;
  diagnostics?: DiagnosticSnapshot;
  screenshot?: string; // base64 data URL
}

const REPO = "thyself-fyi/thyself-feedback";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function checkRateLimit(
  ip: string,
  kv: KVNamespace
): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= RATE_LIMIT_MAX) {
    return false;
  }

  await kv.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });
  return true;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSyncTable(syncStatus: DiagnosticSnapshot["syncStatus"]): string {
  if (!syncStatus?.latest_by_source) return "_No sync data available_";
  const entries = Object.entries(syncStatus.latest_by_source);
  if (entries.length === 0) return "_No sync runs recorded_";

  const sourceLabels: Record<string, string> = {
    gmail: "Gmail",
    imessage: "iMessage",
    whatsapp_desktop: "WA Desktop",
    whatsapp_web: "WA Web",
    chatgpt: "ChatGPT",
  };

  let table = "| Source | Status | Last Sync | Messages | Error |\n";
  table += "|--------|--------|-----------|----------|-------|\n";
  for (const [, run] of entries) {
    const label = sourceLabels[run.source] || run.source;
    const status = run.status === "completed" ? "✅" : run.status === "failed" ? "❌" : run.status === "running" ? "🔄" : run.status;
    const lastSync = timeAgo(run.started_at);
    const msgs = run.messages_added.toLocaleString();
    const err = run.error_message ? `\`${run.error_message.slice(0, 80)}\`` : "—";
    table += `| ${label} | ${status} ${run.status} | ${lastSync} | ${msgs} | ${err} |\n`;
  }
  return table;
}

function formatLogs(logs: LogEntry[]): string {
  if (!logs || logs.length === 0) return "_No console logs captured_";

  return logs
    .slice(-30)
    .map((l) => {
      const t = new Date(l.timestamp).toISOString().slice(11, 19);
      const tag = l.level === "error" ? "ERR" : "WRN";
      const msg = l.message.length > 300 ? l.message.slice(0, 300) + "…" : l.message;
      return `[${t}] ${tag}: ${msg}`;
    })
    .join("\n");
}

function formatConversation(lines: string[]): string {
  const recent = lines.slice(-20);
  if (lines.length > 20) {
    return `_...${lines.length - 20} earlier messages omitted..._\n\n` + recent.join("\n\n");
  }
  return recent.join("\n\n");
}

function buildIssueBody(body: FeedbackRequest, screenshotUrl: string | null): string {
  const diag = body.diagnostics;
  const appVersion = diag?.appVersion || body.appVersion || "unknown";
  const os = diag?.os || body.os || "unknown";

  let md = body.message.trim();
  md += "\n\n---\n";

  const userName = diag?.userName || "unknown";
  md += `\n**User:** ${userName}`;
  md += ` · **App version:** ${appVersion} · **OS:** ${os}`;
  if (diag?.sessionKind) {
    md += ` · **Session:** ${diag.sessionKind}`;
  }
  if (diag?.userEmail || body.email?.trim()) {
    md += " · **Contact:** provided (stored privately)";
  }
  md += "\n";

  if (screenshotUrl) {
    md += `\n### Screenshot\n![screenshot](${screenshotUrl})\n`;
  }

  if (diag?.conversation && diag.conversation.length > 0) {
    md += "\n### Conversation\n\n";
    md += formatConversation(diag.conversation);
    md += "\n";
  }

  if (diag) {
    const logs = diag.consoleLogs ?? [];
    const errors = logs.filter((l) => l.level === "error");
    if (errors.length > 0) {
      md += "\n### Errors\n```\n" + formatLogs(errors) + "\n```\n";
    }

    const collapsedParts: string[] = [];

    if (logs.length > errors.length) {
      collapsedParts.push("**Warnings**\n```\n" + formatLogs(logs.filter((l) => l.level === "warn")) + "\n```");
    }

    const syncTable = formatSyncTable(diag.syncStatus);
    if (syncTable !== "_No sync data available_" && syncTable !== "_No sync runs recorded_") {
      collapsedParts.push("**Sync Status**\n" + syncTable);
    }

    collapsedParts.push(
      "**Environment**\n" +
      `- Window: ${diag.windowSize.width}×${diag.windowSize.height}\n` +
      `- User Agent: ${diag.userAgent}\n` +
      `- Collected at: ${diag.timestamp}`
    );

    md += "\n<details>\n<summary>More diagnostics</summary>\n\n";
    md += collapsedParts.join("\n\n");
    md += "\n\n</details>\n";
  }

  md += "\n_Submitted via in-app feedback_\n";

  return md;
}

const WORKER_PUBLIC_URL = "https://thyself-feedback.jfru.workers.dev";

async function storeScreenshot(
  kv: KVNamespace,
  dataUrl: string,
  issueNumber: number
): Promise<string | null> {
  try {
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return null;
    const [, mimeType, base64] = match;
    const key = `screenshot-${issueNumber}`;
    await kv.put(key, base64, {
      expirationTtl: 60 * 60 * 24 * 365,
      metadata: { mimeType },
    });
    return `${WORKER_PUBLIC_URL}/screenshot/${key}`;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.startsWith("/screenshot/")) {
      const key = url.pathname.slice("/screenshot/".length);
      if (!key) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }
      const { value, metadata } = await env.FEEDBACK_CONTACTS.getWithMetadata<{
        mimeType: string;
      }>(key);
      if (!value) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }
      const binary = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      return new Response(binary, {
        status: 200,
        headers: {
          "Content-Type": metadata?.mimeType || "image/png",
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders,
        },
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        { success: false, error: "Method not allowed" },
        { status: 405, headers: corsHeaders }
      );
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const allowed = await checkRateLimit(clientIp, env.FEEDBACK_CONTACTS);
    if (!allowed) {
      return Response.json(
        { success: false, error: "Rate limit exceeded. Please try again later." },
        { status: 429, headers: corsHeaders }
      );
    }

    let body: FeedbackRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "Invalid JSON" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!body.message?.trim()) {
      return Response.json(
        { success: false, error: "Message is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const isBug = body.type === "bug";
    const prefix = isBug ? "[Bug]" : "[Feedback]";
    const firstLine = body.message.trim().split("\n")[0];
    const title = `${prefix} ${firstLine.slice(0, 80)}${firstLine.length > 80 ? "..." : ""}`;

    // Create issue without screenshot first
    let issueBody = buildIssueBody(body, null);

    const ghResponse = await fetch(
      `https://api.github.com/repos/${REPO}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "thyself-feedback-worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          body: issueBody,
          labels: [isBug ? "bug" : "enhancement"],
        }),
      }
    );

    if (!ghResponse.ok) {
      const errorText = await ghResponse.text();
      console.error("GitHub API error:", ghResponse.status, errorText);
      return Response.json(
        { success: false, error: "Failed to submit feedback" },
        { status: 502, headers: corsHeaders }
      );
    }

    const issue = (await ghResponse.json()) as { number: number };

    // Store email privately
    const email = body.email?.trim() || body.diagnostics?.userEmail;
    if (email) {
      await env.FEEDBACK_CONTACTS.put(
        `issue-${issue.number}`,
        email,
        { expirationTtl: 60 * 60 * 24 * 365 }
      );
    }

    // Store screenshot in KV and update issue with public URL
    if (body.screenshot) {
      const screenshotUrl = await storeScreenshot(
        env.FEEDBACK_CONTACTS,
        body.screenshot,
        issue.number
      );
      if (screenshotUrl) {
        issueBody = buildIssueBody(body, screenshotUrl);
        await fetch(
          `https://api.github.com/repos/${REPO}/issues/${issue.number}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "thyself-feedback-worker",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ body: issueBody }),
          }
        );
      }
    }

    return Response.json(
      { success: true, issueNumber: issue.number },
      { status: 201, headers: corsHeaders }
    );
  },
};

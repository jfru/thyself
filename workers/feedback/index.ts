interface Env {
  GITHUB_TOKEN: string;
  FEEDBACK_CONTACTS: KVNamespace;
}

interface FeedbackRequest {
  type: "bug" | "feedback";
  message: string;
  email?: string;
  appVersion: string;
  os: string;
}

const REPO = "jfru/thyself";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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

    const hasEmail = !!body.email?.trim();
    const metaParts = [
      `- **App version:** ${body.appVersion || "unknown"}`,
      `- **OS:** ${body.os || "unknown"}`,
      ...(hasEmail ? ["- **Contact:** provided (stored privately)"] : []),
    ];

    const issueBody = `${body.message.trim()}\n\n---\n*Submitted via in-app feedback*\n${metaParts.join("\n")}`;

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

    if (hasEmail) {
      await env.FEEDBACK_CONTACTS.put(
        `issue-${issue.number}`,
        body.email!.trim(),
        { expirationTtl: 60 * 60 * 24 * 365 }
      );
    }

    return Response.json(
      { success: true, issueNumber: issue.number },
      { status: 201, headers: corsHeaders }
    );
  },
};

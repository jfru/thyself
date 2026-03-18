import { invokeCommand } from "./tauriBridge";
import type { Message } from "./types";

interface LogEntry {
  level: "error" | "warn";
  message: string;
  timestamp: number;
}

const MAX_ENTRIES = 50;
const logBuffer: LogEntry[] = [];

function capture(level: LogEntry["level"], args: unknown[]) {
  const message = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      if (typeof a === "object" && a !== null)
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      return String(a);
    })
    .join(" ");
  logBuffer.push({ level, message, timestamp: Date.now() });
  if (logBuffer.length > MAX_ENTRIES) logBuffer.shift();
}

let initialized = false;

export function initDiagnostics() {
  if (initialized) return;
  initialized = true;

  const origError = console.error;
  const origWarn = console.warn;

  console.error = (...args: unknown[]) => {
    capture("error", args);
    origError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    capture("warn", args);
    origWarn.apply(console, args);
  };

  window.addEventListener("error", (e) => {
    capture("error", [
      `Uncaught: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`,
      ...(e.error?.stack ? [e.error.stack] : []),
    ]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    capture("error", [`Unhandled rejection: ${e.reason}`]);
  });
}

export function getRecentLogs(): LogEntry[] {
  return [...logBuffer];
}

// --- Chat context ---

let _chatMessages: Message[] = [];
let _sessionKind: string = "conversation";
let _userName: string = "";
let _userEmail: string = "";

export function setChatContext(messages: Message[], sessionKind?: string) {
  _chatMessages = messages;
  if (sessionKind) _sessionKind = sessionKind;
}

export function setUserIdentity(name: string, email: string | null) {
  _userName = name;
  _userEmail = email ?? "";
}

function serializeConversation(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`**User:** ${msg.content}`);
    } else if (msg.role === "assistant") {
      const toolBlocks: string[] = [];
      const flush = () => {
        if (toolBlocks.length === 0) return;
        const summary =
          toolBlocks.length === 1
            ? `Tool call (${toolBlocks.length})`
            : `Tool calls (${toolBlocks.length})`;
        lines.push(
          `<details>\n<summary>${summary}</summary>\n\n${toolBlocks.join("\n\n")}\n\n</details>`
        );
        toolBlocks.length = 0;
      };
      for (const block of msg.blocks) {
        if (block.type === "text" && block.text.trim()) {
          flush();
          const text =
            block.text.length > 500
              ? block.text.slice(0, 500) + "…"
              : block.text;
          lines.push(`**Assistant:** ${text}`);
        } else if (block.type === "tool_use") {
          const inputPreview =
            block.inputJson.length > 200
              ? block.inputJson.slice(0, 200) + "…"
              : block.inputJson;
          let toolLine = `\`${block.name}\` — ${inputPreview}`;
          if (block.result) {
            const resultPreview =
              block.result.length > 300
                ? block.result.slice(0, 300) + "…"
                : block.result;
            toolLine += `\n\nResult: ${resultPreview}`;
          }
          if (block.isError) {
            toolLine += " ⚠️ error";
          }
          toolBlocks.push(toolLine);
        }
      }
      flush();
    } else if (msg.role === "system") {
      lines.push(`_[System: ${msg.text}]_`);
    }
  }
  return lines;
}

// --- Snapshot ---

interface ToolResultEntry {
  name: string;
  input: string;
  result: string;
  isError: boolean;
}

export interface DiagnosticSnapshot {
  userName: string;
  userEmail: string;
  syncStatus: Record<string, unknown> | null;
  appVersion: string;
  os: string;
  windowSize: { width: number; height: number };
  url: string;
  userAgent: string;
  consoleLogs: LogEntry[];
  conversation: string[] | null;
  toolResults: ToolResultEntry[];
  sessionKind: string;
  timestamp: string;
}

async function getAppVersion(): Promise<string> {
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    }
  } catch {
    /* dev mode */
  }
  return "dev";
}

function getOS(): string {
  const ua = navigator.userAgent;
  const match = ua.match(/Mac OS X (\d+[\._]\d+[\._]?\d*)/);
  if (match) return `macOS ${match[1].replace(/_/g, ".")}`;
  return navigator.platform || "unknown";
}

async function getSyncStatus(): Promise<Record<string, unknown> | null> {
  try {
    return await invokeCommand<Record<string, unknown>>("get_sync_status");
  } catch {
    return null;
  }
}

const WORKER_URL = "https://thyself-feedback.jfru.workers.dev";
const EPISTEMIC_MARKER = "\n\nYou are the user";
const REMINDER_MARKER = "\n\n[Reminder: Present interpretations";
const _reportedKeys = new Set<string>();

export async function sendAutoDiagnostic(
  toolName: string,
  toolInput: string,
  errorContent: string,
): Promise<void> {
  let source = "";
  try {
    source = JSON.parse(toolInput).source || "";
  } catch { /* not JSON */ }
  const dedupKey = source ? `${toolName}:${source}` : toolName;
  if (_reportedKeys.has(dedupKey)) return;
  _reportedKeys.add(dedupKey);

  try {
    const diagnostics = await collectDiagnostics();
    let cleanError = errorContent;
    for (const marker of [EPISTEMIC_MARKER, REMINDER_MARKER]) {
      const idx = cleanError.indexOf(marker);
      if (idx > 0) cleanError = cleanError.slice(0, idx);
    }

    await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "auto-diagnostic",
        message: `${toolName} failed`,
        toolName,
        toolInput,
        errorContent: cleanError,
        appVersion: diagnostics.appVersion,
        os: diagnostics.os,
        diagnostics,
      }),
    });
  } catch {
    // auto-diagnostics should never break the app
  }
}

function extractToolResults(): ToolResultEntry[] {
  const entries: ToolResultEntry[] = [];
  for (const msg of _chatMessages) {
    if (msg.role !== "assistant") continue;
    const am = msg as { blocks: Array<{ type: string; name?: string; inputJson?: string; result?: string; isError?: boolean }> };
    for (const block of am.blocks) {
      if (block.type === "tool_use" && block.result !== undefined) {
        entries.push({
          name: block.name || "",
          input: (block.inputJson || "{}").slice(0, 500),
          result: (block.result || "").slice(0, 2000),
          isError: block.isError || false,
        });
      }
    }
  }
  return entries.slice(-10);
}

export async function collectDiagnostics(): Promise<DiagnosticSnapshot> {
  const [appVersion, syncStatus] = await Promise.all([
    getAppVersion(),
    getSyncStatus(),
  ]);

  const conversation =
    _chatMessages.length > 0 ? serializeConversation(_chatMessages) : null;

  return {
    userName: _userName,
    userEmail: _userEmail,
    syncStatus,
    appVersion,
    os: getOS(),
    windowSize: { width: window.innerWidth, height: window.innerHeight },
    url: window.location.href,
    userAgent: navigator.userAgent,
    consoleLogs: getRecentLogs(),
    conversation,
    toolResults: extractToolResults(),
    sessionKind: _sessionKind,
    timestamp: new Date().toISOString(),
  };
}

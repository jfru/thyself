const DEV_SERVER = "http://localhost:3001";

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

/**
 * Invoke a backend command. Routes through Tauri IPC when in the native
 * webview, or through the dev HTTP server when in a regular browser.
 */
export async function invokeCommand<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }

  const getCommands = new Set([
    "data_dir", "tool_defs", "get_data_dir_path", "get_tool_defs", "list_sessions",
    "get_sync_status", "sync_status", "list_profiles", "get_active_profile",
    "get_subject_name",
  ]);
  const method = getCommands.has(cmd) ? "GET" : "POST";

  const endpointMap: Record<string, string> = {
    get_data_dir_path: "data_dir",
    get_tool_defs: "tool_defs",
    get_sync_status: "sync_status",
  };
  const endpoint = endpointMap[cmd] || cmd;

  const opts: RequestInit = { method };
  if (method === "POST") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(args || {});
  }

  const res = await fetch(`${DEV_SERVER}/api/${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  return res.json() as Promise<T>;
}

export interface StreamEventPayload {
  event_type: string;
  data: Record<string, unknown>;
}

/**
 * Listen for streaming chat events. In Tauri, uses the event system.
 * In the browser, makes a POST to the dev server SSE endpoint and reads
 * the event stream.
 *
 * Returns a cleanup/unlisten function.
 */
export async function streamChat(
  args: {
    messages: unknown[];
    systemPrompt: string;
    tools: unknown[];
    streamId: string;
  },
  onEvent: (payload: StreamEventPayload) => void
): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    const { invoke } = await import("@tauri-apps/api/core");

    const unlisten = await listen<StreamEventPayload>(
      `stream-event-${args.streamId}`,
      (event) => onEvent(event.payload)
    );

    invoke("stream_chat", args).catch((err: unknown) => {
      onEvent({
        event_type: "error",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    });

    return unlisten;
  }

  // Browser mode: POST to SSE endpoint
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${DEV_SERVER}/api/stream_chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        onEvent({ event_type: "error", data: { error: err } });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const lines = part.split("\n");
          let data = "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              data = line.slice(5).trim();
            }
          }
          if (data) {
            try {
              const payload = JSON.parse(data) as StreamEventPayload;
              onEvent(payload);
            } catch {
              // skip malformed events
            }
          }
        }
      }

      // The backend emits message_stop before closing the stream,
      // so no synthetic event needed here.
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onEvent({
          event_type: "error",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  })();

  return () => controller.abort();
}

/**
 * Signal the backend to stop an active chat stream.
 * In browser mode, hits the /api/stop_chat endpoint.
 */
export async function stopChat(streamId: string): Promise<void> {
  if (isTauri()) {
    // TODO: implement Tauri-side cancellation
    return;
  }

  try {
    await fetch(`${DEV_SERVER}/api/stop_chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId }),
    });
  } catch {
    // best-effort
  }
}

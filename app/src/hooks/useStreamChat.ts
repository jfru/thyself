import { useState, useCallback, useRef } from "react";
import { streamChat, stopChat, invokeCommand, type StreamEventPayload } from "../lib/tauriBridge";
import type {
  Message,
  AssistantMessage,
  ContentBlock,
  TextBlock,
  WebSearchResult,
  ImageAttachment,
  FileAttachment,
  ContextAttachment,
  UserMessage,
  SessionMeta,
} from "../lib/types";
import { buildSystemPrompt, buildOnboardingPrompt, buildPortraitPrompt, type SessionInfo } from "../lib/systemPrompt";

function cleanToolResult(result: string): string {
  const idx = result.indexOf("\n\n[Reminder: Present interpretations");
  return idx >= 0 ? result.slice(0, idx) : result;
}

/**
 * Reconstruct the multi-round API conversation from a flat blocks array.
 * Each "round" is a Claude API call that produced some content + tool calls,
 * followed by tool results fed back as a user message. Round boundaries
 * are detected when a text block appears after tool_use blocks.
 */
function blocksToApiMessages(
  blocks: ContentBlock[]
): { role: string; content: unknown[] }[] {
  const result: { role: string; content: unknown[] }[] = [];
  let assistantContent: unknown[] = [];
  let toolResults: unknown[] = [];
  let hadToolUse = false;

  for (const block of blocks) {
    if (block.type === "thinking") continue;

    if (block.type === "text") {
      if (hadToolUse && toolResults.length > 0) {
        if (assistantContent.length > 0)
          result.push({ role: "assistant", content: assistantContent });
        result.push({ role: "user", content: toolResults });
        assistantContent = [];
        toolResults = [];
        hadToolUse = false;
      }
      assistantContent.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      if (block.name === "web_search") continue;
      hadToolUse = true;
      assistantContent.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
      if (block.status === "complete" || block.status === "error") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: cleanToolResult(block.result || ""),
          ...(block.isError ? { is_error: true } : {}),
        });
      }
    }
  }

  if (assistantContent.length > 0)
    result.push({ role: "assistant", content: assistantContent });
  if (toolResults.length > 0)
    result.push({ role: "user", content: toolResults });

  return result;
}

/**
 * Merge consecutive same-role messages to satisfy the Claude API constraint
 * that user/assistant messages must alternate. This happens when an assistant
 * turn ends with tool_results (user role) followed by the next user message.
 */
function mergeConsecutiveMessages(
  msgs: { role: string; content: unknown }[]
): { role: string; content: unknown }[] {
  const merged: { role: string; content: unknown }[] = [];
  for (const msg of msgs) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && prev.role === msg.role) {
      const prevArr = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text", text: prev.content }];
      const currArr = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: msg.content }];
      prev.content = [...prevArr, ...currArr];
    } else {
      merged.push({
        role: msg.role,
        content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
      });
    }
  }
  return merged;
}

export interface StreamChatOptions {
  subjectName?: string;
  onboardingStatus?: string;
  selectedSources?: string[];
  connectedSources?: string[];
  activeSessionKind?: "conversation" | "setup" | "portrait" | null;
  portraitStatus?: { status: string; phase?: string; results_summary?: string | null } | null;
}

interface SendMessageOptions {
  sessionKind?: "conversation" | "setup" | "portrait" | null;
  selectedSourcesOverride?: string[];
  context?: ContextAttachment[];
}

interface StreamContext {
  blocks: ContentBlock[];
  toolInputBuffers: Map<number, string>;
  indexMap: Map<number, number>;
  streamId: string;
  unlisten: (() => void) | null;
}

export function useStreamChat(opts: StreamChatOptions = {}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // React state: active session's messages (drives rendering)
  const [messages, setMessagesRaw] = useState<Message[]>([]);

  // React state: which sessions are currently streaming (drives sidebar indicators)
  const [streamingSessionIds, setStreamingSessionIds] = useState<Set<string>>(new Set());

  // Which session is currently displayed on screen
  const activeSessionIdRef = useRef<string | null>(null);

  // Messages cache for all sessions — single source of truth, updated synchronously
  const sessionMessagesRef = useRef<Map<string, Message[]>>(new Map());

  // Per-session streaming context (blocks, tool buffers, stream ID, unlisten)
  const streamContextsRef = useRef<Map<string, StreamContext>>(new Map());

  // Mirror of streamingSessionIds for synchronous access in callbacks
  const streamingIdsRef = useRef<Set<string>>(new Set());

  /**
   * Wrapped setMessages: reads prev from cache (always up to date),
   * updates cache, then pushes to React state. Accepts same API as
   * React's setState (value or functional updater).
   */
  const setMessages = useCallback((updaterOrValue: Message[] | ((prev: Message[]) => Message[])) => {
    const activeId = activeSessionIdRef.current;
    const prev = activeId ? (sessionMessagesRef.current.get(activeId) ?? []) : [];
    const next = typeof updaterOrValue === "function" ? updaterOrValue(prev) : updaterOrValue;
    if (activeId) {
      sessionMessagesRef.current.set(activeId, next);
    }
    setMessagesRaw(next);
  }, []);

  const getSessionMessages = useCallback((sessionId: string): Message[] => {
    return sessionMessagesRef.current.get(sessionId) ?? [];
  }, []);

  const isSessionStreaming = useCallback((sessionId: string): boolean => {
    return streamingIdsRef.current.has(sessionId);
  }, []);

  /**
   * Switch the displayed session. Loads messages from cache (or uses
   * the provided msgs) into React state. Pass null to clear.
   */
  const switchToSession = useCallback((sessionId: string | null, msgs?: Message[]) => {
    activeSessionIdRef.current = sessionId;
    if (sessionId === null) {
      setMessagesRaw(msgs ?? []);
      return;
    }
    if (msgs !== undefined) {
      sessionMessagesRef.current.set(sessionId, msgs);
      setMessagesRaw(msgs);
    } else {
      const cached = sessionMessagesRef.current.get(sessionId) ?? [];
      setMessagesRaw(cached);
    }
  }, []);

  const sendMessage = useCallback(
    async (userText: string, images?: ImageAttachment[], options?: SendMessageOptions, files?: FileAttachment[]) => {
      const targetSessionId = activeSessionIdRef.current;
      if (!targetSessionId) return;
      if (streamingIdsRef.current.has(targetSessionId)) return;

      const { subjectName, onboardingStatus, selectedSources, connectedSources, activeSessionKind, portraitStatus } = optsRef.current;

      const currentMessages = sessionMessagesRef.current.get(targetSessionId) ?? [];

      const userMsg: UserMessage = {
        role: "user",
        content: userText,
        ...(images?.length ? { images } : {}),
        ...(files?.length ? { files } : {}),
        ...(options?.context?.length ? { context: options.context } : {}),
        timestamp: Date.now(),
      };

      const assistantMsg: AssistantMessage = {
        role: "assistant",
        blocks: [],
        isStreaming: true,
        timestamp: Date.now(),
      };

      const newMessages = [...currentMessages, userMsg, assistantMsg];
      sessionMessagesRef.current.set(targetSessionId, newMessages);
      if (activeSessionIdRef.current === targetSessionId) {
        setMessagesRaw(newMessages);
      }

      const ctx: StreamContext = {
        blocks: [],
        toolInputBuffers: new Map(),
        indexMap: new Map(),
        streamId: `chat-${Date.now()}`,
        unlisten: null,
      };
      streamContextsRef.current.set(targetSessionId, ctx);

      streamingIdsRef.current.add(targetSessionId);
      setStreamingSessionIds(new Set(streamingIdsRef.current));

      const updateAssistant = (updater: (blocks: ContentBlock[]) => ContentBlock[]) => {
        ctx.blocks = updater(ctx.blocks);
        const newBlocks = [...ctx.blocks];

        const cached = sessionMessagesRef.current.get(targetSessionId);
        if (!cached) return;

        const updated = [...cached];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.role === "assistant") {
          updated[lastIdx] = {
            ...updated[lastIdx],
            blocks: newBlocks,
            isStreaming: true,
          } as AssistantMessage;
        }
        sessionMessagesRef.current.set(targetSessionId, updated);

        if (activeSessionIdRef.current === targetSessionId) {
          setMessagesRaw(updated);
        }
      };

      const resolveIndex = (claudeIdx: number): number =>
        ctx.indexMap.get(claudeIdx) ?? claudeIdx;

      const handleEvent = (payload: StreamEventPayload) => {
        const { event_type, data } = payload;

        switch (event_type) {
          case "content_block_start": {
            const claudeIdx = (data.index as number) ?? 0;
            const block = data.content_block as {
              type: string;
              text?: string;
              thinking?: string;
              id?: string;
              name?: string;
            } | undefined;
            if (!block) break;

            const targetIdx = ctx.blocks.length;
            ctx.indexMap.set(claudeIdx, targetIdx);

            if (block.type === "thinking") {
              updateAssistant((blocks) => [
                ...blocks,
                {
                  type: "thinking",
                  thinking: "",
                  isStreaming: true,
                  startTime: Date.now(),
                },
              ]);
            } else if (block.type === "text") {
              const citations = (data.content_block as Record<string, unknown>)?.citations as TextBlock["citations"] | undefined;
              updateAssistant((blocks) => [
                ...blocks,
                { type: "text", text: "", isStreaming: true, ...(citations ? { citations } : {}) },
              ]);
            } else if (block.type === "tool_use" || block.type === "server_tool_use") {
              updateAssistant((blocks) => [
                ...blocks,
                {
                  type: "tool_use",
                  id: block.id || "",
                  name: block.name || "",
                  input: {},
                  inputJson: "",
                  status: "running",
                },
              ]);
              ctx.toolInputBuffers.set(targetIdx, "");
            } else if (block.type === "web_search_tool_result") {
              const toolUseId = (data.content_block as Record<string, unknown>)?.tool_use_id as string;
              const searchContent = (data.content_block as Record<string, unknown>)?.content as WebSearchResult[] | undefined;
              if (toolUseId) {
                updateAssistant((blocks) =>
                  blocks.map((b) =>
                    b.type === "tool_use" && b.id === toolUseId
                      ? { ...b, status: "complete" as const, searchResults: searchContent || [] }
                      : b
                  ) as ContentBlock[]
                );
              }
            }
            break;
          }

          case "text_delta": {
            const idx = resolveIndex((data.index as number) ?? 0);
            updateAssistant((blocks) =>
              blocks.map((b, i) =>
                i === idx && b.type === "text"
                  ? { ...b, text: b.text + ((data.text as string) || "") }
                  : b
              )
            );
            break;
          }

          case "thinking_delta": {
            const idx = resolveIndex((data.index as number) ?? 0);
            updateAssistant((blocks) =>
              blocks.map((b, i) =>
                i === idx && b.type === "thinking"
                  ? {
                      ...b,
                      thinking: b.thinking + ((data.thinking as string) || ""),
                    }
                  : b
              )
            );
            break;
          }

          case "tool_input_delta": {
            const idx = resolveIndex((data.index as number) ?? 0);
            const current = ctx.toolInputBuffers.get(idx) || "";
            ctx.toolInputBuffers.set(
              idx,
              current + ((data.partial_json as string) || "")
            );
            break;
          }

          case "content_block_stop": {
            const idx = resolveIndex((data.index as number) ?? 0);
            updateAssistant((blocks) =>
              blocks.map((b, i) => {
                if (i !== idx) return b;
                if (b.type === "thinking") {
                  return {
                    ...b,
                    isStreaming: false,
                    endTime: Date.now(),
                  };
                }
                if (b.type === "text") {
                  const blockData = data.content_block as Record<string, unknown> | undefined;
                  const citations = blockData?.citations as TextBlock["citations"] | undefined;
                  return { ...b, isStreaming: false, ...(citations ? { citations } : {}) };
                }
                if (b.type === "tool_use") {
                  const jsonStr = ctx.toolInputBuffers.get(idx) || "{}";
                  let input = {};
                  try {
                    input = JSON.parse(jsonStr);
                  } catch {
                    // keep empty
                  }
                  return { ...b, input, inputJson: jsonStr };
                }
                return b;
              })
            );
            break;
          }

          case "tool_result": {
            const toolId = data.tool_use_id as string;
            updateAssistant((blocks) =>
              blocks.map((b) =>
                b.type === "tool_use" && b.id === toolId
                  ? {
                      ...b,
                      status: (data.is_error ? "error" : "complete") as "error" | "complete",
                      result: (data.content as string) || "",
                      isError: (data.is_error as boolean) || false,
                    }
                  : b
              ) as ContentBlock[]
            );
            break;
          }

          case "error": {
            const errMsg = (data.error as string) || "Unknown error";
            updateAssistant((blocks) => [
              ...blocks,
              {
                type: "text" as const,
                text: `\n\n**Error:** ${errMsg}`,
                isStreaming: false,
              },
            ]);
            break;
          }

          case "message_stop": {
            const cached = sessionMessagesRef.current.get(targetSessionId);
            if (cached) {
              const updated = [...cached];
              const lastIdx = updated.length - 1;
              if (updated[lastIdx]?.role === "assistant") {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  isStreaming: false,
                } as AssistantMessage;
              }
              sessionMessagesRef.current.set(targetSessionId, updated);

              if (activeSessionIdRef.current === targetSessionId) {
                setMessagesRaw(updated);
              }
            }

            streamingIdsRef.current.delete(targetSessionId);
            setStreamingSessionIds(new Set(streamingIdsRef.current));

            if (ctx.unlisten) {
              ctx.unlisten();
              ctx.unlisten = null;
            }
            streamContextsRef.current.delete(targetSessionId);
            break;
          }
        }
      };

      const contextCache = new Map<string, string>();
      const allMessages = [...currentMessages, userMsg].filter((m) => m.role !== "system");
      for (const m of allMessages) {
        if (m.role === "user") {
          const um = m as UserMessage;
          if (um.context) {
            for (const ctx of um.context) {
              if (ctx.type === "session" && !contextCache.has(ctx.id)) {
                try {
                  const result = await invokeCommand<{ session: unknown; summary: string | null }>(
                    "load_session", { sessionId: ctx.id }
                  );
                  contextCache.set(ctx.id, result.summary || "(No summary available)");
                } catch {
                  contextCache.set(ctx.id, "(Failed to load session)");
                }
              }
            }
          }
        }
      }

      const rawApiMessages: { role: string; content: unknown }[] = [];
      for (const m of allMessages) {
        if (m.role === "user") {
          const um = m as UserMessage;
          const hasImages = !!um.images?.length;
          const hasFiles = !!um.files?.length;
          const hasContext = !!um.context?.length;
          if (hasImages || hasFiles || hasContext) {
            const parts: unknown[] = [];
            if (um.context) {
              for (const c of um.context) {
                const content = contextCache.get(c.id) || "(No content)";
                parts.push({
                  type: "text",
                  text: `[Context from previous session "${c.name}":\n\n${content}]`,
                });
              }
            }
            if (um.images) {
              for (const img of um.images) {
                parts.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.mediaType,
                    data: img.data,
                  },
                });
              }
            }
            if (um.files) {
              for (const f of um.files) {
                const label = f.type === "folder" ? "Attached folder" : "Attached file";
                parts.push({ type: "text", text: `[${label}: ${f.path}]` });
              }
            }
            if (um.content) parts.push({ type: "text", text: um.content });
            rawApiMessages.push({ role: "user", content: parts });
          } else {
            rawApiMessages.push({ role: "user", content: um.content });
          }
        } else {
          const am = m as AssistantMessage;
          rawApiMessages.push(...blocksToApiMessages(am.blocks));
        }
      }

      const apiMessages = mergeConsecutiveMessages(rawApiMessages);

      try {
        const effectiveSessionKind = options?.sessionKind ?? activeSessionKind;
        const effectiveSelectedSources =
          options?.selectedSourcesOverride ?? selectedSources ?? [];
        const shouldUseOnboardingPrompt =
          onboardingStatus === "pending" &&
          effectiveSelectedSources.length > 0 &&
          effectiveSessionKind === "setup";
        const shouldUsePortraitPrompt = effectiveSessionKind === "portrait";

        let previousSessions: SessionInfo[] | undefined;
        if (!shouldUseOnboardingPrompt && !shouldUsePortraitPrompt) {
          try {
            const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
            previousSessions = manifest.map(s => ({
              id: s.id,
              name: s.name,
              createdAt: s.createdAt,
              status: s.status,
              kind: s.kind,
              summaryFile: s.summaryFile,
            }));
          } catch { /* best effort */ }
        }

        let systemPrompt: string;
        if (shouldUsePortraitPrompt) {
          const psForPrompt = portraitStatus && (portraitStatus.status === "running" || portraitStatus.status === "completed" || portraitStatus.status === "failed" || portraitStatus.status === "cancelled" || portraitStatus.status === "interrupted")
            ? { status: portraitStatus.status as "running" | "completed" | "failed" | "cancelled" | "interrupted", phase: portraitStatus.phase, results_summary: portraitStatus.results_summary }
            : null;
          systemPrompt = buildPortraitPrompt(
            subjectName || "User",
            connectedSources?.length ? connectedSources : effectiveSelectedSources,
            psForPrompt
          );
        } else if (shouldUseOnboardingPrompt) {
          systemPrompt = buildOnboardingPrompt(subjectName || "User", effectiveSelectedSources);
        } else {
          const hasPortraitData = portraitStatus?.status === "completed";
          systemPrompt = buildSystemPrompt(subjectName || "User", targetSessionId, {
            portraitStatus: portraitStatus ? {
              status: portraitStatus.status as "running" | "completed" | "failed" | "cancelled" | "interrupted",
              phase: portraitStatus.phase,
              results_summary: portraitStatus.results_summary,
            } : null,
            connectedSources: connectedSources?.length ? connectedSources : effectiveSelectedSources,
            hasPortraitData,
            previousSessions,
          });
        }

        ctx.unlisten = await streamChat(
          {
            messages: apiMessages,
            systemPrompt,
            tools: [],
            streamId: ctx.streamId,
          },
          handleEvent
        );
      } catch (err) {
        const errorText =
          err instanceof Error ? err.message : String(err);
        updateAssistant((blocks) => [
          ...blocks,
          {
            type: "text",
            text: `\n\n**Error:** ${errorText}`,
            isStreaming: false,
          },
        ]);
        streamingIdsRef.current.delete(targetSessionId);
        setStreamingSessionIds(new Set(streamingIdsRef.current));
        streamContextsRef.current.delete(targetSessionId);
      }
    },
    // All data read from refs — no closure dependencies needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const stopStreaming = useCallback((sessionId?: string) => {
    const targetId = sessionId ?? activeSessionIdRef.current;
    if (!targetId) return;
    if (!streamingIdsRef.current.has(targetId)) return;

    const ctx = streamContextsRef.current.get(targetId);
    if (!ctx) return;

    stopChat(ctx.streamId);

    if (ctx.unlisten) {
      ctx.unlisten();
      ctx.unlisten = null;
    }

    const cached = sessionMessagesRef.current.get(targetId);
    if (cached) {
      const updated = [...cached];
      const lastIdx = updated.length - 1;
      if (updated[lastIdx]?.role === "assistant") {
        const am = updated[lastIdx] as AssistantMessage;
        updated[lastIdx] = {
          ...am,
          isStreaming: false,
          blocks: am.blocks.map((b) => {
            if (b.type === "thinking" && b.isStreaming) {
              return { ...b, isStreaming: false, endTime: Date.now() };
            }
            if (b.type === "text" && b.isStreaming) {
              return { ...b, isStreaming: false };
            }
            if (b.type === "tool_use" && b.status === "running") {
              return { ...b, status: "error" as const, result: "Stopped by user" };
            }
            return b;
          }),
        } as AssistantMessage;
      }
      sessionMessagesRef.current.set(targetId, updated);

      if (activeSessionIdRef.current === targetId) {
        setMessagesRaw(updated);
      }
    }

    streamingIdsRef.current.delete(targetId);
    setStreamingSessionIds(new Set(streamingIdsRef.current));
    streamContextsRef.current.delete(targetId);
  }, []);

  const clearMessages = useCallback(() => {
    const activeId = activeSessionIdRef.current;
    if (activeId) {
      sessionMessagesRef.current.set(activeId, []);
    }
    setMessagesRaw([]);
  }, []);

  return {
    messages,
    streamingSessionIds,
    sendMessage,
    stopStreaming,
    clearMessages,
    setMessages,
    switchToSession,
    getSessionMessages,
    isSessionStreaming,
  };
}

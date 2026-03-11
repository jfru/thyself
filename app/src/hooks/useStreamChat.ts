import { useState, useCallback, useRef } from "react";
import { streamChat, stopChat, type StreamEventPayload } from "../lib/tauriBridge";
import type {
  Message,
  AssistantMessage,
  ContentBlock,
  TextBlock,
  WebSearchResult,
  ImageAttachment,
  UserMessage,
} from "../lib/types";
import { buildSystemPrompt, buildOnboardingPrompt } from "../lib/systemPrompt";

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
  activeSessionKind?: "conversation" | "setup" | null;
}

interface SendMessageOptions {
  sessionKind?: "conversation" | "setup" | null;
  selectedSourcesOverride?: string[];
}

export function useStreamChat(sessionIdRef: React.RefObject<string | null>, opts: StreamChatOptions = {}) {
  const { subjectName, onboardingStatus, selectedSources, activeSessionKind } = opts;
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const blocksRef = useRef<ContentBlock[]>([]);
  const toolInputBuffers = useRef<Map<number, string>>(new Map());
  const indexMapRef = useRef<Map<number, number>>(new Map());

  const sendMessage = useCallback(
    async (userText: string, images?: ImageAttachment[], options?: SendMessageOptions) => {
      if (isStreaming) return;

      const userMsg: UserMessage = {
        role: "user",
        content: userText,
        ...(images?.length ? { images } : {}),
        timestamp: Date.now(),
      };

      const assistantMsg: AssistantMessage = {
        role: "assistant",
        blocks: [],
        isStreaming: true,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      blocksRef.current = [];
      toolInputBuffers.current.clear();
      indexMapRef.current.clear();

      const streamId = `chat-${Date.now()}`;
      streamIdRef.current = streamId;

      const updateAssistant = (updater: (blocks: ContentBlock[]) => ContentBlock[]) => {
        blocksRef.current = updater(blocksRef.current);
        const newBlocks = [...blocksRef.current];
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.role === "assistant") {
            updated[lastIdx] = {
              ...updated[lastIdx],
              blocks: newBlocks,
              isStreaming: true,
            } as AssistantMessage;
          }
          return updated;
        });
      };

      const resolveIndex = (claudeIdx: number): number =>
        indexMapRef.current.get(claudeIdx) ?? claudeIdx;

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

            // Record where this Claude index maps to in our blocks array
            const targetIdx = blocksRef.current.length;
            indexMapRef.current.set(claudeIdx, targetIdx);

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
              toolInputBuffers.current.set(targetIdx, "");
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
            const current = toolInputBuffers.current.get(idx) || "";
            toolInputBuffers.current.set(
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
                  const jsonStr = toolInputBuffers.current.get(idx) || "{}";
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
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (updated[lastIdx]?.role === "assistant") {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  isStreaming: false,
                } as AssistantMessage;
              }
              return updated;
            });
            setIsStreaming(false);
            if (unlistenRef.current) {
              unlistenRef.current();
              unlistenRef.current = null;
            }
            break;
          }
        }
      };

      const rawApiMessages: { role: string; content: unknown }[] = [];
      for (const m of [...messages, userMsg].filter((m) => m.role !== "system")) {
        if (m.role === "user") {
          const um = m as UserMessage;
          if (um.images?.length) {
            const parts: unknown[] = um.images.map((img) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mediaType,
                data: img.data,
              },
            }));
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
        const systemPrompt = shouldUseOnboardingPrompt
          ? buildOnboardingPrompt(subjectName || "User", effectiveSelectedSources)
          : buildSystemPrompt(subjectName || "User", sessionIdRef.current ?? undefined);

        // #region agent log
        fetch('http://127.0.0.1:7709/ingest/d9149a58-da3e-4f10-b872-bd18ccc36ca6',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'2ee486'},body:JSON.stringify({sessionId:'2ee486',location:'useStreamChat.ts:278',message:'system prompt selected',data:{isOnboarding: shouldUseOnboardingPrompt, onboardingStatus, selectedSources, activeSessionKind: effectiveSessionKind, promptStart: systemPrompt.substring(0, 80)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion

        unlistenRef.current = await streamChat(
          {
            messages: apiMessages,
            systemPrompt,
            tools: [],
            streamId,
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
        setIsStreaming(false);
      }
    },
    [messages, isStreaming, onboardingStatus, selectedSources, subjectName, activeSessionKind]
  );

  const stopStreaming = useCallback(() => {
    if (!isStreaming) return;

    if (streamIdRef.current) {
      stopChat(streamIdRef.current);
    }

    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    setMessages((prev) => {
      const updated = [...prev];
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
      return updated;
    });

    setIsStreaming(false);
    streamIdRef.current = null;
  }, [isStreaming]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, isStreaming, sendMessage, stopStreaming, clearMessages, setMessages };
}

import { useState, useCallback, useRef } from "react";
import { streamChat, stopChat, type StreamEventPayload } from "../lib/tauriBridge";
import type {
  Message,
  AssistantMessage,
  ContentBlock,
  TextBlock,
  WebSearchResult,
} from "../lib/types";
import { buildSystemPrompt } from "../lib/systemPrompt";

export function useStreamChat(sessionIdRef: React.RefObject<string | null>, subjectName?: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const blocksRef = useRef<ContentBlock[]>([]);
  const toolInputBuffers = useRef<Map<number, string>>(new Map());
  const indexMapRef = useRef<Map<number, number>>(new Map());

  const sendMessage = useCallback(
    async (userText: string) => {
      if (isStreaming) return;

      const userMsg: Message = {
        role: "user",
        content: userText,
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

      // Build messages array for the API
      const apiMessages = [...messages, userMsg].map((m) => {
        if (m.role === "user") {
          return { role: "user", content: m.content };
        }
        const am = m as AssistantMessage;
        const content = am.blocks
          .filter((b) => b.type === "text")
          .map((b) => ({
            type: "text",
            text: (b as { text: string }).text,
          }));
        return { role: "assistant", content };
      });

      try {
        unlistenRef.current = await streamChat(
          {
            messages: apiMessages,
            systemPrompt: buildSystemPrompt(subjectName || "User", sessionIdRef.current ?? undefined),
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
    [messages, isStreaming]
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

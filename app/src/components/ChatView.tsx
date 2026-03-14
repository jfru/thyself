import { useState, useEffect, useCallback } from "react";
import { MessageList } from "./MessageList";
import { InputBox } from "./InputBox";
import { SessionSummaryBlock } from "./SessionSummaryBlock";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import { SetupSourcesStatusPanel } from "./SetupSourcesStatusPanel";
import { PortraitBuildPanel } from "./PortraitBuildPanel";
import type { PortraitRunStatus } from "./PortraitBuildPanel";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { Message, ImageAttachment, FileAttachment, ContextAttachment } from "../lib/types";
import { isTauri, invokeCommand } from "../lib/tauriBridge";
import { ArrowDown, Trash2 } from "lucide-react";

interface ChatViewProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (text: string, images?: ImageAttachment[], options?: { selectedSourcesOverride?: string[]; context?: ContextAttachment[] }, files?: FileAttachment[]) => void;
  onStop: () => void;
  onClear?: () => void;
  sessionSummary?: string | null;
  sessionName?: string | null;
  isReadOnly?: boolean;
  activeSessionKind?: "conversation" | "setup" | "portrait" | null;
  selectedSources?: string[];
  connectedSources?: string[];
  onAddSource?: (sourceId: string) => void | Promise<void | string[]>;
  onRequestSourceSetup?: (
    sourceId: string,
    selectedSourcesOverride?: string[]
  ) => void | Promise<void>;
  onRemoveSource?: (sourceId: string) => void | Promise<void>;
  portraitStatus?: PortraitRunStatus | null;
  onPortraitRefresh?: () => void;
}

export function ChatView({
  messages,
  isStreaming,
  onSend,
  onStop,
  onClear,
  sessionSummary,
  sessionName,
  isReadOnly,
  activeSessionKind,
  selectedSources = [],
  connectedSources,
  onAddSource,
  onRequestSourceSetup,
  onRemoveSource,
  portraitStatus,
  onPortraitRefresh,
}: ChatViewProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useAutoScroll([
    messages,
  ]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (cancelled) return;
      const appWindow = getCurrentWindow();

      unlisten = await appWindow.onDragDropEvent(async (event) => {
        if (event.payload.type === "enter") {
          setIsDraggingOver(true);
        } else if (event.payload.type === "leave") {
          setIsDraggingOver(false);
        } else if (event.payload.type === "drop") {
          setIsDraggingOver(false);
          const paths = (event.payload as { type: "drop"; paths: string[] }).paths;
          if (!paths?.length) return;

          try {
            const result = await invokeCommand<{
              images: ImageAttachment[];
              files: Array<{ type: "file" | "folder"; path: string; name: string }>;
            }>("read_dropped_files", { paths });

            if (result.images.length) {
              setPendingImages((prev) => [...prev, ...result.images]);
            }
            if (result.files.length) {
              setPendingFiles((prev) => [...prev, ...result.files]);
            }
          } catch (err) {
            console.error("Failed to process dropped files:", err);
          }
        }
      });

      if (cancelled) { unlisten(); unlisten = undefined; }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const ACTION_MAP: Record<string, string> = {
      build_portrait: "__OPEN_PORTRAIT__",
    };
    const handler = (e: Event) => {
      const action = (e as CustomEvent).detail as string;
      const mapped = ACTION_MAP[action];
      if (mapped) onSend(mapped);
    };
    window.addEventListener("thyself-action", handler);
    return () => window.removeEventListener("thyself-action", handler);
  }, [onSend]);

  const handleConsumeDroppedImages = useCallback((imgs: ImageAttachment[]) => {
    setPendingImages([]);
    return imgs;
  }, []);

  const handleConsumeDroppedFiles = useCallback((files: FileAttachment[]) => {
    setPendingFiles([]);
    return files;
  }, []);

  const showClearButton = onClear && messages.length > 0 && !isReadOnly;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-2 pb-1 border-b border-zinc-800/50 bg-zinc-950">
        <SyncStatusIndicator />
        <div className="flex items-center gap-2">
          {showClearButton && (
            <>
              {showClearConfirm ? (
                <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 shadow-lg">
                  <span className="text-xs text-zinc-400">Clear this session?</span>
                  <button
                    onClick={() => { onClear(); setShowClearConfirm(false); }}
                    className="text-xs text-red-400 hover:text-red-300 font-medium px-2 py-0.5 rounded hover:bg-red-400/10 transition-colors"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setShowClearConfirm(false)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-400 px-2.5 py-1 rounded-lg hover:bg-zinc-800/50 border border-transparent hover:border-zinc-800 transition-colors"
                >
                  <Trash2 size={12} />
                  <span>Clear all</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {sessionSummary && sessionName && (
        <SessionSummaryBlock summary={sessionSummary} sessionName={sessionName} />
      )}
      {activeSessionKind === "setup" && (
        <SetupSourcesStatusPanel
          selectedSources={selectedSources}
          connectedSources={connectedSources}
          onAddSource={onAddSource}
          onRequestSourceSetup={onRequestSourceSetup}
          onRemoveSource={onRemoveSource}
        />
      )}
      {activeSessionKind === "portrait" && (
        <PortraitBuildPanel
          portraitStatus={portraitStatus ?? null}
          onRefresh={onPortraitRefresh ?? (() => {})}
        />
      )}
      <div ref={containerRef} className="flex-1 overflow-y-auto relative">
        <MessageList messages={messages} isStreaming={isStreaming} onAction={onSend} />
      </div>
      {!isAtBottom && messages.length > 0 && (
        <div className="flex justify-center -mt-12 relative z-10">
          <button
            onClick={scrollToBottom}
            className="rounded-full bg-zinc-800 border border-zinc-700 p-2 shadow-lg hover:bg-zinc-700 transition-colors"
          >
            <ArrowDown size={16} className="text-zinc-300" />
          </button>
        </div>
      )}
      {isReadOnly ? (
        <div className="border-t border-zinc-800 px-4 py-3 text-center text-xs text-zinc-600">
          This session has ended. Start a new session to continue chatting.
        </div>
      ) : (
        <InputBox
          onSend={onSend}
          onStop={onStop}
          isStreaming={isStreaming}
          pendingDroppedImages={pendingImages}
          onConsumeDroppedImages={handleConsumeDroppedImages}
          pendingDroppedFiles={pendingFiles}
          onConsumeDroppedFiles={handleConsumeDroppedFiles}
          isTauriDragging={isDraggingOver}
          placeholder={activeSessionKind === "setup" ? "Message thyself..." : undefined}
        />
      )}
    </div>
  );
}

import { useState } from "react";
import { MessageList } from "./MessageList";
import { InputBox } from "./InputBox";
import { SessionSummaryBlock } from "./SessionSummaryBlock";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { Message } from "../lib/types";
import { ArrowDown, Trash2 } from "lucide-react";

interface ChatViewProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onClear?: () => void;
  sessionSummary?: string | null;
  sessionName?: string | null;
  isReadOnly?: boolean;
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
}: ChatViewProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useAutoScroll([
    messages,
  ]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const showClearButton = onClear && messages.length > 0 && !isReadOnly;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div ref={containerRef} className="flex-1 overflow-y-auto relative">
        <div className="sticky top-0 z-20 flex items-center justify-between px-4 pt-2 pb-1 bg-zinc-950">
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
        <MessageList messages={messages} />
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
        <InputBox onSend={onSend} onStop={onStop} isStreaming={isStreaming} />
      )}
    </div>
  );
}

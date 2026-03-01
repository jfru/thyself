import { MessageList } from "./MessageList";
import { InputBox } from "./InputBox";
import { SessionSummaryBlock } from "./SessionSummaryBlock";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type { Message } from "../lib/types";
import { ArrowDown } from "lucide-react";

interface ChatViewProps {
  messages: Message[];
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  sessionSummary?: string | null;
  sessionName?: string | null;
  isReadOnly?: boolean;
}

export function ChatView({
  messages,
  isStreaming,
  onSend,
  onStop,
  sessionSummary,
  sessionName,
  isReadOnly,
}: ChatViewProps) {
  const { containerRef, isAtBottom, scrollToBottom } = useAutoScroll([
    messages,
  ]);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div ref={containerRef} className="flex-1 overflow-y-auto relative">
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

import type {
  Message,
  UserMessage as UserMessageType,
  AssistantMessage,
  SystemMessage,
} from "../lib/types";
import { UserMessage } from "./UserMessage";
import { AgentResponse } from "./AgentResponse";

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  onAction?: (message: string) => void;
}

function SystemMessageBubble({
  message,
  showButton,
  onAction,
}: {
  message: SystemMessage;
  showButton: boolean;
  onAction?: (msg: string) => void;
}) {
  const hasActions = showButton && (message.action || message.secondaryAction);
  return (
    <div className="flex justify-center py-6">
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl px-5 py-4 max-w-sm text-center">
        <p className="text-sm text-zinc-300">{message.text}</p>
        {hasActions && (
          <div className="mt-3 flex flex-col items-center gap-2">
            {message.action && (
              <button
                onClick={() => onAction?.(message.action!.message)}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {message.action.label}
              </button>
            )}
            {message.secondaryAction && (
              <button
                onClick={() => onAction?.(message.secondaryAction!.message)}
                className="px-4 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {message.secondaryAction.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageList({ messages, isStreaming, onAction }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center pt-32">
        <div className="text-center space-y-3 max-w-md">
          <div className="text-4xl">🪞</div>
          <h2 className="text-xl font-medium text-zinc-200">thyself</h2>
          <p className="text-sm text-zinc-500 leading-relaxed">
            An AI that knows your life. Ask about your patterns, relationships,
            growth — anything from your personal history.
          </p>
        </div>
      </div>
    );
  }

  const lastSystemIdx = messages.reduce(
    (acc, msg, i) => (msg.role === "system" ? i : acc),
    -1
  );

  return (
    <div className="pt-4 pb-6">
      {messages.map((msg, i) => {
        if (msg.role === "system") {
          const isLastSystem = i === lastSystemIdx;
          const hasMessagesAfter = i < messages.length - 1;
          const showButton = isLastSystem && !hasMessagesAfter && !isStreaming;
          return (
            <SystemMessageBubble
              key={`msg-${i}`}
              message={msg}
              showButton={showButton}
              onAction={onAction}
            />
          );
        }

        if (msg.role === "user") {
          const um = msg as UserMessageType;
          return (
            <UserMessage
              key={`msg-${i}`}
              content={um.content}
              images={um.images}
              files={um.files}
              timestamp={um.timestamp}
            />
          );
        }

        return (
          <div key={`msg-${i}`} className="px-4 py-4 max-w-3xl mx-auto">
            <AgentResponse message={msg as AssistantMessage} />
          </div>
        );
      })}
    </div>
  );
}

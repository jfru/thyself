import { useState, type ReactElement } from "react";
import { Info } from "lucide-react";
import type {
  Message,
  UserMessage as UserMessageType,
  AssistantMessage,
  SystemMessage,
  ImageAttachment,
  FileAttachment,
} from "../lib/types";
import { UserMessage } from "./UserMessage";
import { AgentResponse } from "./AgentResponse";

type EditDropResult = { images: ImageAttachment[]; files: Array<{ type: "file" | "folder"; path: string; name: string }> };

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  onAction?: (message: string) => void;
  onEditMessage?: (index: number, newContent: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  isReadOnly?: boolean;
  registerEditDropTarget?: (cb: (result: EditDropResult) => void) => void;
  unregisterEditDropTarget?: () => void;
  isTauriDragging?: boolean;
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
  const [showLearnMore, setShowLearnMore] = useState(false);
  const hasActions = showButton && (message.action || message.secondaryAction);
  return (
    <div className="flex justify-center py-6">
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl px-5 py-4 max-w-sm text-center">
        <p className="text-sm text-zinc-300 text-balance">{message.text}</p>
        {message.subtitle && (
          <p className="mt-2 text-xs text-zinc-500 leading-relaxed text-balance">
            {message.subtitle}
            {message.learnMore && (
              <button
                onClick={() => setShowLearnMore((v) => !v)}
                className="inline-flex items-center ml-1 text-zinc-500 hover:text-zinc-300 transition-colors align-middle"
                aria-label="Learn more about data privacy"
              >
                <Info size={12} />
              </button>
            )}
          </p>
        )}
        {showLearnMore && message.learnMore && (
          <p className="mt-1.5 text-xs text-zinc-600 leading-relaxed text-balance">
            {message.learnMore}
          </p>
        )}
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

export function MessageList({ messages, isStreaming, onAction, onEditMessage, isReadOnly, registerEditDropTarget, unregisterEditDropTarget, isTauriDragging }: MessageListProps) {
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

  const lastSystemMsg = lastSystemIdx >= 0 ? messages[lastSystemIdx] as SystemMessage : null;
  const hasMessagesAfterLastSystem = lastSystemIdx >= 0 && lastSystemIdx < messages.length - 1;
  const floatCtaToBottom = hasMessagesAfterLastSystem && !isReadOnly;

  // Group messages into "turns": each turn starts with a user message and includes
  // all following assistant messages until the next user or system message.
  // Wrapping each turn in a container div makes CSS sticky work correctly:
  // the user bubble sticks at the top of the viewport but is constrained within
  // its turn container, so the next turn's user bubble naturally pushes it off.
  const sections: ReactElement[] = [];
  let turnChildren: ReactElement[] = [];
  let turnKey = "";

  function flushTurn() {
    if (turnChildren.length > 0) {
      sections.push(<div key={turnKey}>{turnChildren}</div>);
      turnChildren = [];
      turnKey = "";
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      flushTurn();
      if (i === lastSystemIdx && floatCtaToBottom) continue;
      const isLastSystem = i === lastSystemIdx;
      const hasMessagesAfter = i < messages.length - 1;
      const showButton = isLastSystem && !hasMessagesAfter && !isStreaming && !isReadOnly;
      sections.push(
        <SystemMessageBubble
          key={`msg-${i}`}
          message={msg}
          showButton={showButton}
          onAction={onAction}
        />
      );
    } else if (msg.role === "user") {
      flushTurn();
      turnKey = `turn-${i}`;
      const um = msg as UserMessageType;
      turnChildren.push(
        <UserMessage
          key={`msg-${i}`}
          content={um.content}
          images={um.images}
          files={um.files}
          context={um.context}
          timestamp={um.timestamp}
          isEditable={!isReadOnly}
          onEdit={onEditMessage ? (newContent, images, files) => onEditMessage(i, newContent, images, files) : undefined}
          registerEditDropTarget={registerEditDropTarget}
          unregisterEditDropTarget={unregisterEditDropTarget}
          isTauriDragging={isTauriDragging}
        />
      );
    } else {
      // Assistant message — include in the current turn if one is open
      const el = (
        <div key={`msg-${i}`} className="px-4 py-4 max-w-3xl mx-auto">
          <AgentResponse message={msg as AssistantMessage} />
        </div>
      );
      if (turnChildren.length > 0) {
        turnChildren.push(el);
      } else {
        sections.push(el);
      }
    }
  }
  flushTurn();

  return (
    <div className="pt-4 pb-6">
      {sections}
      {lastSystemMsg && floatCtaToBottom && (
        <SystemMessageBubble
          key={`msg-${lastSystemIdx}-bottom`}
          message={lastSystemMsg}
          showButton={!isStreaming}
          onAction={onAction}
        />
      )}
    </div>
  );
}

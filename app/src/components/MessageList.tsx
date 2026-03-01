import type { Message, AssistantMessage } from "../lib/types";
import { UserMessage } from "./UserMessage";
import { AgentResponse } from "./AgentResponse";

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
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

  const turns: { user: Message; responses: AssistantMessage[] }[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      turns.push({ user: msg, responses: [] });
    } else if (turns.length > 0) {
      turns[turns.length - 1].responses.push(msg as AssistantMessage);
    }
  }

  return (
    <div className="pb-6">
      {turns.map((turn, i) => (
        <div key={i}>
          <UserMessage
            content={turn.user.content}
            timestamp={turn.user.timestamp}
          />
          {turn.responses.map((resp, j) => (
            <div key={j} className="px-4 py-4 max-w-3xl mx-auto">
              <AgentResponse message={resp} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

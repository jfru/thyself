import type { AssistantMessage } from "../lib/types";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolUseBlock } from "./ToolUseBlock";
import { StreamingText } from "./StreamingText";
import { Loader2 } from "lucide-react";

interface AgentResponseProps {
  message: AssistantMessage;
}

export function AgentResponse({ message }: AgentResponseProps) {
  const lastBlock = message.blocks[message.blocks.length - 1];
  const showProcessing =
    message.isStreaming &&
    lastBlock?.type === "tool_use" &&
    lastBlock.status === "complete";

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1">
        {message.blocks.map((block, i) => {
          switch (block.type) {
            case "thinking":
              return <ThinkingBlock key={i} block={block} />;
            case "tool_use":
              return <ToolUseBlock key={i} block={block} />;
            case "text":
              return <StreamingText key={i} block={block} />;
            default:
              return null;
          }
        })}
        {showProcessing && (
          <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            <span>Processing...</span>
          </div>
        )}
      </div>
    </div>
  );
}

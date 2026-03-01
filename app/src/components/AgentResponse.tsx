import { useState } from "react";
import type {
  AssistantMessage,
  ContentBlock,
  ToolUseBlock as ToolUseBlockType,
} from "../lib/types";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolUseBlock } from "./ToolUseBlock";
import { StreamingText } from "./StreamingText";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
} from "lucide-react";

interface AgentResponseProps {
  message: AssistantMessage;
}

function ToolCallSummary({ tools, isStreaming }: { tools: ToolUseBlockType[]; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const runningTool = tools.find((t) => t.status === "running");
  const completedTools = tools.filter((t) => t.status !== "running");

  if (tools.length === 1 && runningTool) {
    return <ToolUseBlock block={runningTool} />;
  }

  return (
    <div className="my-1 space-y-1">
      {completedTools.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group"
          >
            <Wrench size={13} className="text-zinc-500" />
            <span>
              {completedTools.length === 1
                ? "1 tool call"
                : `${completedTools.length} tool calls`}
            </span>
            {expanded ? (
              <ChevronDown size={12} className="text-zinc-600 group-hover:text-zinc-400" />
            ) : (
              <ChevronRight size={12} className="text-zinc-600 group-hover:text-zinc-400" />
            )}
          </button>
          {expanded && (
            <div className="mt-1 ml-1 space-y-0.5">
              {completedTools.map((block, i) => (
                <ToolUseBlock key={block.id || i} block={block} />
              ))}
            </div>
          )}
        </div>
      )}
      {runningTool && <ToolUseBlock block={runningTool} />}
    </div>
  );
}

export function AgentResponse({ message }: AgentResponseProps) {
  const { blocks, isStreaming } = message;

  const lastBlock = blocks[blocks.length - 1];
  const showProcessing =
    isStreaming &&
    lastBlock?.type === "tool_use" &&
    lastBlock.status === "complete";

  const allTools: ToolUseBlockType[] = [];
  let hasTools = false;

  for (const block of blocks) {
    if (block.type === "tool_use") {
      allTools.push(block);
      hasTools = true;
    }
  }

  const lastToolIndex = blocks.reduce(
    (acc, b, i) => (b.type === "tool_use" ? i : acc),
    -1
  );

  if (!hasTools) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] space-y-1">
          {blocks.map((block, i) => {
            if (block.type === "thinking") return <ThinkingBlock key={i} block={block} />;
            if (block.type === "text") return <StreamingText key={i} block={block} />;
            return null;
          })}
        </div>
      </div>
    );
  }

  const leadingBlocks: ContentBlock[] = [];
  const trailingBlocks: ContentBlock[] = [];

  const firstToolIdx = blocks.findIndex((b) => b.type === "tool_use");
  for (let i = 0; i < firstToolIdx; i++) {
    leadingBlocks.push(blocks[i]);
  }

  for (let i = lastToolIndex + 1; i < blocks.length; i++) {
    trailingBlocks.push(blocks[i]);
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1">
        {leadingBlocks.map((block, i) => {
          if (block.type === "thinking") return <ThinkingBlock key={`lead-${i}`} block={block} />;
          if (block.type === "text") return <StreamingText key={`lead-${i}`} block={block} />;
          return null;
        })}

        <ToolCallSummary tools={allTools} isStreaming={isStreaming} />

        {showProcessing && (
          <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            <span>Processing...</span>
          </div>
        )}

        {trailingBlocks.map((block, i) => {
          if (block.type === "thinking") return <ThinkingBlock key={`trail-${i}`} block={block} />;
          if (block.type === "text") return <StreamingText key={`trail-${i}`} block={block} />;
          return null;
        })}
      </div>
    </div>
  );
}

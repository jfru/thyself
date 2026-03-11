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

function ToolCallSummary({ tools, isStreaming: _isStreaming }: { tools: ToolUseBlockType[]; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const runningTool = tools.find((t) => t.status === "running");
  const completedTools = tools.filter((t) => t.status !== "running");

  if (tools.length === 1 && runningTool) {
    return <ToolUseBlock block={runningTool} />;
  }

  const totalCount = completedTools.length + (runningTool ? 1 : 0);

  return (
    <div className="my-1 space-y-1">
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group"
        >
          {runningTool ? (
            <Loader2 size={13} className="animate-spin text-zinc-500" />
          ) : (
            <Wrench size={13} className="text-zinc-500" />
          )}
          <span>
            {totalCount === 1 ? "1 tool call" : `${totalCount} tool calls`}
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
            {runningTool && <ToolUseBlock key={runningTool.id || "running"} block={runningTool} />}
          </div>
        )}
      </div>
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

  const ACTION_TOOL_NAMES = ["restart_app", "open_icloud_settings", "open_finder_iphone"];

  const isActionTool = (block: ContentBlock): block is ToolUseBlockType =>
    block.type === "tool_use" &&
    ACTION_TOOL_NAMES.includes(block.name) &&
    block.status === "complete";

  const renderSegments: (
    | { kind: "content"; block: ContentBlock; idx: number }
    | { kind: "action_tool"; block: ToolUseBlockType }
    | { kind: "tool_group"; tools: ToolUseBlockType[] }
  )[] = [];

  let pendingTools: ToolUseBlockType[] = [];

  const flushTools = () => {
    if (pendingTools.length > 0) {
      renderSegments.push({ kind: "tool_group", tools: [...pendingTools] });
      pendingTools = [];
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "tool_use") {
      if (isActionTool(block)) {
        flushTools();
        renderSegments.push({ kind: "action_tool", block });
      } else {
        pendingTools.push(block);
      }
    } else {
      flushTools();
      renderSegments.push({ kind: "content", block, idx: i });
    }
  }
  flushTools();

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1">
        {renderSegments.map((seg, i) => {
          if (seg.kind === "content") {
            if (seg.block.type === "thinking") return <ThinkingBlock key={`c-${seg.idx}`} block={seg.block} />;
            if (seg.block.type === "text") return <StreamingText key={`c-${seg.idx}`} block={seg.block} />;
            return null;
          }
          if (seg.kind === "action_tool") {
            return <ToolUseBlock key={seg.block.id || seg.block.name} block={seg.block} />;
          }
          if (seg.kind === "tool_group") {
            return <ToolCallSummary key={`tg-${i}`} tools={seg.tools} isStreaming={isStreaming} />;
          }
          return null;
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

import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import type { ThinkingBlock as ThinkingBlockType } from "../lib/types";

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const duration =
    block.startTime && block.endTime
      ? ((block.endTime - block.startTime) / 1000).toFixed(1)
      : null;

  const summaryText = block.isStreaming
    ? "Thinking..."
    : `Thought for ${duration || "?"}s`;

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <Brain size={14} className={block.isStreaming ? "animate-pulse text-violet-400" : ""} />
        <span>{summaryText}</span>
        {!block.isStreaming &&
          (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {(expanded || block.isStreaming) && block.thinking && (
        <div className="mt-2 ml-5 text-xs text-zinc-500 leading-relaxed whitespace-pre-wrap border-l-2 border-zinc-800 pl-3 max-h-60 overflow-y-auto">
          {block.thinking}
          {block.isStreaming && (
            <span className="inline-block w-1.5 h-3.5 bg-violet-400 ml-0.5 animate-pulse" />
          )}
        </div>
      )}
    </div>
  );
}

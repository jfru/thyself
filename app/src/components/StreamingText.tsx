import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { TextBlock } from "../lib/types";
import { markdownComponents } from "./markdownComponents";

interface StreamingTextProps {
  block: TextBlock;
}

export function StreamingText({ block }: StreamingTextProps) {
  return (
    <div className="text-sm text-zinc-300 leading-relaxed prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {block.text}
      </ReactMarkdown>
      {block.isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse align-text-bottom" />
      )}
    </div>
  );
}

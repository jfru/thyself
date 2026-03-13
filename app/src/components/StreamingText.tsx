import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { TextBlock } from "../lib/types";
import { markdownComponents } from "./markdownComponents";

interface StreamingTextProps {
  block: TextBlock;
}

export function StreamingText({ block }: StreamingTextProps) {
  const citations = block.citations;
  const uniqueSources = citations
    ? Array.from(new Map(citations.map((c) => [c.url, c])).values())
    : [];

  return (
    <div className="text-sm text-zinc-300 leading-relaxed prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
        urlTransform={(url) => url.startsWith("thyself:") ? url : defaultUrlTransform(url)}
      >
        {block.text}
      </ReactMarkdown>
      {block.isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse align-text-bottom" />
      )}
      {uniqueSources.length > 0 && !block.isStreaming && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {uniqueSources.map((source, i) => (
            <a
              key={i}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-blue-400 bg-zinc-800/50 rounded px-1.5 py-0.5 transition-colors"
              title={source.cited_text}
            >
              <span className="text-zinc-600">[{i + 1}]</span>
              <span className="truncate max-w-[200px]">{source.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

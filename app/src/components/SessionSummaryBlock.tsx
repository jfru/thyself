import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { markdownComponents } from "./markdownComponents";

interface SessionSummaryBlockProps {
  summary: string;
  sessionName: string;
}

export function SessionSummaryBlock({ summary, sessionName }: SessionSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mx-auto max-w-3xl px-4 pt-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:bg-zinc-900"
      >
        <FileText size={16} className="flex-shrink-0 text-blue-400" />
        <span className="flex-1 text-sm font-medium text-zinc-300">
          {sessionName}
        </span>
        {expanded ? (
          <ChevronDown size={16} className="text-zinc-500" />
        ) : (
          <ChevronRight size={16} className="text-zinc-500" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 rounded-b-lg border border-t-0 border-zinc-800 bg-zinc-900/30 px-5 py-4">
          <div className="text-sm text-zinc-300 leading-relaxed prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {summary}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

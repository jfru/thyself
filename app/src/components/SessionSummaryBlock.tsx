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
    <div className="bg-zinc-950 border-b border-zinc-800 py-3">
      <div className="mx-auto max-w-xl px-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/70 px-5 py-3 text-left transition-colors hover:bg-zinc-800/80"
        >
          <FileText size={16} className="flex-shrink-0 text-blue-400" />
          <span className="flex-1 text-sm font-semibold text-zinc-200">
            {sessionName}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 mr-1">
            Summary
          </span>
          {expanded ? (
            <ChevronDown size={16} className="text-zinc-400" />
          ) : (
            <ChevronRight size={16} className="text-zinc-400" />
          )}
        </button>
        {expanded && (
          <div className="mt-1 rounded-b-lg border border-t-0 border-zinc-700 bg-zinc-900/30 px-5 py-4 max-h-[50vh] overflow-y-auto">
            <div className="text-sm text-zinc-300 leading-relaxed prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {summary}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

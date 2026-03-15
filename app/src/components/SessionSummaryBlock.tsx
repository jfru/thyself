import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronRight, FileText } from "lucide-react";
import { markdownComponents } from "./markdownComponents";
import { invokeCommand } from "../lib/tauriBridge";

interface SessionSummaryBlockProps {
  summary: string;
  sessionName: string;
  sessionId?: string;
}

export function SessionSummaryBlock({ summary, sessionName, sessionId }: SessionSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleShare = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        if (sessionId) {
          await invokeCommand("share_session_pdf", { sessionId });
        } else {
          await navigator.clipboard.writeText(summary);
        }
        clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => setCopied(false), 1000);
      } catch (err) {
        console.error("Share failed:", err);
        await navigator.clipboard.writeText(summary);
        clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => setCopied(false), 1000);
      }
    },
    [summary, sessionId],
  );

  return (
    <div className="relative bg-zinc-950 border-b border-zinc-800 py-3">
      {copied && (
        <div
          className="absolute left-1/2 -translate-x-1/2 top-0 -translate-y-full z-50 rounded-md bg-zinc-700 px-3 py-1.5 text-xs text-zinc-100 shadow-lg"
          style={{ animation: "toast-pop 150ms ease-out" }}
        >
          Copied to clipboard
        </div>
      )}
      <div className="mx-auto max-w-xl px-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/70 px-5 py-3 text-left transition-colors hover:bg-zinc-800/80"
        >
          {expanded ? (
            <ChevronDown size={16} className="flex-shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight size={16} className="flex-shrink-0 text-zinc-400" />
          )}
          <FileText size={16} className="flex-shrink-0 text-blue-400" />
          <span className="flex-1 text-sm font-semibold text-zinc-200">
            {sessionName}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 mr-1">
            Summary
          </span>
          <span
            role="button"
            tabIndex={-1}
            onClick={handleShare}
            className="flex-shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {copied ? (
              <Check size={14} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12" />
                <path d="m8 7 4-4 4 4" />
                <path d="M20 21H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3m10 0h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1" />
              </svg>
            )}
          </span>
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

import { useState, useRef, useEffect } from "react";

interface UserMessageProps {
  content: string;
  timestamp: number;
}

const COLLAPSED_MAX = 88; // card max-height when collapsed: ~3.4 lines + top padding

export function UserMessage({ content, timestamp }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  useEffect(() => {
    const el = cardRef.current;
    if (el) {
      setNeedsTruncation(el.scrollHeight > COLLAPSED_MAX);
    }
  }, [content]);

  const isCollapsed = needsTruncation && !expanded;

  return (
    <div className="sticky top-8 z-10 bg-zinc-950 px-4 pt-4 pb-2">
      <div
        ref={cardRef}
        className={`group relative max-w-3xl mx-auto rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 pt-3 pb-4 overflow-hidden ${needsTruncation ? "cursor-pointer" : ""}`}
        style={isCollapsed ? { maxHeight: COLLAPSED_MAX } : undefined}
        onClick={() => needsTruncation && setExpanded(!expanded)}
      >
        <div className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap">
          {content}
        </div>
        <div className={`mt-1 text-xs text-zinc-600 transition-opacity ${isCollapsed ? "hidden" : "opacity-0 group-hover:opacity-100"}`}>
          {time}
        </div>
        {isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none rounded-b-xl" />
        )}
      </div>
    </div>
  );
}

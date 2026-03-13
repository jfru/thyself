import { useState, useEffect, useRef, useCallback } from "react";
import { MessageSquare } from "lucide-react";
import { invokeCommand } from "../lib/tauriBridge";
import type { SessionMeta, ContextAttachment } from "../lib/types";

interface MentionDropdownProps {
  query: string;
  onSelect: (item: ContextAttachment) => void;
  onClose: () => void;
  anchorRect: { top: number; left: number } | null;
}

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export function MentionDropdown({
  query,
  onSelect,
  onClose,
  anchorRect,
}: MentionDropdownProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    invokeCommand<SessionMeta[]>("list_sessions")
      .then((manifest) => {
        if (cancelled) return;
        const completed = manifest
          .filter(
            (s) =>
              s.status === "completed" &&
              (s.kind ?? "conversation") === "conversation"
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setSessions(completed);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const filtered = query
    ? sessions.filter((s) => fuzzyMatch(s.name, query))
    : sessions;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (session: SessionMeta) => {
      onSelect({
        type: "session",
        id: session.id,
        name: session.name,
        preview: formatDate(session.createdAt),
      });
    },
    [onSelect]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(filtered[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [filtered, selectedIndex, handleSelect, onClose]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const item = el.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!anchorRect) return null;

  return (
    <div
      className="fixed z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
      style={{
        bottom: `calc(100vh - ${anchorRect.top}px + 4px)`,
        left: anchorRect.left,
      }}
      ref={listRef}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
        Sessions
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-4 text-xs text-zinc-500 text-center">
          {sessions.length === 0 ? "Loading..." : "No matching sessions"}
        </div>
      ) : (
        filtered.slice(0, 10).map((session, idx) => (
          <button
            key={session.id}
            onMouseDown={(e) => {
              e.preventDefault();
              handleSelect(session);
            }}
            onMouseEnter={() => setSelectedIndex(idx)}
            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
              idx === selectedIndex
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/50"
            }`}
          >
            <MessageSquare
              size={14}
              className={`flex-shrink-0 ${
                idx === selectedIndex ? "text-blue-400" : "text-zinc-600"
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs truncate">{session.name}</div>
              <div className="text-[10px] text-zinc-600">
                {formatDate(session.createdAt)}
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}

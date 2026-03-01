import { useState, useEffect } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { Plus, MessageSquare, PanelLeftClose, PanelLeft } from "lucide-react";
import type { Session } from "../lib/types";

interface SessionSidebarProps {
  onNewSession: () => void;
  onLoadSession: (filename: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function SessionSidebar({
  onNewSession,
  onLoadSession,
  collapsed,
  onToggle,
}: SessionSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    try {
      const files = await invokeCommand<string[]>("list_files", {
        dir: "sessions",
        pattern: "*.md",
      });
      const sessionList: Session[] = files
        .sort()
        .reverse()
        .map((filename) => {
          const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
          return {
            filename,
            title: filename.replace(".md", "").replace(/_/g, " "),
            date: dateMatch ? dateMatch[1] : "",
            preview: "",
          };
        });
      setSessions(sessionList);
    } catch {
      // Sessions dir may not exist yet
    }
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center border-r border-zinc-800 bg-zinc-950 py-3 px-2 gap-2">
        <button
          onClick={onToggle}
          className="rounded-lg p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          title="Expand sidebar"
        >
          <PanelLeft size={18} />
        </button>
        <button
          onClick={onNewSession}
          className="rounded-lg p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          title="New session"
        >
          <Plus size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-64 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-medium text-zinc-300">Sessions</h2>
        <div className="flex gap-1">
          <button
            onClick={onNewSession}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="New session"
          >
            <Plus size={16} />
          </button>
          <button
            onClick={onToggle}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-zinc-600">
            No previous sessions
          </div>
        ) : (
          <div className="py-2">
            {sessions.map((session) => (
              <button
                key={session.filename}
                onClick={() => onLoadSession(session.filename)}
                className="flex w-full items-start gap-2 px-4 py-2.5 text-left hover:bg-zinc-900 transition-colors"
              >
                <MessageSquare
                  size={14}
                  className="mt-0.5 flex-shrink-0 text-zinc-600"
                />
                <div className="min-w-0">
                  <div className="text-xs text-zinc-400 truncate">
                    {session.date}
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {session.title}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

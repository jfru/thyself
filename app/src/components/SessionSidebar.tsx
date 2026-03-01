import { useState, useEffect } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { Plus, MessageSquare, PanelLeftClose, PanelLeft } from "lucide-react";
import type { SessionMeta } from "../lib/types";

interface SessionSidebarProps {
  onNewSession: () => void;
  onLoadSession: (sessionId: string) => void;
  activeSessionId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  refreshKey: number;
}

export function SessionSidebar({
  onNewSession,
  onLoadSession,
  activeSessionId,
  collapsed,
  onToggle,
  refreshKey,
}: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);

  useEffect(() => {
    loadSessions();
  }, [refreshKey]);

  async function loadSessions() {
    try {
      const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
      setSessions([...manifest].reverse());
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
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
      return iso;
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
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              return (
                <button
                  key={session.id}
                  onClick={() => onLoadSession(session.id)}
                  className={`flex w-full items-start gap-2 px-4 py-2.5 text-left transition-colors ${
                    isActive
                      ? "bg-zinc-800/60 border-l-2 border-blue-500"
                      : "hover:bg-zinc-900 border-l-2 border-transparent"
                  }`}
                >
                  <MessageSquare
                    size={14}
                    className={`mt-0.5 flex-shrink-0 ${
                      isActive ? "text-blue-400" : "text-zinc-600"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className={`text-xs truncate ${
                      isActive ? "text-zinc-200 font-medium" : "text-zinc-400"
                    }`}>
                      {session.name}
                    </div>
                    <div className="text-xs text-zinc-600 truncate">
                      {formatDate(session.createdAt)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

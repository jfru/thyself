import { useState, useEffect } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { Plus, MessageSquare, PanelLeftClose, PanelLeft, User, ChevronDown, Trash2, Settings, Sparkles } from "lucide-react";
import type { SessionMeta, Profile } from "../lib/types";

interface SessionSidebarProps {
  onNewSession: () => void;
  onLoadSession: (sessionId: string) => void;
  activeSessionId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  refreshKey: number;
  profile: Profile;
  onProfileSwitch: (profile: Profile) => void;
  onNewProfile: () => void;
  onDeleteProfile: (profileId: string) => void;
}

export function SessionSidebar({
  onNewSession,
  onLoadSession,
  activeSessionId,
  collapsed,
  onToggle,
  refreshKey,
  profile,
  onProfileSwitch,
  onNewProfile,
  onDeleteProfile,
}: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, [refreshKey, profile.id]);

  async function loadSessions() {
    try {
      const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
      setSessions([...manifest].reverse());
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }

  async function handleProfileMenuToggle() {
    if (!showProfileMenu) {
      try {
        const result = await invokeCommand<{
          profiles: Profile[];
          activeProfileId: string | null;
        }>("list_profiles");
        setAllProfiles(result.profiles);
      } catch (err) {
        console.error("Failed to load profiles:", err);
      }
    }
    setShowProfileMenu(!showProfileMenu);
    if (showProfileMenu) setConfirmDeleteId(null);
  }

  async function handleSwitchProfile(profileId: string) {
    try {
      const switched = await invokeCommand<Profile>("cmd_switch_profile", { profileId });
      setShowProfileMenu(false);
      onProfileSwitch(switched);
    } catch (err) {
      console.error("Failed to switch profile:", err);
    }
  }

  function handleNewProfile() {
    setShowProfileMenu(false);
    onNewProfile();
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

  const conversationSessions = sessions.filter(
    (s) => (s.kind ?? "conversation") === "conversation"
  );
  const setupSessions = sessions.filter(
    (s) => (s.kind ?? "conversation") === "setup" || (s.kind ?? "conversation") === "portrait"
  );

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
            {conversationSessions.length > 0 && (
              <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-zinc-600">
                Conversations
              </div>
            )}
            {conversationSessions.map((session) => {
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

            {setupSessions.length > 0 && (
              <div className="mt-3 px-4 py-1 text-[10px] uppercase tracking-wider text-zinc-600">
                Getting Started
              </div>
            )}
            {setupSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const isPortrait = session.kind === "portrait";
              const Icon = isPortrait ? Sparkles : Settings;
              const activeColor = isPortrait ? "text-amber-400" : "text-purple-400";
              const inactiveColor = isPortrait ? "text-amber-500/70" : "text-purple-500/70";
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
                  <Icon
                    size={14}
                    className={`mt-0.5 flex-shrink-0 ${
                      isActive ? activeColor : inactiveColor
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

      {/* Profile indicator */}
      <div className="relative border-t border-zinc-800">
        <button
          onClick={handleProfileMenuToggle}
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-zinc-900 transition-colors"
        >
          <User size={14} className="text-zinc-500 flex-shrink-0" />
          <span className="text-xs text-zinc-400 truncate flex-1">
            {profile.subject_name}
          </span>
          <ChevronDown
            size={12}
            className={`text-zinc-500 transition-transform ${showProfileMenu ? "rotate-180" : ""}`}
          />
        </button>

        {showProfileMenu && (
          <div className="absolute bottom-full left-0 right-0 mb-1 mx-2 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
            {allProfiles.map((p) => (
              <div key={p.id} className="group relative">
                {confirmDeleteId === p.id ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-red-950/50 border-l-2 border-red-500">
                    <span className="text-xs text-red-300 flex-1 truncate">
                      Delete {p.subject_name}?
                    </span>
                    <button
                      onClick={() => {
                        setConfirmDeleteId(null);
                        setShowProfileMenu(false);
                        onDeleteProfile(p.id);
                      }}
                      className="px-2 py-0.5 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-500 transition-colors"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-2 py-0.5 text-[10px] font-medium rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div
                    className={`flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors ${
                      p.id === profile.id
                        ? "bg-zinc-800 text-zinc-200"
                        : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    <button
                      onClick={() => handleSwitchProfile(p.id)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <User size={12} className="flex-shrink-0" />
                      <span className="truncate">{p.subject_name}</span>
                      {p.id === profile.id && (
                        <span className="ml-auto text-blue-400 text-[10px]">active</span>
                      )}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(p.id)}
                      className="flex-shrink-0 p-0.5 rounded text-zinc-700 hover:text-red-400 transition-colors"
                      title={`Delete ${p.subject_name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            <button
              onClick={handleNewProfile}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors border-t border-zinc-800"
            >
              <Plus size={12} />
              New profile
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

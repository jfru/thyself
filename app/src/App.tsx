import { useState, useCallback, useRef, useEffect } from "react";
import { ChatView } from "./components/ChatView";
import { SessionSidebar } from "./components/SessionSidebar";
import { UpdateNotification } from "./components/UpdateNotification";
import { OnboardingWelcome } from "./components/OnboardingWelcome";
import { DataSourceGrid } from "./components/DataSourceGrid";
import { useStreamChat } from "./hooks/useStreamChat";
import { invokeCommand } from "./lib/tauriBridge";
import type { SessionMeta, Message, SystemMessage, Profile, ImageAttachment } from "./lib/types";

// #region agent log
function dlog(location: string, message: string, data: Record<string, unknown>) {
  invokeCommand("cmd_debug_log", { location, message, data: JSON.stringify(data) }).catch(() => {});
}
// #endregion

type AppPhase =
  | { kind: "loading" }
  | { kind: "onboarding-welcome" }
  | { kind: "onboarding-sources"; name: string; apiKey: string }
  | { kind: "ready"; profile: Profile };

function App() {
  const [phase, setPhase] = useState<AppPhase>({ kind: "loading" });

  useEffect(() => {
    async function init() {
      try {
        const result = await invokeCommand<{
          profiles: Profile[];
          activeProfileId: string | null;
        }>("list_profiles");

        // #region agent log
        dlog('App.tsx:init', 'profiles loaded', {count:result.profiles.length,activeId:result.activeProfileId,activeOnboarding:result.profiles.find(p=>p.id===result.activeProfileId)?.onboarding_status});
        // #endregion

        if (result.profiles.length === 0) {
          setPhase({ kind: "onboarding-welcome" });
          return;
        }

        const activeId = result.activeProfileId;
        const active = activeId
          ? result.profiles.find((p) => p.id === activeId)
          : result.profiles[0];

        if (active) {
          setPhase({ kind: "ready", profile: active });
        } else {
          setPhase({ kind: "onboarding-welcome" });
        }
      } catch (err) {
        console.error("Failed to load profiles:", err);
        setPhase({ kind: "onboarding-welcome" });
      }
    }
    init();
  }, []);

  function handleWelcomeNext(name: string, apiKey: string) {
    setPhase({ kind: "onboarding-sources", name, apiKey });
  }

  async function handleSourcesNext(selectedSources: string[]) {
    if (phase.kind !== "onboarding-sources") return;

    try {
      const profile = await invokeCommand<Profile>("cmd_create_profile", {
        name: phase.name,
        apiKey: phase.apiKey,
        subjectName: phase.name,
        email: null,
        selectedSources: selectedSources,
      });
      setPhase({ kind: "ready", profile });
    } catch (err) {
      console.error("Failed to create profile:", err);
    }
  }

  function handleProfileSwitch(profile: Profile) {
    setPhase({ kind: "ready", profile });
  }

  async function handleDeleteProfile(profileId: string) {
    try {
      const result = await invokeCommand<{ nextProfile: Profile | null }>(
        "cmd_delete_profile",
        { profileId }
      );
      if (result.nextProfile) {
        setPhase({ kind: "ready", profile: result.nextProfile });
      } else {
        setPhase({ kind: "onboarding-welcome" });
      }
    } catch (err) {
      console.error("Failed to delete profile:", err);
    }
  }

  if (phase.kind === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950">
        <div className="text-zinc-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (phase.kind === "onboarding-welcome") {
    return <OnboardingWelcome onNext={handleWelcomeNext} />;
  }

  if (phase.kind === "onboarding-sources") {
    return <DataSourceGrid onNext={handleSourcesNext} />;
  }

  return (
    <MainApp
      key={phase.profile.id}
      profile={phase.profile}
      onProfileSwitch={handleProfileSwitch}
      onNewProfile={() => setPhase({ kind: "onboarding-welcome" })}
      onDeleteProfile={handleDeleteProfile}
    />
  );
}

interface MainAppProps {
  profile: Profile;
  onProfileSwitch: (profile: Profile) => void;
  onNewProfile: () => void;
  onDeleteProfile: (profileId: string) => void;
}

function MainApp({ profile, onProfileSwitch, onNewProfile, onDeleteProfile }: MainAppProps) {
  const sessionIdRef = useRef<string | null>(null);
  const { messages, isStreaming, sendMessage, stopStreaming, clearMessages, setMessages } =
    useStreamChat(sessionIdRef, {
      subjectName: profile.subject_name,
      onboardingStatus: profile.onboarding_status,
      selectedSources: profile.selected_sources,
    });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  const refreshSidebar = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const onboardingStarted = useRef(false);

  useEffect(() => {
    async function resumeActiveSession() {
      // #region agent log
      dlog('App.tsx:resume', 'effect entered', {onboardingStatus:profile.onboarding_status,onboardingStarted:onboardingStarted.current,profileId:profile.id});
      // #endregion
      try {
        if (profile.onboarding_status === "pending") {
          if (onboardingStarted.current) {
            // #region agent log
            dlog('App.tsx:resume', 'SKIPPED - already started', {});
            // #endregion
            return;
          }
          onboardingStarted.current = true;

          const session = await invokeCommand<SessionMeta>("create_session", {
            name: "Setup",
          });
          // #region agent log
          dlog('App.tsx:resume', 'session created', {sessionId:session.id,historyLen:Array.isArray(session.chatHistory)?session.chatHistory.length:0});
          // #endregion
          setActiveSessionId(session.id);
          sessionIdRef.current = session.id;
          refreshSidebar();

          const hasHistory =
            Array.isArray(session.chatHistory) && session.chatHistory.length > 0;

          if (hasHistory) {
            const restartMsg: SystemMessage = {
              role: "system",
              text: "App restarted and ready to continue.",
              action: {
                label: "Continue setup",
                message:
                  "I'm ready to continue with the setup.",
              },
              timestamp: Date.now(),
            };
            setMessages([...session.chatHistory, restartMsg]);
          } else {
            const welcomeMsg: SystemMessage = {
              role: "system",
              text: "Ready to connect your message history?",
              action: {
                label: "Let's go",
                message: "Let's get my message history set up.",
              },
              timestamp: Date.now(),
            };
            setMessages([welcomeMsg]);
          }
          return;
        }

        const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
        const active = manifest.find((s) => s.status === "active");
        if (active) {
          setActiveSessionId(active.id);
          sessionIdRef.current = active.id;
          const full = await invokeCommand<{ session: SessionMeta; summary: string | null }>(
            "load_session", { sessionId: active.id }
          );
          if (Array.isArray(full.session.chatHistory) && full.session.chatHistory.length > 0) {
            setMessages(full.session.chatHistory);
          }
          if (full.session.status === "completed") {
            setSessionSummary(full.summary);
            setIsReadOnly(true);
          }
        }
      } catch (err) {
        // #region agent log
        dlog('App.tsx:resume', 'ERROR', {error:String(err)});
        // #endregion
        console.error("Failed to resume active session:", err);
      }
    }
    resumeActiveSession();
  }, [setMessages, profile.id]);

  const saveCurrentMessages = useCallback(
    async (sessionId: string, msgs: Message[]) => {
      try {
        await invokeCommand("save_session_messages", {
          sessionId,
          messages: msgs,
        });
        // #region agent log
        dlog('App.tsx:save', 'save SUCCESS', {sessionId,msgCount:msgs.length});
        // #endregion
      } catch (err) {
        // #region agent log
        dlog('App.tsx:save', 'save FAILED', {sessionId,error:String(err)});
        // #endregion
      }
    },
    []
  );

  const handleSend = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      if (isReadOnly) return;

      let sid = activeSessionId;

      if (!sid) {
        try {
          const session = await invokeCommand<SessionMeta>("create_session");
          sid = session.id;
          setActiveSessionId(sid);
          sessionIdRef.current = sid;
          refreshSidebar();
        } catch (err) {
          console.error("Failed to create session:", err);
        }
      }

      await sendMessage(text, images);
    },
    [activeSessionId, isReadOnly, sendMessage, refreshSidebar]
  );

  const prevStreamingRef = useRef(isStreaming);
  if (prevStreamingRef.current && !isStreaming && activeSessionId) {
    // #region agent log
    dlog('App.tsx:save-trigger', 'save triggered', {activeSessionId,messageCount:messages.length});
    // #endregion
    saveCurrentMessages(activeSessionId, messages);
    refreshSidebar();
  }
  prevStreamingRef.current = isStreaming;

  const handleNewSession = useCallback(() => {
    clearMessages();
    setActiveSessionId(null);
    sessionIdRef.current = null;
    setSessionSummary(null);
    setSessionName(null);
    setIsReadOnly(false);
  }, [clearMessages]);

  const handleClearSession = useCallback(async () => {
    clearMessages();
    if (activeSessionId) {
      await saveCurrentMessages(activeSessionId, []);
    }
  }, [clearMessages, activeSessionId, saveCurrentMessages]);

  const handleLoadSession = useCallback(
    async (sessionId: string) => {
      try {
        const result = await invokeCommand<{
          session: SessionMeta;
          summary: string | null;
        }>("load_session", { sessionId });

        const { session, summary } = result;

        setActiveSessionId(session.id);
        sessionIdRef.current = session.id;
        setSessionName(session.name);

        if (session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
          setMessages(session.chatHistory);
        } else {
          clearMessages();
        }

        if (session.status === "completed") {
          setSessionSummary(summary);
          setIsReadOnly(true);
        } else {
          setSessionSummary(null);
          setIsReadOnly(false);
        }
      } catch (err) {
        console.error("Failed to load session:", err);
      }
    },
    [setMessages, clearMessages]
  );

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <UpdateNotification />
      <div className="flex flex-1 min-h-0">
        <SessionSidebar
          onNewSession={handleNewSession}
          onLoadSession={handleLoadSession}
          activeSessionId={activeSessionId}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          refreshKey={sidebarRefreshKey}
          profile={profile}
          onProfileSwitch={onProfileSwitch}
          onNewProfile={onNewProfile}
          onDeleteProfile={onDeleteProfile}
        />
        <ChatView
          messages={messages}
          isStreaming={isStreaming}
          onSend={handleSend}
          onStop={stopStreaming}
          onClear={!isReadOnly ? handleClearSession : undefined}
          sessionSummary={sessionSummary}
          sessionName={sessionName}
          isReadOnly={isReadOnly}
        />
      </div>
    </div>
  );
}

export default App;

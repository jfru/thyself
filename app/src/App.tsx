import { useState, useCallback, useRef, useEffect } from "react";
import { ChatView } from "./components/ChatView";
import { SessionSidebar } from "./components/SessionSidebar";
import { UpdateNotification } from "./components/UpdateNotification";
import { OnboardingWelcome } from "./components/OnboardingWelcome";
import { DataSourceGrid } from "./components/DataSourceGrid";
import { useStreamChat } from "./hooks/useStreamChat";
import { invokeCommand } from "./lib/tauriBridge";
import type { SessionMeta, Message, SystemMessage, Profile, ImageAttachment, FileAttachment } from "./lib/types";

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

const OPEN_SETUP_ACTION = "__OPEN_SETUP__";
const OPEN_PORTRAIT_ACTION = "__OPEN_PORTRAIT__";
const CONTINUE_SETUP_MESSAGE = "I'm ready to continue connecting my data.";

const ALL_SOURCES = ["imessage", "whatsapp", "gmail", "chatgpt"];

const SOURCE_SYNC_KEYS: Record<string, string[]> = {
  imessage: ["imessage"],
  whatsapp: ["whatsapp_desktop", "whatsapp_web"],
  gmail: ["gmail"],
  chatgpt: ["chatgpt"],
};

interface SourceConnectionStatus {
  connected: string[];
  missing: string[];
  total: number;
}

async function getSourceConnectionStatus(): Promise<SourceConnectionStatus> {
  const connected: string[] = [];
  const missing: string[] = [];
  try {
    const status = await invokeCommand<{
      latest_by_source: Record<string, { status: string }>;
    }>("get_sync_status");
    const latest = status.latest_by_source ?? {};
    for (const source of ALL_SOURCES) {
      const keys = SOURCE_SYNC_KEYS[source] ?? [source];
      const isConnected = keys.some(
        (k) => latest[k] && latest[k].status === "completed"
      );
      if (isConnected) {
        connected.push(source);
      } else {
        missing.push(source);
      }
    }
  } catch {
    missing.push(...ALL_SOURCES);
  }
  return { connected, missing, total: ALL_SOURCES.length };
}

function makeSetupContinueMessage(): SystemMessage {
  return {
    role: "system",
    text: "Ready to continue connecting your data?",
    action: {
      label: "Continue",
      message: CONTINUE_SETUP_MESSAGE,
    },
    timestamp: Date.now(),
  };
}

function makeSetupStartMessage(): SystemMessage {
  return {
    role: "system",
    text: "Ready to connect your message history?",
    action: {
      label: "Get started",
      message: "Let's get my message history set up.",
    },
    timestamp: Date.now(),
  };
}

function makeSourceNudgeMessage(status: SourceConnectionStatus): SystemMessage {
  if (status.connected.length === 0) {
    return {
      role: "system",
      text: "Connect your data sources to get started.",
      action: {
        label: "Connect Data",
        message: OPEN_SETUP_ACTION,
      },
      timestamp: Date.now(),
    };
  }
  return {
    role: "system",
    text: `You have ${status.connected.length} of ${status.total} data sources connected. Connecting more will give Thyself a richer understanding of your life.`,
    action: {
      label: "Connect more sources",
      message: OPEN_SETUP_ACTION,
    },
    secondaryAction: {
      label: "Build Your Portrait",
      message: OPEN_PORTRAIT_ACTION,
    },
    timestamp: Date.now(),
  };
}

function makeNoDataMessage(
  sessionKind: "conversation" | "setup" | "portrait" | null
): SystemMessage {
  if (sessionKind === "setup") {
    return makeSetupStartMessage();
  }
  return {
    role: "system",
    text: "Connect your data sources to get started.",
    action: {
      label: "Connect Data",
      message: OPEN_SETUP_ACTION,
    },
    timestamp: Date.now(),
  };
}

async function makeConversationNudgeMessage(): Promise<SystemMessage> {
  const status = await getSourceConnectionStatus();
  if (status.connected.length === 0) {
    return {
      role: "system",
      text: "Connect your data sources to get started.",
      action: {
        label: "Connect Data",
        message: OPEN_SETUP_ACTION,
      },
      timestamp: Date.now(),
    };
  }
  if (status.missing.length > 0) {
    return makeSourceNudgeMessage(status);
  }
  return {
    role: "system",
    text: "All your data sources are connected! Ready to build your portrait?",
    action: {
      label: "Build Your Portrait",
      message: OPEN_PORTRAIT_ACTION,
    },
    timestamp: Date.now(),
  };
}

function normalizeSetupMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "system") return msg;
    if (!msg.action || msg.action.message !== OPEN_SETUP_ACTION) return msg;
    return {
      ...msg,
      text: "Ready to continue connecting your data?",
      action: {
        label: "Continue",
        message: CONTINUE_SETUP_MESSAGE,
      },
    };
  });
}

function MainApp({ profile, onProfileSwitch, onNewProfile, onDeleteProfile }: MainAppProps) {
  const sessionIdRef = useRef<string | null>(null);
  const [selectedSources, setSelectedSources] = useState<string[]>(profile.selected_sources);
  const [connectedSources, setConnectedSources] = useState<string[]>([]);
  const [activeSessionKind, setActiveSessionKind] = useState<"conversation" | "setup" | "portrait" | null>(null);
  const { messages, isStreaming, sendMessage, stopStreaming, clearMessages, setMessages } =
    useStreamChat(sessionIdRef, {
      subjectName: profile.subject_name,
      onboardingStatus: profile.onboarding_status,
      selectedSources,
      connectedSources,
      activeSessionKind,
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

  const hasImportedData = useCallback(async (): Promise<boolean> => {
    try {
      const result = await invokeCommand<{ rows?: Array<{ total?: number | string }> }>("query_db", {
        sql: "SELECT ((SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM chatgpt_messages) + (SELECT COUNT(*) FROM gmail_messages)) AS total",
      });
      const totalRaw = result.rows?.[0]?.total ?? 0;
      return Number(totalRaw) > 0;
    } catch {
      return false;
    }
  }, []);

  const onboardingStarted = useRef(false);

  useEffect(() => {
    async function resumeActiveSession() {
      // #region agent log
      dlog('App.tsx:resume', 'effect entered', {onboardingStatus:profile.onboarding_status,onboardingStarted:onboardingStarted.current,profileId:profile.id});
      // #endregion
      try {
        if (profile.onboarding_status === "pending") {
          const hasData = await hasImportedData();
          if (!hasData) {
            if (onboardingStarted.current) {
              return;
            }
            onboardingStarted.current = true;

            const session = await invokeCommand<SessionMeta>("create_session", {
              name: "Connect Data",
              kind: "setup",
            });
            setActiveSessionId(session.id);
            setActiveSessionKind((session.kind ?? "conversation") as "conversation" | "setup" | "portrait");
            sessionIdRef.current = session.id;
            refreshSidebar();

            const hasHistory =
              Array.isArray(session.chatHistory) && session.chatHistory.length > 0;
            if (hasHistory) {
              const normalizedHistory = normalizeSetupMessages(session.chatHistory);
              const restartMsg: SystemMessage = {
                role: "system",
                text: "App restarted and ready to continue.",
                action: {
                  label: "Continue",
                  message: CONTINUE_SETUP_MESSAGE,
                },
                timestamp: Date.now(),
              };
              setMessages([...normalizedHistory, restartMsg]);
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

          // Ensure portrait session exists in sidebar when data is imported
          try {
            await invokeCommand<SessionMeta>("create_session", {
              name: "Build Your Portrait",
              kind: "portrait",
            });
            refreshSidebar();
          } catch {
            // best effort
          }

          const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
          const activeConversation = manifest.find(
            (s) => s.status === "active" && (s.kind ?? "conversation") === "conversation"
          );
          if (activeConversation) {
            setActiveSessionId(activeConversation.id);
            setActiveSessionKind("conversation");
            sessionIdRef.current = activeConversation.id;
            const full = await invokeCommand<{ session: SessionMeta; summary: string | null }>(
              "load_session",
              { sessionId: activeConversation.id }
            );
            if (Array.isArray(full.session.chatHistory) && full.session.chatHistory.length > 0) {
              setMessages(full.session.chatHistory);
            } else if (profile.onboarding_status === "pending") {
              const nudge = await makeConversationNudgeMessage();
              setMessages([nudge]);
            }
            setSessionSummary(null);
            setIsReadOnly(false);
            return;
          }

        }

        const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
        const active = manifest.find(
          (s) => s.status === "active" && (s.kind ?? "conversation") === "conversation"
        );
        if (active) {
          setActiveSessionId(active.id);
          setActiveSessionKind((active.kind ?? "conversation") as "conversation" | "setup" | "portrait");
          sessionIdRef.current = active.id;
          const full = await invokeCommand<{ session: SessionMeta; summary: string | null }>(
            "load_session", { sessionId: active.id }
          );
          if (Array.isArray(full.session.chatHistory) && full.session.chatHistory.length > 0) {
            setMessages(full.session.chatHistory);
          } else if (profile.onboarding_status === "pending") {
            const activeKind = (active.kind ?? "conversation") as "conversation" | "setup" | "portrait";
            if (activeKind === "setup") {
              setMessages([makeNoDataMessage(activeKind)]);
            } else {
              const nudge = await makeConversationNudgeMessage();
              setMessages([nudge]);
            }
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
  }, [setMessages, profile.id, hasImportedData]);

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

  const openSetupSession = useCallback(async () => {
    try {
      const setup = await invokeCommand<SessionMeta>("create_session", {
        name: "Connect Data",
        kind: "setup",
      });
      const result = await invokeCommand<{
        session: SessionMeta;
        summary: string | null;
      }>("load_session", { sessionId: setup.id });
      const { session, summary } = result;

      setActiveSessionId(session.id);
      setActiveSessionKind((session.kind ?? "conversation") as "conversation" | "setup" | "portrait");
      sessionIdRef.current = session.id;
      setSessionName(session.name);

      if (session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
        const normalizedHistory = normalizeSetupMessages(session.chatHistory);
        const last = normalizedHistory[normalizedHistory.length - 1] as Message | undefined;
        const hasCtaAsLast =
          last &&
          last.role === "system" &&
          !!last.action &&
          last.action.message === CONTINUE_SETUP_MESSAGE;

        const setupCta = makeSetupContinueMessage();

        setMessages(hasCtaAsLast ? normalizedHistory : [...normalizedHistory, setupCta]);
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

      if (session.status === "completed") {
        setSessionSummary(summary);
        setIsReadOnly(true);
      } else {
        setSessionSummary(null);
        setIsReadOnly(false);
      }
      refreshSidebar();
    } catch (err) {
      console.error("Failed to open setup session:", err);
    }
  }, [clearMessages, refreshSidebar, setMessages]);

  const openPortraitSession = useCallback(async () => {
    try {
      const portrait = await invokeCommand<SessionMeta>("create_session", {
        name: "Build Your Portrait",
        kind: "portrait",
      });
      const result = await invokeCommand<{
        session: SessionMeta;
        summary: string | null;
      }>("load_session", { sessionId: portrait.id });
      const { session, summary } = result;

      setActiveSessionId(session.id);
      setActiveSessionKind("portrait");
      sessionIdRef.current = session.id;
      setSessionName(session.name);

      if (session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
        setMessages(session.chatHistory);
      } else {
        const status = await getSourceConnectionStatus();
        setConnectedSources(status.connected);
        const nudge = await makeConversationNudgeMessage();
        setMessages([nudge]);
      }

      if (session.status === "completed") {
        setSessionSummary(summary);
        setIsReadOnly(true);
      } else {
        setSessionSummary(null);
        setIsReadOnly(false);
      }
      refreshSidebar();
    } catch (err) {
      console.error("Failed to open portrait session:", err);
    }
  }, [refreshSidebar, selectedSources, setMessages]);

  const addSourceToProfile = useCallback(
    async (sourceId: string): Promise<string[] | undefined> => {
      if (selectedSources.includes(sourceId)) return selectedSources;
      const nextSources = [...selectedSources, sourceId];
      try {
        await invokeCommand<Profile>("cmd_update_profile", {
          profileId: profile.id,
          selectedSources: nextSources,
        });
        setSelectedSources(nextSources);
        return nextSources;
      } catch (err) {
        console.error("Failed to add source to profile:", err);
        return undefined;
      }
    },
    [profile.id, selectedSources]
  );

  const removeSourceFromProfile = useCallback(
    async (sourceId: string) => {
      try {
        const result = await invokeCommand<{
          selectedSources?: string[];
        }>("cmd_remove_data_source", {
          profileId: profile.id,
          sourceId,
        });
        if (Array.isArray(result.selectedSources)) {
          setSelectedSources(result.selectedSources);
        } else {
          setSelectedSources((prev) => prev.filter((s) => s !== sourceId));
        }
      } catch (err) {
        console.error("Failed to remove source from profile:", err);
      }
    },
    [profile.id]
  );

  const handleSend = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      options?: { selectedSourcesOverride?: string[] },
      files?: FileAttachment[]
    ) => {
      if (text === OPEN_SETUP_ACTION) {
        await openSetupSession();
        return;
      }

      if (text === OPEN_PORTRAIT_ACTION) {
        if (activeSessionKind !== "portrait") {
          await openPortraitSession();
        }
        await sendMessage("Let's build my portrait.", undefined, {
          sessionKind: "portrait",
        });
        return;
      }

      if (text === "__DISMISS_NUDGE__") {
        setMessages((prev) => prev.filter((m) => m.role !== "system"));
        return;
      }

      if (isReadOnly) return;

      let sid = activeSessionId;
      let kind = activeSessionKind;

      if (!sid) {
        try {
          const session = await invokeCommand<SessionMeta>("create_session", {
            kind: "conversation",
          });
          sid = session.id;
          kind = "conversation";
          setActiveSessionId(sid);
          setActiveSessionKind(kind);
          sessionIdRef.current = sid;
          refreshSidebar();
        } catch (err) {
          console.error("Failed to create session:", err);
        }
      }

      if (
        profile.onboarding_status === "pending" &&
        (kind ?? "conversation") === "conversation"
      ) {
        const status = await getSourceConnectionStatus();
        if (status.connected.length === 0) {
          setMessages((prev) => [...prev, makeSourceNudgeMessage(status)]);
          return;
        }
        if (status.missing.length > 0) {
          const hasData = await hasImportedData();
          if (!hasData) {
            setMessages((prev) => [...prev, makeSourceNudgeMessage(status)]);
            return;
          }
        }
      }

      await sendMessage(text, images, {
        sessionKind: kind ?? "conversation",
        selectedSourcesOverride: options?.selectedSourcesOverride,
      }, files);
    },
    [
      activeSessionId,
      activeSessionKind,
      hasImportedData,
      isReadOnly,
      openSetupSession,
      openPortraitSession,
      profile.onboarding_status,
      refreshSidebar,
      sendMessage,
      setMessages,
    ]
  );

  const requestSourceSetup = useCallback(
    async (sourceId: string, selectedSourcesOverride?: string[]) => {
      const sourceLabels: Record<string, string> = {
        imessage: "iMessage",
        whatsapp: "WhatsApp",
        gmail: "Gmail",
        chatgpt: "ChatGPT",
      };
      const label = sourceLabels[sourceId] || sourceId;
      await handleSend(`Help me connect my ${label} data source.`, undefined, {
        selectedSourcesOverride,
      });
    },
    [handleSend]
  );

  const prevStreamingRef = useRef(isStreaming);

  // Persist incrementally so refresh/crash during long tool runs
  // (e.g. Gmail import) doesn't lose in-flight chat history.
  useEffect(() => {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const timer = window.setTimeout(() => {
      void saveCurrentMessages(sessionId, messages);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, messages, saveCurrentMessages]);

  useEffect(() => {
    const justFinishedStreaming = prevStreamingRef.current && !isStreaming;
    prevStreamingRef.current = isStreaming;

    if (!justFinishedStreaming || !activeSessionId) return;
    const currentSessionId = activeSessionId;

    async function persistAndRefreshSessionState() {
      // #region agent log
      dlog('App.tsx:save-trigger', 'save triggered', {activeSessionId: currentSessionId,messageCount:messages.length});
      // #endregion

      await saveCurrentMessages(currentSessionId, messages);
      refreshSidebar();

      // Pull latest session status immediately so completed summaries render
      // in the current thread without requiring a manual thread switch.
      try {
        const result = await invokeCommand<{
          session: SessionMeta;
          summary: string | null;
        }>("load_session", { sessionId: currentSessionId });
        const { session, summary } = result;
        setSessionName(session.name);
        if (session.status === "completed") {
          setSessionSummary(summary);
          setIsReadOnly(true);
        } else {
          setSessionSummary(null);
          setIsReadOnly(false);
        }
      } catch (err) {
        console.error("Failed to refresh active session state:", err);
      }

      if (activeSessionKind === "setup") {
        try {
          const status = await getSourceConnectionStatus();
          if (status.connected.length > 0 && status.missing.length === 0) {
            const portraitCta: SystemMessage = {
              role: "system",
              text: "All your data sources are connected! Ready to build your portrait?",
              action: {
                label: "Build Your Portrait",
                message: OPEN_PORTRAIT_ACTION,
              },
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, portraitCta]);
          }
        } catch {
          // best effort
        }
      }
    }

    void persistAndRefreshSessionState();
  }, [isStreaming, activeSessionId, activeSessionKind, messages, refreshSidebar, saveCurrentMessages, setMessages]);

  const handleNewSession = useCallback(() => {
    clearMessages();
    setActiveSessionId(null);
    setActiveSessionKind(null);
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
    if (profile.onboarding_status === "pending") {
      if (activeSessionKind === "setup") {
        setMessages([makeNoDataMessage(activeSessionKind)]);
      } else {
        const nudge = await makeConversationNudgeMessage();
        setMessages([nudge]);
      }
    }
  }, [clearMessages, activeSessionId, activeSessionKind, profile.onboarding_status, saveCurrentMessages, setMessages]);

  const handleLoadSession = useCallback(
    async (sessionId: string) => {
      try {
        const result = await invokeCommand<{
          session: SessionMeta;
          summary: string | null;
        }>("load_session", { sessionId });

        const { session, summary } = result;

        setActiveSessionId(session.id);
        setActiveSessionKind((session.kind ?? "conversation") as "conversation" | "setup" | "portrait");
        sessionIdRef.current = session.id;
        setSessionName(session.name);

        if (session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
          const loadedKind = (session.kind ?? "conversation") as "conversation" | "setup" | "portrait";
          setMessages(
            loadedKind === "setup"
              ? normalizeSetupMessages(session.chatHistory)
              : session.chatHistory
          );
        } else if (profile.onboarding_status === "pending") {
          clearMessages();
          const loadedKind = (session.kind ?? "conversation") as "conversation" | "setup" | "portrait";
          if (loadedKind === "setup") {
            setMessages([makeNoDataMessage(loadedKind)]);
          } else {
            const nudge = await makeConversationNudgeMessage();
            setMessages([nudge]);
          }
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
    [setMessages, clearMessages, profile.onboarding_status]
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
          activeSessionKind={activeSessionKind}
          selectedSources={selectedSources}
          onAddSource={addSourceToProfile}
          onRequestSourceSetup={requestSourceSetup}
          onRemoveSource={removeSourceFromProfile}
        />
      </div>
    </div>
  );
}

export default App;

import { useState, useCallback, useRef, useEffect } from "react";
import { flushSync } from "react-dom";
import { setChatContext, setUserIdentity } from "./lib/diagnostics";
import { ChatView } from "./components/ChatView";
import { SessionSidebar } from "./components/SessionSidebar";
import { UpdateNotification } from "./components/UpdateNotification";
import { OnboardingWelcome } from "./components/OnboardingWelcome";
import { SubscriptionGate } from "./components/SubscriptionGate";
import { DataSourceGrid } from "./components/DataSourceGrid";
import { useStreamChat } from "./hooks/useStreamChat";
import { invokeCommand } from "./lib/tauriBridge";
import type { SessionMeta, Message, SystemMessage, Profile, ImageAttachment, FileAttachment, ContextAttachment, UserMessage as UserMessageType } from "./lib/types";

type AppPhase =
  | { kind: "loading" }
  | { kind: "onboarding-welcome" }
  | { kind: "subscription-gate"; name: string; email: string; authToken: string; profileId?: string }
  | { kind: "onboarding-sources"; name: string; email: string; authToken: string }
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

        if (result.profiles.length === 0) {
          setPhase({ kind: "onboarding-welcome" });
          return;
        }

        const activeId = result.activeProfileId;
        const active = activeId
          ? result.profiles.find((p) => p.id === activeId)
          : result.profiles[0];

        if (active) {
          if (active.auth_token) {
            try {
              const sub = await invokeCommand<{ subscription_status: string }>(
                "cmd_check_subscription",
                { authToken: active.auth_token }
              );
              if (sub.subscription_status === "active") {
                setPhase({ kind: "ready", profile: active });
              } else {
                setPhase({
                  kind: "subscription-gate",
                  name: active.name,
                  email: active.email ?? "",
                  authToken: active.auth_token,
                  profileId: active.id,
                });
              }
            } catch {
              setPhase({ kind: "ready", profile: active });
            }
          } else {
            setPhase({ kind: "ready", profile: active });
          }
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

  async function handleWelcomeNext(name: string, email: string, authToken: string) {
    try {
      const sub = await invokeCommand<{ subscription_status: string }>(
        "cmd_check_subscription",
        { authToken }
      );
      if (sub.subscription_status === "active") {
        setPhase({ kind: "onboarding-sources", name, email, authToken });
      } else {
        setPhase({ kind: "subscription-gate", name, email, authToken });
      }
    } catch {
      setPhase({ kind: "subscription-gate", name, email, authToken });
    }
  }

  async function handleSourcesNext(selectedSources: string[]) {
    if (phase.kind !== "onboarding-sources") return;

    try {
      const profile = await invokeCommand<Profile>("cmd_create_profile", {
        name: phase.name,
        subjectName: phase.name,
        email: phase.email,
        selectedSources: selectedSources,
      });

      await invokeCommand<Profile>("cmd_update_profile", {
        profileId: profile.id,
        authToken: phase.authToken,
      });
      profile.auth_token = phase.authToken;

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

  if (phase.kind === "subscription-gate") {
    return (
      <SubscriptionGate
        authToken={phase.authToken}
        onSubscribed={() => {
          if (phase.profileId) {
            // Returning user whose subscription renewed
            invokeCommand<{ profiles: Profile[]; activeProfileId: string | null }>("list_profiles")
              .then((result) => {
                const profile = result.profiles.find((p) => p.id === phase.profileId);
                if (profile) {
                  setPhase({ kind: "ready", profile });
                }
              })
              .catch(() => {});
          } else {
            setPhase({ kind: "onboarding-sources", name: phase.name, email: phase.email, authToken: phase.authToken });
          }
        }}
        onBack={() => setPhase({ kind: "onboarding-welcome" })}
      />
    );
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
const START_SESSION_ACTION = "__START_SESSION__";
const WRAP_UP_SESSION_MESSAGE = "Let's wrap up. Please write a session summary of what we covered.";
const CONTINUE_SETUP_MESSAGE = "I'm ready to continue connecting my data.";
const PRIVACY_SUBTITLE =
  "Thyself reads your messages to understand your life — your relationships, patterns, and growth. Your data is stored only on this computer.";
const PRIVACY_LEARN_MORE =
  "When you use the app, relevant messages are sent to our AI provider for processing. They do not use your data for training and delete it within 30 days. We're working on zero-day deletion so nothing is kept at all.";

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

async function getSourceConnectionStatus(sources: string[] = ALL_SOURCES): Promise<SourceConnectionStatus> {
  const connected: string[] = [];
  const missing: string[] = [];
  try {
    const status = await invokeCommand<{
      latest_by_source: Record<string, { status: string }>;
    }>("get_sync_status");
    const latest = status.latest_by_source ?? {};
    for (const source of sources) {
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
    missing.push(...sources);
  }
  return { connected, missing, total: sources.length };
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
    subtitle: PRIVACY_SUBTITLE,
    learnMore: PRIVACY_LEARN_MORE,
    action: {
      label: "Get started",
      message: "Let's get my message history set up.",
    },
    timestamp: Date.now(),
  };
}

function makeSourceNudgeMessage(status: SourceConnectionStatus, opts?: { portraitCompleted?: boolean }): SystemMessage | null {
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
  if (status.missing.length === 0) {
    if (opts?.portraitCompleted) {
      return null;
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
  const base: SystemMessage = {
    role: "system",
    text: `You have ${status.connected.length} of ${status.total} data sources connected. Connecting more will give Thyself a richer understanding of your life.`,
    action: {
      label: "Connect more sources",
      message: OPEN_SETUP_ACTION,
    },
    timestamp: Date.now(),
  };
  if (!opts?.portraitCompleted) {
    base.secondaryAction = {
      label: "Build Your Portrait",
      message: OPEN_PORTRAIT_ACTION,
    };
  }
  return base;
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

async function makeConversationNudgeMessage(sources?: string[], opts?: { portraitCompleted?: boolean }): Promise<SystemMessage | null> {
  const status = await getSourceConnectionStatus(sources);
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
  return makeSourceNudgeMessage(status, opts);
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

const LAST_SESSION_KEY = "thyself_last_session_id";

function MainApp({ profile, onProfileSwitch, onNewProfile, onDeleteProfile }: MainAppProps) {
  const [selectedSources, setSelectedSources] = useState<string[]>(profile.selected_sources);
  const [connectedSources, setConnectedSources] = useState<string[]>([]);
  const [activeSessionKind, setActiveSessionKind] = useState<"conversation" | "setup" | "portrait" | null>(null);
  const [portraitStatus, setPortraitStatus] = useState<{
    id: number; status: string; phase?: string; total_batches?: number | null;
    completed_batches?: number | null; synthesis_batches?: number | null;
    synthesis_completed?: number | null; error_message?: string | null;
    started_at?: string | null; updated_at?: string | null; finished_at?: string | null;
    extraction_months_covered?: string | null; results_summary?: string | null;
  } | null>(null);
  const portraitCompleted = portraitStatus?.status === "completed";
  const nudgeOpts = { portraitCompleted };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSessionId, setActiveSessionIdRaw] = useState<string | null>(null);
  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdRaw(id);
    if (id) {
      try { localStorage.setItem(LAST_SESSION_KEY, id); } catch { /* ignore */ }
    }
  }, []);
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  const refreshSidebar = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const handleSessionCompleted = useCallback(async (sessionId: string) => {
    try {
      const result = await invokeCommand<{ session: SessionMeta; summary: string | null }>(
        "load_session", { sessionId }
      );
      if (result.session.status === "completed") {
        sessionMetaCacheRef.current.set(sessionId, {
          readOnly: true, summary: result.summary, name: result.session.name,
          kind: result.session.kind ?? "conversation",
        });
        setSessionSummary(result.summary);
        setSessionName(result.session.name);
        setIsReadOnly(true);
        refreshSidebar();
      }
    } catch (err) {
      console.error("Failed to finalize session:", err);
    }
  }, [refreshSidebar]);

  const { messages, streamingSessionIds, sendMessage, stopStreaming, clearMessages, setMessages, switchToSession, getSessionMessages, isSessionStreaming } =
    useStreamChat({
      subjectName: profile.subject_name,
      onboardingStatus: profile.onboarding_status,
      selectedSources,
      connectedSources,
      activeSessionKind,
      portraitStatus,
      onSessionCompleted: handleSessionCompleted,
    });

  const isStreamingHere = streamingSessionIds.has(activeSessionId ?? "");

  const fetchPortraitStatus = useCallback(async () => {
    try {
      const result = await invokeCommand<typeof portraitStatus>("get_portrait_status");
      setPortraitStatus(result);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchPortraitStatus();
    const shouldPoll = activeSessionKind === "portrait" || portraitStatus?.status === "running";
    const isTerminal = portraitStatus?.status === "completed" || portraitStatus?.status === "failed" || portraitStatus?.status === "cancelled" || portraitStatus?.status === "interrupted";
    if (!shouldPoll || isTerminal) return;
    const interval = setInterval(fetchPortraitStatus, 1000);
    return () => clearInterval(interval);
  }, [activeSessionKind, fetchPortraitStatus, portraitStatus?.status]);

  useEffect(() => {
    const prev = prevPortraitStatusRef.current;
    const curr = portraitStatus?.status ?? null;
    prevPortraitStatusRef.current = curr;

    if (prev === "running" && curr === "completed") {
      if (activeSessionKind === "portrait" && !isStreamingHere) {
        sendMessage("Show me who I am.", undefined, { sessionKind: "portrait" });
      } else {
        pendingIdentitySummaryRef.current = true;
      }
    }
  }, [portraitStatus?.status, activeSessionKind, isStreamingHere, sendMessage]);

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
  const prevPortraitStatusRef = useRef<string | null>(null);
  const pendingIdentitySummaryRef = useRef(false);
  const sessionLoadingRef = useRef(false);

  useEffect(() => {
    async function resumeActiveSession() {
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
              switchToSession(session.id, [...normalizedHistory, restartMsg]);
            } else {
              const welcomeMsg: SystemMessage = {
                role: "system",
                text: "Ready to connect your message history?",
                subtitle: PRIVACY_SUBTITLE,
                learnMore: PRIVACY_LEARN_MORE,
                action: {
                  label: "Let's go",
                  message: "Let's get my message history set up.",
                },
                timestamp: Date.now(),
              };
              switchToSession(session.id, [welcomeMsg]);
            }
            return;
          }

          // Ensure portrait and conversation sessions exist when data is imported
          try {
            await invokeCommand<SessionMeta>("create_session", {
              name: "Build Your Portrait",
              kind: "portrait",
            });
          } catch { /* best effort */ }
          try {
            await invokeCommand<SessionMeta>("create_session", {
              kind: "conversation",
            });
          } catch { /* best effort */ }
          refreshSidebar();
        }

        const manifest = await invokeCommand<SessionMeta[]>("list_sessions");
        let savedId: string | null = null;
        try { savedId = localStorage.getItem(LAST_SESSION_KEY); } catch { /* ignore */ }
        const saved = savedId ? manifest.find((s) => s.id === savedId && s.status === "active") : null;
        const active = saved ?? manifest.find(
          (s) => s.status === "active" && (s.kind ?? "conversation") === "conversation"
        );
        if (active) {
          sessionLoadingRef.current = true;
          setActiveSessionId(active.id);
          setActiveSessionKind((active.kind ?? "conversation") as "conversation" | "setup" | "portrait");
          const full = await invokeCommand<{ session: SessionMeta; summary: string | null }>(
            "load_session", { sessionId: active.id }
          );
          if (Array.isArray(full.session.chatHistory) && full.session.chatHistory.length > 0) {
            switchToSession(active.id, full.session.chatHistory);
          } else if (profile.onboarding_status === "pending") {
            const activeKind = (active.kind ?? "conversation") as "conversation" | "setup" | "portrait";
            if (activeKind === "setup") {
              switchToSession(active.id, [makeNoDataMessage(activeKind)]);
            } else {
              const nudge = await makeConversationNudgeMessage(selectedSources, nudgeOpts);
              switchToSession(active.id, nudge ? [nudge] : []);
            }
          } else {
            switchToSession(active.id, []);
          }
          sessionLoadingRef.current = false;
          const ro = full.session.status === "completed";
          sessionMetaCacheRef.current.set(active.id, {
            readOnly: ro, summary: full.summary, name: full.session.name,
            kind: full.session.kind ?? "conversation",
          });
          setSessionName(full.session.name);
          if (ro) {
            setSessionSummary(full.summary);
            setIsReadOnly(true);
          }
          {
            const status = await getSourceConnectionStatus(selectedSources);
            setConnectedSources(status.connected.filter(s => selectedSources.includes(s)));
          }
        }
      } catch (err) {
        console.error("Failed to resume active session:", err);
      }
    }
    resumeActiveSession();
  }, [switchToSession, profile.id, hasImportedData]);

  const saveCurrentMessages = useCallback(
    async (sessionId: string, msgs: Message[]) => {
      try {
        await invokeCommand("save_session_messages", {
          sessionId,
          messages: msgs,
        });
      } catch (err) {
        console.error("Failed to save session messages:", err);
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
      setSessionName(session.name);

      if (session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
        const normalizedHistory = normalizeSetupMessages(session.chatHistory);
        const last = normalizedHistory[normalizedHistory.length - 1] as Message | undefined;
        const hasSystemCtaAsLast =
          last &&
          last.role === "system" &&
          !!last.action;

        if (hasSystemCtaAsLast) {
          switchToSession(session.id, normalizedHistory);
        } else {
          const status = await getSourceConnectionStatus(selectedSources);
          if (status.connected.length > 0) {
            const nudge = makeSourceNudgeMessage(status, nudgeOpts);
            switchToSession(session.id, nudge ? [...normalizedHistory, nudge] : normalizedHistory);
          } else {
            switchToSession(session.id, [...normalizedHistory, makeSetupContinueMessage()]);
          }
        }
      } else {
        const welcomeMsg: SystemMessage = {
          role: "system",
          text: "Ready to connect your message history?",
          subtitle: PRIVACY_SUBTITLE,
          learnMore: PRIVACY_LEARN_MORE,
          action: {
            label: "Let's go",
            message: "Let's get my message history set up.",
          },
          timestamp: Date.now(),
        };
        switchToSession(session.id, [welcomeMsg]);
      }

      const ro = session.status === "completed";
      sessionMetaCacheRef.current.set(session.id, { readOnly: ro, summary, name: session.name, kind: session.kind ?? "setup" });
      if (ro) {
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
  }, [refreshSidebar, switchToSession, selectedSources]);

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
      setSessionName(session.name);

      const status = await getSourceConnectionStatus(selectedSources);
      setConnectedSources(status.connected.filter(s => selectedSources.includes(s)));

      const hasHistory = session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0;
      if (hasHistory) {
        switchToSession(session.id, session.chatHistory);
      } else {
        const nudge = await makeConversationNudgeMessage(selectedSources, nudgeOpts);
        switchToSession(session.id, nudge ? [nudge] : []);
      }

      const ro = session.status === "completed";
      sessionMetaCacheRef.current.set(session.id, { readOnly: ro, summary, name: session.name, kind: session.kind ?? "portrait" });
      if (ro) {
        setSessionSummary(summary);
        setIsReadOnly(true);
      } else {
        setSessionSummary(null);
        setIsReadOnly(false);
      }
      refreshSidebar();

      const shouldAutoTrigger = pendingIdentitySummaryRef.current ||
        (portraitStatus?.status === "completed" && !hasHistory);
      if (shouldAutoTrigger && !ro) {
        pendingIdentitySummaryRef.current = false;
        setTimeout(() => {
          sendMessage("Show me who I am.", undefined, { sessionKind: "portrait" });
        }, 300);
      }
    } catch (err) {
      console.error("Failed to open portrait session:", err);
    }
  }, [refreshSidebar, selectedSources, switchToSession, portraitStatus?.status, sendMessage]);

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
      options?: { selectedSourcesOverride?: string[]; context?: ContextAttachment[] },
      files?: FileAttachment[]
    ) => {
      if (text === OPEN_SETUP_ACTION) {
        await openSetupSession();
        return;
      }

      if (text === START_SESSION_ACTION) {
        try {
          const session = await invokeCommand<SessionMeta>("create_session", {
            kind: "conversation",
          });
          setActiveSessionId(session.id);
          setActiveSessionKind("conversation");
          setSessionName(session.name);
          setSessionSummary(null);
          setIsReadOnly(false);
          switchToSession(session.id, []);
          refreshSidebar();
        } catch (err) {
          console.error("Failed to start conversation session:", err);
        }
        return;
      }

      if (text === OPEN_PORTRAIT_ACTION) {
        if (activeSessionKind !== "portrait") {
          await openPortraitSession();
        }
        await sendMessage("Let's build my portrait.", undefined, {
          sessionKind: "portrait",
        });
        for (const delay of [1000, 2000, 4000, 8000, 12000]) {
          setTimeout(fetchPortraitStatus, delay);
        }
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
          switchToSession(sid, []);
          refreshSidebar();
        } catch (err) {
          console.error("Failed to create session:", err);
        }
      }

      if (
        profile.onboarding_status === "pending" &&
        (kind ?? "conversation") === "conversation"
      ) {
        const status = await getSourceConnectionStatus(selectedSources);
        if (status.connected.length === 0) {
          const nudge = makeSourceNudgeMessage(status, nudgeOpts);
          if (nudge) setMessages((prev) => [...prev, nudge]);
          return;
        }
        if (status.missing.length > 0) {
          const hasData = await hasImportedData();
          if (!hasData) {
            const nudge = makeSourceNudgeMessage(status, nudgeOpts);
            if (nudge) setMessages((prev) => [...prev, nudge]);
            return;
          }
        }
      }

      await sendMessage(text, images, {
        sessionKind: kind ?? "conversation",
        selectedSourcesOverride: options?.selectedSourcesOverride,
        context: options?.context,
      }, files);
    },
    [
      activeSessionId,
      activeSessionKind,
      fetchPortraitStatus,
      hasImportedData,
      isReadOnly,
      openSetupSession,
      openPortraitSession,
      profile.onboarding_status,
      refreshSidebar,
      sendMessage,
      setMessages,
      switchToSession,
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

  const handleEditMessage = useCallback(
    async (index: number, newContent: string) => {
      if (isReadOnly) return;

      if (isStreamingHere) {
        stopStreaming();
      }

      const original = messages[index];
      if (!original || original.role !== "user") return;
      const um = original as UserMessageType;

      setMessages(messages.slice(0, index));

      await sendMessage(newContent, um.images, {
        sessionKind: activeSessionKind ?? "conversation",
        context: um.context,
      }, um.files);
    },
    [isReadOnly, isStreamingHere, messages, stopStreaming, setMessages, sendMessage, activeSessionKind]
  );

  // Persist incrementally so refresh/crash during long tool runs
  // (e.g. Gmail import) doesn't lose in-flight chat history.
  // Never save to completed (read-only) sessions.
  useEffect(() => {
    if (!activeSessionId || isReadOnly || sessionLoadingRef.current) return;
    const sessionId = activeSessionId;
    const timer = window.setTimeout(() => {
      if (sessionLoadingRef.current) return;
      void saveCurrentMessages(sessionId, messages);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, isReadOnly, messages, saveCurrentMessages]);

  useEffect(() => {
    setChatContext(messages, activeSessionKind ?? "conversation");
  }, [messages, activeSessionKind]);

  useEffect(() => {
    setUserIdentity(profile.subject_name, profile.email);
  }, [profile.subject_name, profile.email]);

  // Detect when any session stops streaming — save its messages and
  // refresh UI state if it was the active session.
  const prevStreamingIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevStreamingIdsRef.current;
    const curr = streamingSessionIds;
    prevStreamingIdsRef.current = new Set(curr);

    for (const id of prev) {
      if (curr.has(id)) continue;

      const msgs = getSessionMessages(id);
      void saveCurrentMessages(id, msgs);

      fetchPortraitStatus();

      if (id === activeSessionId) {
        refreshSidebar();
        void (async () => {
          try {
            const result = await invokeCommand<{
              session: SessionMeta;
              summary: string | null;
            }>("load_session", { sessionId: id });
            const { session, summary } = result;
            const ro = session.status === "completed";
            sessionMetaCacheRef.current.set(id, { readOnly: ro, summary, name: session.name, kind: session.kind ?? "conversation" });
            setSessionName(session.name);
            setSessionSummary(summary);
            setIsReadOnly(ro);
          } catch (err) {
            console.error("Failed to refresh active session state:", err);
          }
        })();
      }
    }
  }, [streamingSessionIds, activeSessionId, getSessionMessages, saveCurrentMessages, refreshSidebar, fetchPortraitStatus]);

  // Delayed CTA for setup sessions: only append once streaming has truly
  // stopped (stayed off for 3 s) to avoid premature CTAs between tool rounds.
  const ctaTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (isStreamingHere || activeSessionKind !== "setup") {
      if (ctaTimerRef.current !== null) {
        window.clearTimeout(ctaTimerRef.current);
        ctaTimerRef.current = null;
      }
      return;
    }

    ctaTimerRef.current = window.setTimeout(async () => {
      ctaTimerRef.current = null;
      try {
        const status = await getSourceConnectionStatus(selectedSources);
        if (status.connected.length > 0) {
          try {
            await invokeCommand<SessionMeta>("create_session", {
              name: "Build Your Portrait",
              kind: "portrait",
            });
          } catch { /* already exists */ }
          try {
            await invokeCommand<SessionMeta>("create_session", {
              kind: "conversation",
            });
          } catch { /* already exists */ }
          refreshSidebar();

          const nudge = makeSourceNudgeMessage(status, nudgeOpts);
          if (nudge) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "system" && !!(last as SystemMessage).action) {
                return [...prev.slice(0, -1), nudge];
              }
              return [...prev, nudge];
            });
          }
        }
      } catch {
        // best effort
      }
    }, 3000);

    return () => {
      if (ctaTimerRef.current !== null) {
        window.clearTimeout(ctaTimerRef.current);
        ctaTimerRef.current = null;
      }
    };
  }, [isStreamingHere, activeSessionKind, selectedSources, refreshSidebar, setMessages]);

  // Show a "Wrap up" button after enough conversation turns.
  // Only shown once per session — tracks the last turn count it fired on
  // so it doesn't re-appear after every subsequent response.
  const WRAP_UP_TURN_THRESHOLD = 4;
  const WRAP_UP_REPEAT_INTERVAL = 3;
  const wrapUpTimerRef = useRef<number | null>(null);
  const wrapUpLastShownAtRef = useRef<number>(0);
  useEffect(() => {
    if (isStreamingHere || activeSessionKind !== "conversation" || isReadOnly) {
      if (wrapUpTimerRef.current !== null) {
        window.clearTimeout(wrapUpTimerRef.current);
        wrapUpTimerRef.current = null;
      }
      return;
    }

    const userTurnCount = messages.filter(m => m.role === "user").length;
    if (userTurnCount < WRAP_UP_TURN_THRESHOLD) return;

    const nextShowAt = wrapUpLastShownAtRef.current === 0
      ? WRAP_UP_TURN_THRESHOLD
      : wrapUpLastShownAtRef.current + WRAP_UP_REPEAT_INTERVAL;
    if (userTurnCount < nextShowAt) return;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "system") return;

    const targetSessionId = activeSessionId;
    wrapUpTimerRef.current = window.setTimeout(() => {
      wrapUpTimerRef.current = null;
      if (activeSessionId !== targetSessionId) return;
      wrapUpLastShownAtRef.current = userTurnCount;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "system") return prev;
        const wrapUp: SystemMessage = {
          role: "system",
          text: "Ready to wrap up this session?",
          action: {
            label: "Wrap up",
            message: WRAP_UP_SESSION_MESSAGE,
          },
          timestamp: Date.now(),
        };
        return [...prev, wrapUp];
      });
    }, 3000);

    return () => {
      if (wrapUpTimerRef.current !== null) {
        window.clearTimeout(wrapUpTimerRef.current);
        wrapUpTimerRef.current = null;
      }
    };
  }, [isStreamingHere, activeSessionId, activeSessionKind, isReadOnly, messages, setMessages]);

  const handleNewSession = useCallback(async () => {
    const oldSessionId = activeSessionId;
    const oldMessages = messages;

    const hasUserMessages = oldSessionId && oldMessages.some(m => m.role === "user");

    if (hasUserMessages) {
      try {
        await saveCurrentMessages(oldSessionId, oldMessages);
        await invokeCommand("close_and_summarize_session", { sessionId: oldSessionId });
      } catch (err) {
        console.error("Failed to close old session:", err);
      }
    }

    wrapUpLastShownAtRef.current = 0;

    try {
      const session = await invokeCommand<SessionMeta>("create_session", {
        kind: "conversation",
      });
      setActiveSessionId(session.id);
      setActiveSessionKind("conversation");
      setSessionSummary(null);
      setSessionName(null);
      setIsReadOnly(false);
      switchToSession(session.id, []);
      refreshSidebar();
    } catch (err) {
      console.error("Failed to create new session:", err);
      switchToSession(null, []);
      setActiveSessionId(null);
      setActiveSessionKind(null);
      setSessionSummary(null);
      setSessionName(null);
      setIsReadOnly(false);
    }
  }, [activeSessionId, messages, saveCurrentMessages, switchToSession, refreshSidebar]);

  const handleClearSession = useCallback(async () => {
    clearMessages();
    if (activeSessionId) {
      await saveCurrentMessages(activeSessionId, []);
    }
    if (profile.onboarding_status === "pending") {
      if (activeSessionKind === "setup") {
        setMessages([makeNoDataMessage(activeSessionKind)]);
      } else {
        const nudge = await makeConversationNudgeMessage(selectedSources, nudgeOpts);
        if (nudge) setMessages([nudge]);
      }
    }
  }, [clearMessages, activeSessionId, activeSessionKind, profile.onboarding_status, selectedSources, saveCurrentMessages, setMessages]);

  const loadRequestRef = useRef(0);
  const sessionMetaCacheRef = useRef<Map<string, { readOnly: boolean; summary: string | null; name: string; kind: string }>>(new Map());

  const handleLoadSession = useCallback(
    async (sessionId: string) => {
      const requestId = ++loadRequestRef.current;
      const isStale = () => loadRequestRef.current !== requestId;

      wrapUpLastShownAtRef.current = 0;
      sessionLoadingRef.current = true;

      // Force React to commit all session-switch state updates to the DOM
      // synchronously so there is zero chance of a stale-content frame.
      const cachedMeta = sessionMetaCacheRef.current.get(sessionId);
      flushSync(() => {
        setActiveSessionId(sessionId);
        switchToSession(sessionId);
        if (cachedMeta) {
          setActiveSessionKind(cachedMeta.kind as "conversation" | "setup" | "portrait");
          setIsReadOnly(cachedMeta.readOnly);
          setSessionSummary(cachedMeta.summary);
          setSessionName(cachedMeta.name);
        } else {
          setActiveSessionKind("conversation");
          setIsReadOnly(false);
          setSessionSummary(null);
          setSessionName(null);
        }
      });

      try {
        const result = await invokeCommand<{
          session: SessionMeta;
          summary: string | null;
        }>("load_session", { sessionId });
        if (isStale()) { sessionLoadingRef.current = false; return; }

        const { session, summary } = result;
        const ro = session.status === "completed";
        sessionMetaCacheRef.current.set(sessionId, { readOnly: ro, summary, name: session.name, kind: session.kind ?? "conversation" });

        setActiveSessionKind((session.kind ?? "conversation") as "conversation" | "setup" | "portrait");
        setSessionName(session.name);
        setSessionSummary(summary);
        setIsReadOnly(ro);

        // If we already showed cached messages, no need to reload them.
        if (getSessionMessages(sessionId).length > 0 || isSessionStreaming(sessionId)) {
          sessionLoadingRef.current = false;
          return;
        }

        // First load — populate messages from backend.
        if (session.chatHistory && Array.isArray(session.chatHistory) && session.chatHistory.length > 0) {
          const loadedKind = (session.kind ?? "conversation") as "conversation" | "setup" | "portrait";
          const normalized = loadedKind === "setup"
            ? normalizeSetupMessages(session.chatHistory)
            : session.chatHistory;

          if (loadedKind === "setup") {
            const last = normalized[normalized.length - 1] as Message | undefined;
            const hasSystemCtaAsLast = last && last.role === "system" && !!last.action;
            if (hasSystemCtaAsLast || isSessionStreaming(session.id)) {
              switchToSession(session.id, normalized);
            } else {
              const status = await getSourceConnectionStatus(selectedSources);
              if (isStale()) return;
              if (status.connected.length > 0) {
                const nudge = makeSourceNudgeMessage(status, nudgeOpts);
                switchToSession(session.id, nudge ? [...normalized, nudge] : normalized);
              } else {
                switchToSession(session.id, [...normalized, makeSetupContinueMessage()]);
              }
            }
          } else {
            switchToSession(session.id, normalized);
          }
        } else if (profile.onboarding_status === "pending") {
          const loadedKind = (session.kind ?? "conversation") as "conversation" | "setup" | "portrait";
          if (loadedKind === "setup") {
            switchToSession(session.id, [makeNoDataMessage(loadedKind)]);
          } else {
            const nudge = await makeConversationNudgeMessage(selectedSources, nudgeOpts);
            if (isStale()) return;
            switchToSession(session.id, nudge ? [nudge] : []);
          }
        } else {
          switchToSession(session.id, []);

          const loadedKind = (session.kind ?? "conversation") as "conversation" | "setup" | "portrait";
          if (loadedKind === "portrait" && (pendingIdentitySummaryRef.current || portraitStatus?.status === "completed") && !ro) {
            pendingIdentitySummaryRef.current = false;
            setTimeout(() => {
              sendMessage("Show me who I am.", undefined, { sessionKind: "portrait" });
            }, 300);
          }
        }
      } catch (err) {
        console.error("Failed to load session:", err);
      } finally {
        sessionLoadingRef.current = false;
      }
    },
    [switchToSession, getSessionMessages, isSessionStreaming, profile.onboarding_status, selectedSources, portraitStatus?.status, sendMessage]
  );

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <UpdateNotification />
      <div className="flex flex-1 min-h-0">
        <SessionSidebar
          onNewSession={handleNewSession}
          onLoadSession={handleLoadSession}
          activeSessionId={activeSessionId}
          streamingSessionIds={streamingSessionIds}
          portraitBuildRunning={portraitStatus?.status === "running"}
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
          isStreaming={isStreamingHere}
          onSend={handleSend}
          onStop={stopStreaming}
          onClear={!isReadOnly ? handleClearSession : undefined}
          sessionSummary={sessionSummary}
          sessionName={sessionName}
          isReadOnly={isReadOnly}
          activeSessionKind={activeSessionKind}
          selectedSources={selectedSources}
          connectedSources={connectedSources}
          onAddSource={addSourceToProfile}
          onRequestSourceSetup={requestSourceSetup}
          onRemoveSource={removeSourceFromProfile}
          portraitStatus={portraitStatus as any}
          onPortraitRefresh={fetchPortraitStatus}
          onEditMessage={handleEditMessage}
        />
      </div>
    </div>
  );
}

export default App;

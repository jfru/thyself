import { useState, useCallback, useRef } from "react";
import { ChatView } from "./components/ChatView";
import { SessionSidebar } from "./components/SessionSidebar";
import { useStreamChat } from "./hooks/useStreamChat";
import { invokeCommand } from "./lib/tauriBridge";
import type { SessionMeta, Message } from "./lib/types";

function App() {
  const sessionIdRef = useRef<string | null>(null);
  const { messages, isStreaming, sendMessage, stopStreaming, clearMessages, setMessages } =
    useStreamChat(sessionIdRef);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionSummary, setSessionSummary] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  const refreshSidebar = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const saveCurrentMessages = useCallback(
    async (sessionId: string, msgs: Message[]) => {
      try {
        await invokeCommand("save_session_messages", {
          sessionId,
          messages: msgs,
        });
      } catch {
        // best-effort persistence
      }
    },
    []
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (isReadOnly) return;

      let sid = activeSessionId;

      // Create a new session on first message if none active
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

      await sendMessage(text);
    },
    [activeSessionId, isReadOnly, sendMessage, refreshSidebar]
  );

  // Save messages whenever streaming stops
  const prevStreamingRef = useRef(isStreaming);
  if (prevStreamingRef.current && !isStreaming && activeSessionId) {
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
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <SessionSidebar
        onNewSession={handleNewSession}
        onLoadSession={handleLoadSession}
        activeSessionId={activeSessionId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        refreshKey={sidebarRefreshKey}
      />
      <ChatView
        messages={messages}
        isStreaming={isStreaming}
        onSend={handleSend}
        onStop={stopStreaming}
        sessionSummary={sessionSummary}
        sessionName={sessionName}
        isReadOnly={isReadOnly}
      />
    </div>
  );
}

export default App;

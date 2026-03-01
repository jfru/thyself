import { useState, useCallback } from "react";
import { ChatView } from "./components/ChatView";
import { SessionSidebar } from "./components/SessionSidebar";
import { useStreamChat } from "./hooks/useStreamChat";

function App() {
  const { messages, isStreaming, sendMessage, stopStreaming, clearMessages } = useStreamChat();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const handleNewSession = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

  const handleLoadSession = useCallback((_filename: string) => {
    // Future: load session context into chat
  }, []);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <SessionSidebar
        onNewSession={handleNewSession}
        onLoadSession={handleLoadSession}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <ChatView
        messages={messages}
        isStreaming={isStreaming}
        onSend={sendMessage}
        onStop={stopStreaming}
      />
    </div>
  );
}

export default App;

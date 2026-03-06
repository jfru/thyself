export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  isStreaming: boolean;
  startTime?: number;
  endTime?: number;
}

export interface Citation {
  type: "web_search_result_location";
  url: string;
  title: string;
  cited_text: string;
  encrypted_index?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
  isStreaming: boolean;
  citations?: Citation[];
}

export interface WebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  page_age?: string;
  encrypted_content?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson: string;
  status: "running" | "complete" | "error";
  result?: string;
  isError?: boolean;
  searchResults?: WebSearchResult[];
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock;

export interface UserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  blocks: ContentBlock[];
  isStreaming: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage;

export interface StreamEvent {
  event_type: string;
  data: {
    index?: number;
    content_block?: {
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
    };
    text?: string;
    thinking?: string;
    partial_json?: string;
    tool_use_id?: string;
    tool_name?: string;
    content?: string;
    is_error?: boolean;
    [key: string]: unknown;
  };
}

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  status: "active" | "completed";
  summaryFile: string | null;
  chatHistory: Message[];
}

export interface Session {
  filename: string;
  title: string;
  date: string;
  preview: string;
}

export interface SyncRun {
  id?: number;
  source: string;
  started_at: string | null;
  finished_at: string | null;
  messages_added: number;
  status: string;
  error_message: string | null;
  last_message_at: string | null;
}

export interface SyncStatus {
  latest_by_source: Record<string, SyncRun>;
  history: SyncRun[];
  has_sync_runs: boolean;
}

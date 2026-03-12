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

export interface ImageAttachment {
  data: string; // base64-encoded
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  name: string;
}

export interface FileAttachment {
  type: "file" | "folder";
  path: string;
  name: string;
}

export interface UserMessage {
  role: "user";
  content: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  blocks: ContentBlock[];
  isStreaming: boolean;
  timestamp: number;
}

export interface SystemMessage {
  role: "system";
  text: string;
  action?: {
    label: string;
    message: string;
  };
  secondaryAction?: {
    label: string;
    message: string;
  };
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

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

export interface Profile {
  id: string;
  name: string;
  data_dir: string;
  api_key: string;
  subject_name: string;
  email: string | null;
  selected_sources: string[];
  onboarding_status: "pending" | "ingesting" | "extracting" | "complete";
  createdAt: string;
}

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  status: "active" | "completed";
  kind?: "conversation" | "setup" | "portrait";
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
  progress_processed?: number | null;
  progress_total?: number | null;
  status: string;
  error_message: string | null;
  last_message_at: string | null;
}

export interface SyncStatus {
  latest_by_source: Record<string, SyncRun>;
  history: SyncRun[];
  has_sync_runs: boolean;
}

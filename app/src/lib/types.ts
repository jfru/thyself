export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  isStreaming: boolean;
  startTime?: number;
  endTime?: number;
}

export interface TextBlock {
  type: "text";
  text: string;
  isStreaming: boolean;
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

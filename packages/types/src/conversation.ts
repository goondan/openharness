import type { ToolResult, JsonObject } from "./tool.js";

// MessageContent building blocks
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "tool_use"; toolName: string; args: JsonObject; toolCallId: string }
  | { type: "tool_result"; toolCallId: string; result: ToolResult };

export type MessageContent = string | ContentPart[];

// Message
export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  metadata?: Record<string, unknown>;
}

// MessageEvent
export type MessageEvent =
  | { type: "append"; message: Message }
  | { type: "replace"; messageId: string; message: Message }
  | { type: "remove"; messageId: string }
  | { type: "truncate"; keepLast: number };

// ConversationState
export interface ConversationState {
  readonly events: readonly MessageEvent[];
  readonly messages: readonly Message[];
  restore(events: MessageEvent[]): void;
  /** Only callable during Turn execution (middleware context) */
  emit(event: MessageEvent): void;
}

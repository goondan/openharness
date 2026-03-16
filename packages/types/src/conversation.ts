import type { ModelMessage } from "ai";

// Message
export interface Message {
  id: string;
  data: ModelMessage;
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

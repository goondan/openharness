import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";

// Message
export interface Message<TData extends ModelMessage = ModelMessage> {
  id: string;
  data: TData;
  metadata?: Record<string, unknown>;
}

export type SystemMessage = Message<SystemModelMessage>;
export type NonSystemMessage = Message<
  UserModelMessage | AssistantModelMessage | ToolModelMessage
>;

// MessageEvent
export type MessageEvent =
  | { type: "appendSystem"; message: SystemMessage }
  | { type: "appendMessage"; message: NonSystemMessage }
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

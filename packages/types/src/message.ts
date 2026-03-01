import type { JsonValue } from "./json.js";

export interface CoreMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: unknown;
  readonly [key: string]: unknown;
}

export type MessageSource =
  | { type: "user" }
  | { type: "assistant"; stepId: string }
  | { type: "tool"; toolCallId: string; toolName: string }
  | { type: "system" }
  | { type: "extension"; extensionName: string };

export interface Message {
  readonly id: string;
  readonly data: CoreMessage;
  metadata: Record<string, JsonValue>;
  readonly createdAt: Date;
  readonly source: MessageSource;
}

export type MessageEvent =
  | { type: "append"; message: Message }
  | { type: "replace"; targetId: string; message: Message }
  | { type: "remove"; targetId: string }
  | { type: "truncate" };

export interface ConversationState {
  readonly baseMessages: Message[];
  readonly events: MessageEvent[];
  readonly nextMessages: Message[];
  toLlmMessages(): CoreMessage[];
}

export function applyMessageEvent(messages: readonly Message[], event: MessageEvent): Message[] {
  if (event.type === "append") {
    return [...messages, event.message];
  }

  if (event.type === "replace") {
    const nextMessages: Message[] = [];
    let replaced = false;

    for (const message of messages) {
      if (!replaced && message.id === event.targetId) {
        nextMessages.push(event.message);
        replaced = true;
        continue;
      }
      nextMessages.push(message);
    }

    return nextMessages;
  }

  if (event.type === "remove") {
    const nextMessages: Message[] = [];
    for (const message of messages) {
      if (message.id !== event.targetId) {
        nextMessages.push(message);
      }
    }
    return nextMessages;
  }

  return [];
}

export function foldMessageEvents(baseMessages: readonly Message[], events: readonly MessageEvent[]): Message[] {
  let nextMessages: Message[] = [...baseMessages];
  for (const event of events) {
    nextMessages = applyMessageEvent(nextMessages, event);
  }
  return nextMessages;
}

export function createConversationState(baseMessages: readonly Message[], events: readonly MessageEvent[]): ConversationState {
  const normalizedBaseMessages = [...baseMessages];
  const normalizedEvents = [...events];
  const nextMessages = foldMessageEvents(normalizedBaseMessages, normalizedEvents);

  return {
    baseMessages: normalizedBaseMessages,
    events: normalizedEvents,
    nextMessages,
    toLlmMessages() {
      return nextMessages.map((message) => message.data);
    },
  };
}


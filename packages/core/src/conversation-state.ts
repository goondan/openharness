import type { ConversationState, Message, MessageEvent } from "@goondan/openharness-types";

/**
 * Implementation of ConversationState using event sourcing.
 *
 * - events is the sole source of truth (append-only)
 * - messages is derived by replaying events
 * - emit() only works during Turn execution (_turnActive must be true)
 * - restore() replaces the entire event stream and replays from scratch
 */
export class ConversationStateImpl implements ConversationState {
  /** Append-only event stream — the source of truth */
  _events: MessageEvent[] = [];

  /** Derived message list from replaying _events */
  private _messages: Message[] = [];

  /** Guards emit() — must be true during Turn execution */
  _turnActive: boolean = false;

  get events(): readonly MessageEvent[] {
    return this._events;
  }

  get messages(): readonly Message[] {
    return this._messages;
  }

  /**
   * Emit a MessageEvent. Only callable during Turn execution.
   * Validates the event before appending; throws on invalid references.
   */
  emit(event: MessageEvent): void {
    if (!this._turnActive) {
      throw new Error(
        "emit() can only be called during Turn execution (inside middleware context). " +
          "Turn is not currently active.",
      );
    }

    // Validate event before appending (do NOT mutate events on error)
    validateEventAgainstMessages(event, this._messages);

    // Append to events stream
    this._events.push(event);

    if (event.type === "appendSystem") {
      this._messages = insertSystemMessage(this._messages, event.message);
      return;
    }

    if (event.type === "appendMessage") {
      this._messages = appendNonSystemMessage(this._messages, event.message);
      return;
    }

    // Full replay for replace/remove/truncate
    this._messages = replay(this._events);
  }

  /**
   * Replace the entire event stream and recompute messages.
   * Throws if replay fails; preserves original state on error.
   */
  restore(events: MessageEvent[]): void {
    const newMessages = replay(events);

    this._events = [...events];
    this._messages = newMessages;
  }
}

/**
 * Deterministic replay function: given a sequence of MessageEvents,
 * produce the derived messages array.
 *
 * This is a pure function — same events → same messages.
 */
export function replay(events: readonly MessageEvent[]): Message[] {
  const messages: Message[] = [];

  for (const event of events) {
    validateEventAgainstMessages(event, messages, "replay");

    switch (event.type) {
      case "appendSystem": {
        const nextMessages = insertSystemMessage(messages, event.message);
        messages.splice(0, messages.length, ...nextMessages);
        break;
      }
      case "appendMessage": {
        const nextMessages = appendNonSystemMessage(messages, event.message);
        messages.splice(0, messages.length, ...nextMessages);
        break;
      }
      case "replace": {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        messages[idx] = event.message;
        break;
      }
      case "remove": {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        messages.splice(idx, 1);
        break;
      }
      case "truncate": {
        const { keepLast } = event;
        if (messages.length > keepLast) {
          messages.splice(0, messages.length - keepLast);
        }
        break;
      }
    }
  }

  return messages;
}

function insertSystemMessage(messages: readonly Message[], message: Message): Message[] {
  const next = [...messages];
  const firstNonSystemIndex = next.findIndex((item) => item.data.role !== "system");

  if (firstNonSystemIndex === -1) {
    next.push(message);
    return next;
  }

  next.splice(firstNonSystemIndex, 0, message);
  return next;
}

function appendNonSystemMessage(messages: readonly Message[], message: Message): Message[] {
  const next = [...messages];
  next.push(message);
  return next;
}

function validateEventAgainstMessages(
  event: MessageEvent,
  messages: readonly Message[],
  source: "emit" | "replay" = "emit",
): void {
  switch (event.type) {
    case "appendSystem":
      assertSystemRole(event.message, event.type, source);
      return;
    case "appendMessage":
      assertNonSystemRole(event.message, event.type, source);
      return;
    case "replace": {
      const existing = messages.find((message) => message.id === event.messageId);
      if (!existing) {
        throw new Error(
          `${source}: replace references non-existent message id "${event.messageId}".`,
        );
      }
      if (existing.data.role !== event.message.data.role) {
        throw new Error(
          `${source}: replace cannot change role from "${existing.data.role}" to "${event.message.data.role}" for message id "${event.messageId}". ` +
            "Use remove + appendSystem/appendMessage instead.",
        );
      }
      return;
    }
    case "remove": {
      const exists = messages.some((message) => message.id === event.messageId);
      if (!exists) {
        throw new Error(
          `${source}: remove references non-existent message id "${event.messageId}".`,
        );
      }
      return;
    }
    case "truncate":
      if (event.keepLast < 0) {
        throw new Error(
          `${source}: truncate keepLast must be >= 0, got ${event.keepLast}.`,
        );
      }
      return;
  }
}

function assertSystemRole(message: Message, eventType: "appendSystem", source: "emit" | "replay"): void {
  if (message.data.role !== "system") {
    throw new Error(
      `${source}: ${eventType} requires role "system", got "${message.data.role}".`,
    );
  }
}

function assertNonSystemRole(
  message: Message,
  eventType: "appendMessage",
  source: "emit" | "replay",
): void {
  if (message.data.role === "system") {
    throw new Error(
      `${source}: ${eventType} does not accept role "system". Use appendSystem instead.`,
    );
  }
}

/**
 * Factory function for creating a new ConversationState instance.
 */
export function createConversationState(): ConversationStateImpl {
  return new ConversationStateImpl();
}

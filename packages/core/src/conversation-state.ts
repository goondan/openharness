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
    this._validateEvent(event);

    // Append to events stream
    this._events.push(event);

    // Incremental optimization: for append events we can apply directly
    // without full replay. For other mutations we do a full replay to
    // ensure correctness (the messages array may need non-trivial changes).
    if (event.type === "append") {
      this._messages.push(event.message);
    } else {
      // Full replay for replace/remove/truncate
      this._messages = replay(this._events);
    }
  }

  /**
   * Replace the entire event stream and recompute messages.
   * Throws if replay fails; preserves original state on error.
   */
  restore(events: MessageEvent[]): void {
    // Attempt replay on the new events first — if it throws, existing state is preserved
    const newMessages = replay(events);

    // Only mutate state after successful replay
    this._events = [...events];
    this._messages = newMessages;
  }

  /**
   * Validates an event against the current message state before appending.
   * Throws descriptive errors on invalid references.
   */
  private _validateEvent(event: MessageEvent): void {
    if (event.type === "replace") {
      const exists = this._messages.some((m) => m.id === event.messageId);
      if (!exists) {
        throw new Error(
          `replace: message with id "${event.messageId}" does not exist in current conversation state.`,
        );
      }
    } else if (event.type === "remove") {
      const exists = this._messages.some((m) => m.id === event.messageId);
      if (!exists) {
        throw new Error(
          `remove: message with id "${event.messageId}" does not exist in current conversation state.`,
        );
      }
    }
    if (event.type === "truncate") {
      if (event.keepLast < 0) {
        throw new Error(
          `truncate: keepLast must be >= 0, got ${event.keepLast}.`,
        );
      }
    }
    // append is always valid
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
    switch (event.type) {
      case "append": {
        messages.push(event.message);
        break;
      }
      case "replace": {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        if (idx === -1) {
          throw new Error(
            `replay: replace references non-existent message id "${event.messageId}".`,
          );
        }
        messages[idx] = event.message;
        break;
      }
      case "remove": {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        if (idx === -1) {
          throw new Error(
            `replay: remove references non-existent message id "${event.messageId}".`,
          );
        }
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

/**
 * Factory function for creating a new ConversationState instance.
 */
export function createConversationState(): ConversationStateImpl {
  return new ConversationStateImpl();
}

import {
  CREATED_BY_METADATA_KEY,
  type ConversationState,
  type Message,
  type MessageEvent,
} from "@goondan/openharness-types";

/**
 * Implementation of ConversationState using event sourcing.
 *
 * - `_events` is the sole source of truth (append-only). Its serialized bytes
 *   stay byte-identical to the original log — createdBy lifting is applied only
 *   to the derived `getMessages()` view, never to `_events`.
 * - `_messages` is derived by replaying `_events`, with createdBy lifted from
 *   `metadata.__createdBy` for legacy (0.5) messages, and is exposed as an
 *   `Object.freeze`d immutable snapshot.
 * - `append()` is the single write path. It is synchronous — the next
 *   `getMessages()` reflects it immediately — and never touches the EventBus.
 *   It is always allowed (no turn-active gating).
 * - `restore()` replaces the entire event stream and replays from scratch.
 */
export class ConversationStateImpl implements ConversationState {
  /** Append-only event stream — the source of truth (bytes never lifted). */
  _events: MessageEvent[] = [];

  /** Derived, frozen message snapshot from replaying `_events` (createdBy lifted). */
  private _messages: readonly Message[] = Object.freeze([]);

  getEventLog(): readonly MessageEvent[] {
    return this._events;
  }

  getMessages(): readonly Message[] {
    return this._messages;
  }

  /**
   * Append a MessageEvent. Validates first (lenient: missing-id remove/replace
   * are idempotent no-ops), then appends to the event stream and recomputes the
   * frozen derived snapshot. Always allowed.
   */
  append(event: MessageEvent): void {
    // Validate before mutating (do NOT mutate `_events` on a hard error).
    validateEventAgainstMessages(event, this._messages);

    this._events.push(event);
    this._messages = freeze(replay(this._events));
  }

  /**
   * Replace the entire event stream and recompute messages. Preserves the input
   * `events` array byte-for-byte (lifting applies only to the derived view).
   */
  restore(events: MessageEvent[]): void {
    const next = [...events];
    const derived = freeze(replay(next));
    this._events = next;
    this._messages = derived;
  }
}

/** Recursively freeze a value and everything it transitively owns. A frozen
 *  node is treated as fully frozen already, keeping this O(new objects). */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}

function freeze(messages: Message[]): readonly Message[] {
  // Deep-freeze each derived message — including nested payloads like
  // `data.content` arrays — not just the array. A derived message can share its
  // `data`/`metadata` (and their nested objects) with a source event (lifting
  // only shallow-copies the top level), so a consumer pushing into `data.content`
  // would otherwise mutate the shared object and corrupt `_events`/replay.
  for (const message of messages) deepFreeze(message);
  return Object.freeze(messages);
}

/**
 * Read-compat lifting (0.5): legacy logs carry `metadata.__createdBy` but no
 * `createdBy` field. When building a *derived* message, lift it onto a shallow
 * copy so the source event object stays byte-identical. Messages that already
 * have `createdBy`, or that lack a string `__createdBy`, are returned as-is.
 */
function liftCreatedBy(message: Message): Message {
  if (message.createdBy !== undefined) return message;
  const mirrored = message.metadata?.[CREATED_BY_METADATA_KEY];
  if (typeof mirrored !== "string") return message;
  return { ...message, createdBy: mirrored };
}

/**
 * Deterministic replay: given a sequence of MessageEvents, produce the derived
 * messages array. Pure — same events → same messages. Derived messages have
 * `createdBy` lifted from legacy metadata; source events are never mutated.
 *
 * Lenient like `append`: remove/replace against a non-existent id are idempotent
 * no-ops rather than errors.
 */
export function replay(events: readonly MessageEvent[]): Message[] {
  const messages: Message[] = [];

  for (const event of events) {
    validateEventAgainstMessages(event, messages, "replay");

    switch (event.type) {
      case "appendSystem": {
        const nextMessages = insertSystemMessage(messages, liftCreatedBy(event.message));
        messages.splice(0, messages.length, ...nextMessages);
        break;
      }
      case "appendMessage": {
        const nextMessages = appendNonSystemMessage(messages, liftCreatedBy(event.message));
        messages.splice(0, messages.length, ...nextMessages);
        break;
      }
      case "replace": {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        // Idempotent no-op when the id is absent.
        if (idx !== -1) messages[idx] = liftCreatedBy(event.message);
        break;
      }
      case "remove": {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        // Idempotent no-op when the id is absent.
        if (idx !== -1) messages.splice(idx, 1);
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

/**
 * Validate an event against current messages.
 *
 * Robustness (spec): remove/replace against a non-existent message id is no
 * longer a throw — it is a tolerated, idempotent no-op (the actual no-op happens
 * in `replay`). Role-correctness for append/replace and a non-negative
 * `keepLast` for truncate remain hard errors, since those indicate a malformed
 * event rather than stale state.
 */
function validateEventAgainstMessages(
  event: MessageEvent,
  messages: readonly Message[],
  source: "append" | "replay" = "append",
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
      // Missing id = idempotent no-op (handled in replay); nothing to validate.
      if (!existing) return;
      if (existing.data.role !== event.message.data.role) {
        throw new Error(
          `${source}: replace cannot change role from "${existing.data.role}" to "${event.message.data.role}" for message id "${event.messageId}". ` +
            "Use remove + appendSystem/appendMessage instead.",
        );
      }
      return;
    }
    case "remove":
      // Missing id = idempotent no-op; nothing to validate.
      return;
    case "truncate":
      if (event.keepLast < 0) {
        throw new Error(
          `${source}: truncate keepLast must be >= 0, got ${event.keepLast}.`,
        );
      }
      return;
  }
}

function assertSystemRole(
  message: Message,
  eventType: "appendSystem",
  source: "append" | "replay",
): void {
  if (message.data.role !== "system") {
    throw new Error(
      `${source}: ${eventType} requires role "system", got "${message.data.role}".`,
    );
  }
}

function assertNonSystemRole(
  message: Message,
  eventType: "appendMessage",
  source: "append" | "replay",
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

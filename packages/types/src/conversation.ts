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
  /**
   * Who created this message (F3). Optional only for legacy replay — every
   * newly authored message should set it, ideally via {@link createMessage}.
   * Through 1.x the value is mirrored into `metadata.__createdBy`; the field is
   * authoritative on conflict.
   */
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

// -----------------------------------------------------------------------
// Provenance helpers (F3)
// -----------------------------------------------------------------------

/** Author tag for messages the core runtime emits (user/assistant/tool). */
export const CORE_CREATED_BY = "core";
/**
 * Sentinel for messages with no recorded author (pre-F3 logs). Read-only — it
 * is never written. `getCreatedBy` returns it as a fallback; do not pass it to
 * `createMessage`.
 */
export const UNKNOWN_CREATED_BY = "unknown";
/** Metadata key the createdBy field is mirrored into during the 1.x window. */
export const CREATED_BY_METADATA_KEY = "__createdBy";

export interface CreateMessageInput<TData extends ModelMessage = ModelMessage> {
  /** Defaults to a fresh UUID. */
  id?: string;
  data: TData;
  /** Required — the authoring extension/runtime tag. */
  createdBy: string;
  metadata?: Record<string, unknown>;
}

/**
 * Construct a fully-provenanced message. Sets the `createdBy` field and
 * force-mirrors it into `metadata.__createdBy`, *ignoring* any incoming
 * `__createdBy` in `metadata` (the explicit `createdBy` argument always wins).
 */
export function createMessage<TData extends ModelMessage = ModelMessage>(
  input: CreateMessageInput<TData>,
): Message<TData> {
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  metadata[CREATED_BY_METADATA_KEY] = input.createdBy;
  return {
    id: input.id ?? globalThis.crypto.randomUUID(),
    data: input.data,
    createdBy: input.createdBy,
    metadata,
  };
}

/**
 * Resolve a message's author. Prefers the field, falls back to the mirrored
 * metadata key, then {@link UNKNOWN_CREATED_BY} for legacy messages.
 */
export function getCreatedBy(message: Message): string {
  if (message.createdBy !== undefined) return message.createdBy;
  const mirrored = message.metadata?.[CREATED_BY_METADATA_KEY];
  return typeof mirrored === "string" ? mirrored : UNKNOWN_CREATED_BY;
}

export function isCreatedBy(message: Message, who: string): boolean {
  return getCreatedBy(message) === who;
}

/**
 * True when a message was injected by a known extension rather than produced by
 * the core conversational flow. `unknown` (legacy) counts as non-synthetic — a
 * safe default so old logs are never mistakenly stripped.
 */
export function isSynthetic(message: Message): boolean {
  const who = getCreatedBy(message);
  return who !== CORE_CREATED_BY && who !== UNKNOWN_CREATED_BY;
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

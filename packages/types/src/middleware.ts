import type { ConversationState, Message } from "./conversation.js";
import type { ToolResult, ToolDefinition, JsonObject } from "./tool.js";
import type { InboundEnvelope } from "./ingress.js";
import type { ExtensionStore } from "./store.js";

// Middleware level discriminant.
//
// `route` is a core-internal level used by ingress routing inside connection
// extensions; it is NOT exposed on the extension surface (no `useRoute`). It
// stays here so ingress/router internals keep type-checking.
export type MiddlewareLevel =
  | "turn"
  | "step"
  | "toolCall"
  | "ingress"
  | "route";

/**
 * Declarative placement for a middleware registration. There is no numeric
 * priority and no phase band: ordering is `before`/`after` edges plus the `'*'`
 * sentinel, otherwise registration order.
 *
 * `before`/`after` are **entry order**: "A before B" ⇒ A enters before B (and,
 * because of the onion, A's post-`next()` code runs *after* B's). Each value is
 * another middleware's name, or `'*'` — `before: '*'` puts the middleware in the
 * outermost band (enters before all others at its level), `after: '*'` in the
 * innermost band. Unknown references and cycles are boot-time hard errors.
 */
export interface MiddlewareOptions {
  /**
   * Identity for diagnostics and before/after refs. Defaults to the extension
   * name; required when one extension registers two middleware at one level.
   */
  name?: string;
  /** "Enter before these" — other middleware names or `'*'`. Unknown ref = boot error. */
  before?: string | string[];
  /** "Enter after these" — other middleware names or `'*'`. Unknown ref = boot error. */
  after?: string | string[];
}

// -----------------------------------------------------------------------
// Execution contexts
// -----------------------------------------------------------------------

export interface TurnContext {
  turnId: string;
  agentName: string;
  conversationId: string;
  conversation: ConversationState;
  abortSignal: AbortSignal;
  input: InboundEnvelope;
  inboundItemId?: string;
  inboundCommitRef?: string;
  /**
   * Run a bounded, **non-persisting sub-execution** seeded from a caller-given
   * message list, inheriting *this agent's own configuration* (model, tools, and
   * the same `useModelInput` projection a normal step applies). See {@link SubrunFn}.
   *
   * It is a step loop, not a turn: it runs up to `maxSteps` model steps over a
   * throwaway conversation seeded from `messages`, executing tool calls when
   * `maxSteps > 1`, and returns the result *as a value*. It never writes to this
   * conversation and never re-runs step middleware (so a compaction sub-run can't
   * recurse into the compaction step middleware that spawned it).
   *
   * Cache is **not** part of this contract: by default model and tools are
   * inherited, so the sub-run's prefix matches the main turn and the prompt cache
   * is hit as a side effect. `overrideModel`/`overrideTools` deliberately allow
   * deviating from that (and thus from the cache) — explicitly named, not hidden.
   *
   * Compaction (summarize a — possibly pruned — history), cache prewarm (re-issue
   * the prefix), and recap all express themselves as one `subrun` call.
   */
  subrun: SubrunFn;
  /** Conversation-scoped persistent KV, namespaced by (extension × conversation). */
  store: ExtensionStore;
}

export interface StepContext extends TurnContext {
  stepNumber: number;
}

/**
 * ToolCallContext (middleware) is DISTINCT from ToolContext (handler).
 * ToolCallContext extends StepContext with toolName/toolArgs.
 * ToolContext is simpler: { conversationId, agentName, abortSignal }
 */
export interface ToolCallContext extends StepContext {
  toolCallId?: string;
  toolName: string;
  toolArgs: JsonObject;
}

// -----------------------------------------------------------------------
// Model input assembly (useModelInput)
//
// The conversation event log is the durable truth. The *model input* is a
// per-step, throwaway view of that truth for the model — windowing, hydration,
// redaction, reordering. It never persists; if it ran zero times the durable
// log would still be correct. A transform that wouldn't be is a
// `conversation.append` mutation, not a model-input projection.
// -----------------------------------------------------------------------

/**
 * The messages handed to the model for one step. Derived (and non-persistable)
 * by construction — it comes from the `Object.freeze`d `getMessages()` snapshot,
 * never the other way around.
 */
export type ModelInput = readonly Message[];

/**
 * Assembles the model input for a single step. Runs once at the end of the
 * onion, immediately before the model call. Pure and side-effect-free with
 * respect to durable state; async is allowed (hydration is the representative
 * case). It must never touch `conversation`. Throwing fails the step loudly.
 */
export type ModelInputMiddleware = (
  messages: ModelInput,
  ctx: StepContext,
) => ModelInput | Promise<ModelInput>;

// -----------------------------------------------------------------------
// Result types
// -----------------------------------------------------------------------

export interface ToolCallSummary {
  toolName: string;
  args: JsonObject;
  invalidReason?: string;
  result?: ToolResult;
  error?: Error;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}

/**
 * Provider-specific metadata passthrough from the underlying model call.
 * Shape mirrors the AI SDK's `providerMetadata`: provider name → arbitrary record.
 * Use for raw details the normalized `LlmUsage` does not model — e.g. Anthropic's
 * cache-write TTL split at
 * `providerMetadata.anthropic.usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
 * the per-iteration compaction breakdown, or container info. OpenHarness stays
 * provider-agnostic and forwards this verbatim; consumers interpret per provider.
 */
export type LlmProviderMetadata = Record<string, JsonObject>;

export interface StepSummary {
  stepNumber: number;
  toolCalls: ToolCallSummary[];
  /** Finish reason from the LLM response that produced this step. */
  finishReason?: LlmFinishReason;
  /** Provider-specific raw finish reason, when the adapter exposes one. */
  rawFinishReason?: string;
  usage?: LlmUsage;
  /** Raw provider metadata for this step's model call (see {@link LlmProviderMetadata}). */
  providerMetadata?: LlmProviderMetadata;
}

export type LlmFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

export interface TurnResult {
  turnId: string;
  agentName: string;
  conversationId: string;
  status: "completed" | "aborted" | "error" | "maxStepsReached" | "waitingForHuman";
  text?: string;
  /** Finish reason from the last LLM step in this turn. */
  finishReason?: LlmFinishReason;
  /** Provider-specific raw finish reason from the last LLM step in this turn. */
  rawFinishReason?: string;
  steps: StepSummary[];
  totalUsage?: LlmUsage;
  error?: Error;
}

export interface StepResult {
  text?: string;
  finishReason?: LlmFinishReason;
  rawFinishReason?: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: JsonObject;
    invalidReason?: string;
    result?: ToolResult;
  }>;
  usage?: LlmUsage;
  /** Raw provider metadata for this step's model call (see {@link LlmProviderMetadata}). */
  providerMetadata?: LlmProviderMetadata;
}

// -----------------------------------------------------------------------
// Ingress middleware contexts
// -----------------------------------------------------------------------

export interface IngressContext {
  connectionName: string;
  payload: unknown;
  receivedAt: string;
}

export interface RouteContext {
  connectionName: string;
  envelope: InboundEnvelope;
}

export interface RouteResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId: string;
}

// -----------------------------------------------------------------------
// Middleware function types
// -----------------------------------------------------------------------

// Execution middleware
export type TurnMiddleware = (
  ctx: TurnContext,
  next: () => Promise<TurnResult>,
) => Promise<TurnResult>;

export type StepMiddleware = (
  ctx: StepContext,
  next: () => Promise<StepResult>,
) => Promise<StepResult>;

export interface ToolCallNextOverride {
  toolArgs?: JsonObject;
}

export type ToolCallMiddleware = (
  ctx: ToolCallContext,
  next: (override?: ToolCallNextOverride) => Promise<ToolResult>,
) => Promise<ToolResult>;

// Ingress middleware
export type IngressMiddleware = (
  ctx: IngressContext,
  next: () => Promise<InboundEnvelope | InboundEnvelope[]>,
) => Promise<InboundEnvelope | InboundEnvelope[]>;

export type RouteMiddleware = (
  ctx: RouteContext,
  next: () => Promise<RouteResult>,
) => Promise<RouteResult>;

// -----------------------------------------------------------------------
// LLM Client abstraction
// -----------------------------------------------------------------------

export interface LlmResponse {
  text?: string;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: JsonObject;
    invalidReason?: string;
  }>;
  finishReason?: LlmFinishReason;
  rawFinishReason?: string;
  usage?: LlmUsage;
  /** Raw provider metadata for this model call (see {@link LlmProviderMetadata}). */
  providerMetadata?: LlmProviderMetadata;
}

export interface LlmChatOptions {
  /** Override the model for this call (e.g. use a cheaper model for summarization). */
  model?: string;
  /** Sampling temperature override. */
  temperature?: number;
  /** Max output tokens override. */
  maxTokens?: number;
}

export interface LlmStreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCallDelta?: (toolCallId: string, toolName: string, argsDelta: string) => void;
}

/**
 * Options for {@link SubrunFn}. The defaults inherit the agent's configuration
 * (which is what makes the sub-run share the main turn's cache prefix); the
 * `override*` knobs let a caller deviate from that on purpose.
 */
export interface SubrunOptions {
  /**
   * Max model steps. `1` (default) is a single completion — what compaction,
   * prewarm and recap use. `> 1` lets the model call tools across steps (e.g. a
   * tool-using compactor that reads files to summarize better).
   */
  maxSteps?: number;
  /** Sampling temperature override. */
  temperature?: number;
  /** Cap output tokens (prewarm uses 1 to re-issue the prefix without generating). */
  maxTokens?: number;
  /**
   * Abort signal. There is no default: a detached caller (prewarm timer, the
   * next-turn boundary) must pass its own, because the parent `ctx.abortSignal`
   * is already aborted once its turn ends. In-turn callers pass `ctx.abortSignal`.
   */
  signal?: AbortSignal;
  /**
   * Use this model instead of the agent's. Omitted → inherit (cache preserved).
   * Set → that model (cache is missed; this is the explicit, named escape hatch,
   * e.g. a cheaper/bigger summarization model). Cache bias lives in the *default*,
   * not in a closed contract.
   */
  overrideModel?: LlmClient;
  /**
   * Use this tool set instead of the agent's. Omitted → inherit. Set → exactly
   * these tools (e.g. a read-only subset for a tool-using compactor).
   */
  overrideTools?: ToolDefinition[];
}

/**
 * Result of a {@link SubrunFn}. Returned by value; nothing is persisted to the
 * parent conversation. `text` is the last step's assistant text (the summary /
 * recap extraction point); `steps` are the executed steps (length ≤ maxSteps).
 */
export interface SubrunResult {
  text?: string;
  status: "completed" | "maxStepsReached" | "aborted" | "waitingForHuman" | "error";
  steps: StepResult[];
  totalUsage?: LlmUsage;
  error?: Error;
}

/**
 * Run a bounded, non-persisting sub-execution. `messages` seeds a throwaway
 * conversation (the caller may pass the live conversation snapshot, or a
 * transformed/pruned one); the agent's `useModelInput` projection is applied to
 * it (so the system prompt etc. are assembled exactly as in a normal step — no
 * manual prepend). Up to `options.maxSteps` model steps run, executing tool calls
 * past step 1. Model and tools are the agent's unless overridden.
 */
export type SubrunFn = (
  messages: Message[],
  options?: SubrunOptions,
) => Promise<SubrunResult>;

export interface LlmClient {
  chat(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    options?: LlmChatOptions,
  ): Promise<LlmResponse>;

  /**
   * Optional streaming variant of chat(). Returns the same LlmResponse once complete,
   * but calls callbacks with deltas during streaming. If not implemented, core falls
   * back to chat(). (FR-CORE-010)
   */
  streamChat?(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    callbacks: LlmStreamCallbacks,
    options?: LlmChatOptions,
  ): Promise<LlmResponse>;
}

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
  /** LLM client bound to the current agent's model configuration. */
  llm: LlmClient;
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

export interface StepSummary {
  stepNumber: number;
  toolCalls: ToolCallSummary[];
  /** Finish reason from the LLM response that produced this step. */
  finishReason?: LlmFinishReason;
  /** Provider-specific raw finish reason, when the adapter exposes one. */
  rawFinishReason?: string;
  usage?: LlmUsage;
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

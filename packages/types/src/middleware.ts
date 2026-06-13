import type { ConversationState, Message } from "./conversation.js";
import type { ToolResult, ToolDefinition, JsonObject } from "./tool.js";
import type { InboundEnvelope, IngressAcceptResult } from "./ingress.js";
import type { SlotKey, SlotProvision, SlotStore } from "./slots.js";

// Middleware level discriminant
export type MiddlewareLevel =
  | "turn"
  | "step"
  | "toolCall"
  | "ingress"
  | "route";

/**
 * Coarse ordering bands, outer→inner (the onion: `observe` is outermost, so it
 * enters first and its post-`next()` code runs last). Default is `context`.
 *
 * - `observe` — logging/metrics that should wrap everything.
 * - `context` — assembles the prompt context (default).
 * - `guard`   — last checks before the model (validation, required-tools).
 * - `model`   — innermost, immediately around the LLM call. **Step level only**;
 *               using it at any other level is a boot error.
 */
export type MiddlewarePhase = "observe" | "context" | "guard" | "model";

/**
 * Declarative placement for a middleware registration. There is no numeric
 * priority: ordering is a phase band plus optional same-/cross-phase edges.
 *
 * `before`/`after` are **entry order**: "A before B" ⇒ A enters before B (and,
 * because of the onion, A's post-`next()` code runs *after* B's). Plain
 * `before`/`after` are hard edges (unknown ref = boot error); the `*Optional`
 * variants are dropped silently if the referenced name is absent. All accept a
 * single name or a list. To reference a phase rather than a name, use the
 * `phase:` prefix (`after: "phase:context"`) so names and phases can't collide.
 */
export interface MiddlewareOptions {
  /** Identity for diagnostics and before/after refs. Defaults to the extension
   * name; required when one extension registers two middleware at one level. */
  name?: string;
  /** Ordering band. Default `context`. */
  phase?: MiddlewarePhase;
  /** Hard "enter before these" edges (name or `phase:<phase>`). */
  before?: string | string[];
  /** Hard "enter after these" edges (name or `phase:<phase>`). */
  after?: string | string[];
  /** Like `before`, but ignored if the referenced name is not registered. */
  beforeOptional?: string | string[];
  /** Like `after`, but ignored if the referenced name is not registered. */
  afterOptional?: string | string[];
  /** Slots this middleware populates; `{ slot, always: true }` guarantees set. */
  provides?: SlotProvision | SlotProvision[];
  /** Required slots this middleware reads via `slots.get`. */
  consumes?: SlotKey | SlotKey[];
  /** Optional slots this middleware reads via `slots.tryGet`. */
  consumesOptional?: SlotKey | SlotKey[];
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
  /**
   * Turn-scoped typed slots. Each middleware sees only the slots it declared
   * via `provides`/`consumes`/`consumesOptional`; touching an undeclared slot
   * throws. See {@link SlotStore}.
   */
  slots: SlotStore;
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

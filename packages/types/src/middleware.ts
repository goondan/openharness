import type { ConversationState, Message } from "./conversation.js";
import type { ToolResult, ToolDefinition, JsonObject } from "./tool.js";
import type { InboundEnvelope, IngressAcceptResult } from "./ingress.js";

// Middleware level discriminant
export type MiddlewareLevel =
  | "turn"
  | "step"
  | "toolCall"
  | "ingress"
  | "route";

export interface MiddlewareOptions {
  /** default 100; lower runs first */
  priority?: number;
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
  /** LLM client bound to the current agent's model configuration. */
  llm: LlmClient;
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
  toolName: string;
  toolArgs: JsonObject;
}

// -----------------------------------------------------------------------
// Result types
// -----------------------------------------------------------------------

export interface ToolCallSummary {
  toolName: string;
  args: JsonObject;
  result?: ToolResult;
  error?: Error;
}

export interface StepSummary {
  stepNumber: number;
  toolCalls: ToolCallSummary[];
}

export interface TurnResult {
  turnId: string;
  agentName: string;
  conversationId: string;
  status: "completed" | "aborted" | "error" | "maxStepsReached";
  text?: string;
  steps: StepSummary[];
  error?: Error;
}

export interface StepResult {
  text?: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: JsonObject;
    result?: ToolResult;
  }>;
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

export type ToolCallMiddleware = (
  ctx: ToolCallContext,
  next: () => Promise<ToolResult>,
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
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonObject }>;
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

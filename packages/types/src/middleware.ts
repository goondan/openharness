import type { ConversationState, Message } from "./conversation.js";
import type { ToolResult, ToolDefinition, JsonObject } from "./tool.js";
import type { InboundEnvelope, IngressAcceptResult } from "./ingress.js";

// Middleware level discriminant
export type MiddlewareLevel =
  | "turn"
  | "step"
  | "toolCall"
  | "verify"
  | "normalize"
  | "route"
  | "dispatch";

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

export interface VerifyContext {
  connectionName: string;
  payload: unknown;
  receivedAt: string;
}

export interface NormalizeContext {
  connectionName: string;
  payload: unknown;
  receivedAt: string;
}

export interface RouteContext {
  connectionName: string;
  envelope: InboundEnvelope;
}

export interface DispatchContext {
  connectionName: string;
  envelope: InboundEnvelope;
  agentName: string;
  conversationId: string;
}

export interface RouteResult {
  agentName: string;
  conversationId: string;
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
export type VerifyMiddleware = (
  ctx: VerifyContext,
  next: () => Promise<void>,
) => Promise<void>;

export type NormalizeMiddleware = (
  ctx: NormalizeContext,
  next: () => Promise<InboundEnvelope | InboundEnvelope[]>,
) => Promise<InboundEnvelope | InboundEnvelope[]>;

export type RouteMiddleware = (
  ctx: RouteContext,
  next: () => Promise<RouteResult>,
) => Promise<RouteResult>;

export type DispatchMiddleware = (
  ctx: DispatchContext,
  next: () => Promise<IngressAcceptResult>,
) => Promise<IngressAcceptResult>;

// -----------------------------------------------------------------------
// LLM Client abstraction
// -----------------------------------------------------------------------

export interface LlmResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonObject }>;
}

export interface LlmClient {
  chat(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): Promise<LlmResponse>;
}

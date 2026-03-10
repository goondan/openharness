import type {
  InboundContentPart,
  InboundEnvelope,
  InboundPropertyValue,
} from "./connector.js";
import type { AgentEvent } from "./events.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { ConversationState, MessageEvent, Message } from "./message.js";
import type { JsonSchemaObject } from "./resources.js";
import type {
  ExecutionContext,
  LoggerLike,
  ToolCall,
  ToolCallResult,
  ToolHandler,
} from "./tool.js";
import type { TurnResult } from "./turn.js";

export interface ToolSource {
  type: "config" | "extension" | "mcp";
  name: string;
  mcp?: {
    extensionName: string;
    serverName?: string;
  };
}

export interface ToolCatalogItem {
  name: string;
  description?: string;
  parameters?: JsonSchemaObject;
  source?: ToolSource;
}

export interface RuntimeAgentPromptContext {
  system?: string;
}

export interface RuntimeAgentContext {
  name: string;
  bundleRoot: string;
  prompt?: RuntimeAgentPromptContext;
}

export interface RuntimeInboundBaseContext {
  eventId: string;
  eventType: string;
  sourceName: string;
  createdAt: string;
  connectionName?: string;
  conversationId?: string;
}

export interface RuntimeConnectorInboundContext extends RuntimeInboundBaseContext {
  kind: "connector";
  properties: Record<string, InboundPropertyValue>;
  content: InboundContentPart[];
  rawPayload?: JsonValue;
}

export type RuntimeInboundContext = RuntimeConnectorInboundContext;

export interface RuntimeModelContext {
  provider: string;
  modelName: string;
}

export interface RuntimeContext {
  agent: RuntimeAgentContext;
  inbound: RuntimeInboundContext;
  model?: RuntimeModelContext;
}

export interface Step {
  readonly id: string;
  readonly index: number;
  readonly toolCatalog: ToolCatalogItem[];
  readonly toolCalls: ToolCall[];
  readonly toolResults: ToolCallResult[];
  status: "llm_call" | "tool_exec" | "completed";
}

export interface Turn {
  readonly id: string;
  readonly agentName: string;
  readonly inputEvent: AgentEvent;
  readonly messages: Message[];
  readonly steps: Step[];
  status: "running" | "completed" | "failed";
  metadata: Record<string, JsonValue>;
}

export interface StepResult {
  status: "completed" | "failed";
  shouldContinue: boolean;
  toolCalls: ToolCall[];
  toolResults: ToolCallResult[];
  metadata: Record<string, JsonValue>;
}

export interface TurnMiddlewareContext extends ExecutionContext {
  readonly inputEvent: AgentEvent;
  readonly conversationState: ConversationState;
  readonly runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  metadata: Record<string, JsonValue>;
  next(): Promise<TurnResult>;
}

export interface StepMiddlewareContext extends ExecutionContext {
  readonly turn: Turn;
  readonly stepIndex: number;
  readonly conversationState: ConversationState;
  readonly runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  toolCatalog: ToolCatalogItem[];
  metadata: Record<string, JsonValue>;
  next(): Promise<StepResult>;
}

export interface ToolCallMiddlewareContext extends ExecutionContext {
  readonly stepIndex: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly conversationState: ConversationState;
  readonly runtime: RuntimeContext;
  args: JsonObject;
  metadata: Record<string, JsonValue>;
  next(): Promise<ToolCallResult>;
}

export type TurnMiddleware = (ctx: TurnMiddlewareContext) => Promise<TurnResult>;
export type StepMiddleware = (ctx: StepMiddlewareContext) => Promise<StepResult>;
export type ToolCallMiddleware = (ctx: ToolCallMiddlewareContext) => Promise<ToolCallResult>;

export interface IngressVerifyContext {
  readonly connectionName: string;
  readonly connectorName: string;
  readonly payload: unknown;
  readonly config: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly receivedAt: string;
  metadata: Record<string, JsonValue>;
  next(): Promise<void>;
}

export interface IngressRouteResolution {
  connectionName: string;
  connectorName: string;
  ruleIndex: number;
  agentName: string;
  conversationId: string;
  event: InboundEnvelope;
}

export interface IngressNormalizeContext {
  readonly connectionName: string;
  readonly connectorName: string;
  readonly payload: unknown;
  readonly config: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly receivedAt: string;
  metadata: Record<string, JsonValue>;
  next(): Promise<InboundEnvelope[]>;
}

export interface IngressRouteContext {
  readonly connectionName: string;
  readonly connectorName: string;
  readonly event: InboundEnvelope;
  metadata: Record<string, JsonValue>;
  next(): Promise<IngressRouteResolution>;
}

export interface IngressDispatchPlan {
  connectionName: string;
  connectorName: string;
  agentName: string;
  conversationId: string;
  event: InboundEnvelope;
  eventId: string;
  turnId: string;
  traceId: string;
  inputEvent: AgentEvent;
  runtime: RuntimeContext;
}

export interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  connectorName: string;
  agentName: string;
  conversationId: string;
  eventId: string;
  eventName: string;
  turnId: string;
  traceId: string;
}

export interface AbortConversationInput {
  conversationId: string;
  agentName?: string;
  reason?: string;
}

export interface AbortConversationResult {
  conversationId: string;
  agentNames: string[];
  matchedSessions: number;
  abortedTurns: number;
  reason?: string;
}

export interface IngressDispatchContext {
  plan: IngressDispatchPlan;
  metadata: Record<string, JsonValue>;
  next(): Promise<IngressAcceptResult>;
}

export type IngressVerifyMiddleware = (ctx: IngressVerifyContext) => Promise<void>;
export type IngressNormalizeMiddleware = (ctx: IngressNormalizeContext) => Promise<InboundEnvelope[]>;
export type IngressRouteMiddleware = (ctx: IngressRouteContext) => Promise<IngressRouteResolution>;
export type IngressDispatchMiddleware = (ctx: IngressDispatchContext) => Promise<IngressAcceptResult>;

export interface PipelineRegistry {
  register(type: "turn", fn: TurnMiddleware, options?: { priority?: number }): void;
  register(type: "step", fn: StepMiddleware, options?: { priority?: number }): void;
  register(type: "toolCall", fn: ToolCallMiddleware, options?: { priority?: number }): void;
}

export interface IngressRegistry {
  register(type: "verify", fn: IngressVerifyMiddleware, options?: { priority?: number }): void;
  register(type: "normalize", fn: IngressNormalizeMiddleware, options?: { priority?: number }): void;
  register(type: "route", fn: IngressRouteMiddleware, options?: { priority?: number }): void;
  register(type: "dispatch", fn: IngressDispatchMiddleware, options?: { priority?: number }): void;
}

export interface ExtensionApi {
  pipeline: PipelineRegistry;
  ingress: IngressRegistry;
  tools: {
    register(item: ToolCatalogItem, handler: ToolHandler): void;
  };
  state: {
    get(): Promise<JsonValue | null>;
    set(value: JsonValue): Promise<void>;
  };
  events: {
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>): () => void;
    emit(event: string, ...args: unknown[]): Promise<void>;
  };
  logger: LoggerLike;
}

export interface ResourceManifest<TKind extends string, TSpec> {
  apiVersion: "goondan.ai/v1";
  kind: TKind;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: TSpec;
}

export interface ToolManifestSpec {
  entry: string;
  errorMessageLimit?: number;
  exports: Array<{
    name: string;
    description?: string;
    parameters?: JsonObject;
  }>;
}

export interface ExtensionManifestSpec {
  entry: string;
  config?: JsonObject;
}

export interface MessageContentPart {
  type: string;
  text?: string;
  [key: string]: JsonValue | undefined;
}

export interface MessageData {
  role: string;
  content: string | MessageContentPart[];
}

export type MessageRole = MessageData["role"];

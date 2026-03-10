export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | string;

export interface MessageContentPart {
  type: string;
  text?: string;
  [key: string]: JsonValue | undefined;
}

export interface MessageData {
  role: MessageRole;
  content: string | MessageContentPart[];
}

export type InboundPropertyValue = string | number | boolean;

export type InboundContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'file'; url: string; name: string; mimeType?: string };

export type MessageSource =
  | { type: 'user' }
  | { type: 'assistant'; stepId: string }
  | { type: 'tool'; toolCallId: string; toolName: string }
  | { type: 'system' }
  | { type: 'extension'; extensionName: string };

export interface Message {
  readonly id: string;
  readonly data: MessageData;
  metadata: Record<string, JsonValue>;
  readonly createdAt: Date;
  readonly source: MessageSource;
}

export type MessageEvent =
  | { type: 'append'; message: Message }
  | { type: 'replace'; targetId: string; message: Message }
  | { type: 'remove'; targetId: string }
  | { type: 'truncate' };

export interface ConversationState {
  readonly baseMessages: Message[];
  readonly events: MessageEvent[];
  readonly nextMessages: Message[];
  toLlmMessages(): MessageData[];
}

export interface ExecutionContext {
  readonly agentName: string;
  readonly instanceKey: string;
  readonly turnId: string;
  readonly traceId: string;
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output?: JsonValue;
  readonly status: 'ok' | 'error';
  readonly error?: {
    name?: string;
    message: string;
    code?: string;
    suggestion?: string;
    helpUrl?: string;
  };
}

export interface EventSource {
  readonly kind: 'agent' | 'connector';
  readonly name: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface ReplyChannel {
  readonly target: string;
  readonly correlationId: string;
}

export interface TurnPrincipal {
  readonly type: string;
  readonly id: string;
  readonly attributes?: Record<string, JsonValue>;
}

export interface TurnAuth {
  readonly principal?: TurnPrincipal;
  readonly attributes?: Record<string, JsonValue>;
}

export interface AgentEvent {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly traceId?: string;
  readonly metadata?: JsonObject;
  readonly input?: string;
  readonly content?: InboundContentPart[];
  readonly properties?: Record<string, InboundPropertyValue>;
  readonly instanceKey?: string;
  readonly source: EventSource;
  readonly auth?: TurnAuth;
  readonly replyTo?: ReplyChannel;
  readonly rawPayload?: JsonValue;
}

export interface AgentRuntimeRequestOptions {
  timeoutMs?: number;
  async?: boolean;
}

export interface AgentRuntimeRequestResult {
  eventId: string;
  target: string;
  response?: JsonValue;
  correlationId: string;
  accepted?: boolean;
  async?: boolean;
}

export interface AgentRuntimeSendResult {
  eventId: string;
  target: string;
  accepted: boolean;
}

export interface AgentRuntimeSpawnOptions {
  instanceKey?: string;
  cwd?: string;
}

export interface AgentRuntimeSpawnResult {
  target: string;
  instanceKey: string;
  spawned: boolean;
  cwd?: string;
}

export interface AgentRuntimeListOptions {
  includeAll?: boolean;
}

export interface SpawnedAgentInfo {
  target: string;
  instanceKey: string;
  ownerAgent: string;
  ownerInstanceKey: string;
  createdAt: string;
  cwd?: string;
}

export interface AgentRuntimeListResult {
  agents: SpawnedAgentInfo[];
}

export interface AgentRuntimeCatalogResult {
  swarmName: string;
  entryAgent: string;
  selfAgent: string;
  availableAgents: string[];
  callableAgents: string[];
}

export type InterAgentResponseStatus = "ok" | "error" | "timeout";

export interface InterAgentResponseMetadata {
  kind: "inter_agent_response";
  version: 1;
  requestId: string;
  requestEventId: string;
  responseEventId?: string;
  fromAgentId: string;
  toAgentId: string;
  async: true;
  status: InterAgentResponseStatus;
  receivedAt: string;
  traceId?: string;
  requestEventType?: string;
  requestMetadata?: JsonObject;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentToolRuntime {
  request(
    target: string,
    event: AgentEvent,
    options?: AgentRuntimeRequestOptions
  ): Promise<AgentRuntimeRequestResult>;
  send(target: string, event: AgentEvent): Promise<AgentRuntimeSendResult>;
  spawn(target: string, options?: AgentRuntimeSpawnOptions): Promise<AgentRuntimeSpawnResult>;
  list(options?: AgentRuntimeListOptions): Promise<AgentRuntimeListResult>;
  catalog(): Promise<AgentRuntimeCatalogResult>;
}

export interface MiddlewareAgentRequestParams {
  target: string;
  input?: string;
  instanceKey?: string;
  timeoutMs?: number;
  async?: boolean;
  metadata?: JsonObject;
}

export interface MiddlewareAgentSendParams {
  target: string;
  input?: string;
  instanceKey?: string;
  metadata?: JsonObject;
}

export interface MiddlewareAgentRequestResult {
  target: string;
  response: string;
  correlationId?: string;
  accepted?: boolean;
  async?: boolean;
}

export interface MiddlewareAgentSendResult {
  accepted: boolean;
}

export interface MiddlewareAgentsApi {
  request(params: MiddlewareAgentRequestParams): Promise<MiddlewareAgentRequestResult>;
  send(params: MiddlewareAgentSendParams): Promise<MiddlewareAgentSendResult>;
}

export interface ToolContext extends ExecutionContext {
  readonly toolCallId: string;
  readonly message: Message;
  readonly workdir: string;
  readonly logger: Console;
  readonly runtime?: AgentToolRuntime;
}

export type ToolHandler = (
  ctx: ToolContext,
  input: JsonObject
) => Promise<JsonValue> | JsonValue;

export interface ToolCatalogItem {
  name: string;
  description?: string;
  parameters?: JsonObject;
  source?: {
    type: 'config' | 'extension' | 'mcp';
    name: string;
    mcp?: {
      extensionName: string;
      serverName?: string;
    };
  };
}

export interface RuntimeAgentPromptContext {
  system?: string;
}

export interface RuntimeAgentContext {
  name: string;
  bundleRoot: string;
  prompt?: RuntimeAgentPromptContext;
}

export interface RuntimeSwarmContext {
  swarmName: string;
  entryAgent: string;
  selfAgent: string;
  availableAgents: string[];
  callableAgents: string[];
}

export interface RuntimeInboundBaseContext {
  eventId: string;
  eventType: string;
  sourceName: string;
  createdAt: string;
  connectionName?: string;
  instanceKey?: string;
}

export interface RuntimeConnectorInboundContext extends RuntimeInboundBaseContext {
  kind: 'connector';
  properties: Record<string, InboundPropertyValue>;
  content: InboundContentPart[];
  rawPayload?: JsonValue;
}

export interface RuntimeInboundCallerContext {
  agent: string;
  instanceKey?: string;
  turnId?: string;
  callSource?: string;
  callStack?: string[];
}

export interface RuntimeAgentInboundContext extends RuntimeInboundBaseContext {
  kind: 'agent';
  caller: RuntimeInboundCallerContext;
  payload?: JsonObject;
}

export type RuntimeInboundContext =
  | RuntimeConnectorInboundContext
  | RuntimeAgentInboundContext;

export interface RuntimeCallContext {
  callerAgent?: string;
  callerInstanceKey?: string;
  callerTurnId?: string;
  callSource?: string;
  callStack?: string[];
  replyTo?: {
    target: string;
    correlationId: string;
  };
}

export interface RuntimeContext {
  agent: RuntimeAgentContext;
  swarm: RuntimeSwarmContext;
  inbound: RuntimeInboundContext;
  call?: RuntimeCallContext;
}

export interface Turn {
  readonly id: string;
  readonly startedAt: Date;
}

export interface TurnResult {
  readonly turnId: string;
  readonly responseMessage?: Message;
  readonly finishReason: 'text_response' | 'max_steps' | 'error';
  readonly error?: {
    message: string;
    code?: string;
  };
}

export interface StepResult {
  status: 'completed' | 'failed';
  /** turn 루프를 계속할지 여부. 기본값: toolCalls.length > 0. step 미들웨어에서 override 가능. */
  shouldContinue: boolean;
  toolCalls: { id: string; name: string; args: JsonObject }[];
  toolResults: ToolCallResult[];
  metadata: Record<string, JsonValue>;
}

export interface TurnMiddlewareContext extends ExecutionContext {
  readonly inputEvent: AgentEvent;
  readonly conversationState: ConversationState;
  readonly agents: MiddlewareAgentsApi;
  readonly runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  metadata: Record<string, JsonValue>;
  next(): Promise<TurnResult>;
}

export interface StepMiddlewareContext extends ExecutionContext {
  readonly turn: Turn;
  readonly stepIndex: number;
  readonly conversationState: ConversationState;
  readonly agents: MiddlewareAgentsApi;
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
  readonly runtime: RuntimeContext;
  args: JsonObject;
  metadata: Record<string, JsonValue>;
  next(): Promise<ToolCallResult>;
}

export type TurnMiddleware = (ctx: TurnMiddlewareContext) => Promise<TurnResult>;
export type StepMiddleware = (ctx: StepMiddlewareContext) => Promise<StepResult>;
export type ToolCallMiddleware = (
  ctx: ToolCallMiddlewareContext
) => Promise<ToolCallResult>;

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

export interface InboundEnvelope {
  readonly name: string;
  readonly content: InboundContentPart[];
  readonly properties: Record<string, InboundPropertyValue>;
  readonly instanceKey?: string;
  readonly auth?: TurnAuth;
  readonly rawPayload?: JsonValue;
  readonly source: EventSource;
  readonly metadata?: JsonObject;
}

export interface IngressRouteResolution {
  connectionName: string;
  connectorName: string;
  ruleIndex: number;
  agentName: string;
  instanceKey: string;
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
  instanceKey: string;
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
  instanceKey: string;
  eventId: string;
  eventName: string;
  turnId: string;
  traceId: string;
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
  register(type: 'turn', middleware: TurnMiddleware): void;
  register(type: 'step', middleware: StepMiddleware): void;
  register(type: 'toolCall', middleware: ToolCallMiddleware): void;
}

export interface IngressRegistry {
  register(type: 'verify', middleware: IngressVerifyMiddleware): void;
  register(type: 'normalize', middleware: IngressNormalizeMiddleware): void;
  register(type: 'route', middleware: IngressRouteMiddleware): void;
  register(type: 'dispatch', middleware: IngressDispatchMiddleware): void;
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
    on(event: string, handler: (...args: unknown[]) => void): () => void;
    emit(event: string, ...args: unknown[]): void;
  };
  logger: Console;
}

export type ConnectorEventMessage = InboundContentPart;

export interface ConnectorEvent {
  name: string;
  message: ConnectorEventMessage;
  properties: Record<string, string>;
  instanceKey: string;
}

export interface ConnectorAdapterContext {
  payload: unknown;
  connectionName: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  logger: Console;
  receivedAt: string;
}

export interface ConnectorAdapter {
  verify?(ctx: ConnectorAdapterContext): Promise<void> | void;
  normalize(
    ctx: ConnectorAdapterContext,
  ): Promise<InboundEnvelope | InboundEnvelope[]> | InboundEnvelope | InboundEnvelope[];
}

export interface ConnectorContext extends ConnectorAdapterContext {
  emit(event: ConnectorEvent): Promise<void>;
}

export interface ResourceMetadata {
  name: string;
  labels?: Record<string, string>;
}

export interface ResourceManifest<TKind extends string, TSpec> {
  apiVersion: 'goondan.ai/v1';
  kind: TKind;
  metadata: ResourceMetadata;
  spec: TSpec;
}

export interface ToolExportSpec {
  name: string;
  description?: string;
  parameters?: JsonObject;
}

export interface ToolManifestSpec {
  entry: string;
  errorMessageLimit?: number;
  exports: ToolExportSpec[];
}

export interface ExtensionManifestSpec {
  entry: string;
  config?: JsonObject;
}

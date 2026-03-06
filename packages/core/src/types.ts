export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type ObjectRefLike = string | ObjectRef;

export interface ObjectRef {
  kind: string;
  name: string;
  package?: string;
  apiVersion?: string;
}

export interface RefItem {
  ref: ObjectRefLike;
}

export interface Selector {
  kind?: string;
  name?: string;
  matchLabels?: Record<string, string>;
}

export interface SelectorWithOverrides {
  selector: Selector;
  overrides?: {
    spec?: Record<string, unknown>;
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
  };
}

export type RefOrSelector = RefItem | SelectorWithOverrides | ObjectRefLike;

export type ValueSource =
  | { value: string; valueFrom?: never }
  | { value?: never; valueFrom: ValueFrom };

export type ValueFrom =
  | { env: string; secretRef?: never }
  | { env?: never; secretRef: SecretRef };

export interface SecretRef {
  ref: string;
  key: string;
}

export interface CoreMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export type MessageSource =
  | { type: "user" }
  | { type: "assistant"; stepId: string }
  | { type: "tool"; toolCallId: string; toolName: string }
  | { type: "system" }
  | { type: "extension"; extensionName: string };

export interface Message {
  readonly id: string;
  readonly data: CoreMessage;
  metadata: Record<string, JsonValue>;
  readonly createdAt: Date;
  readonly source: MessageSource;
}

export type MessageEvent =
  | { type: "append"; message: Message }
  | { type: "replace"; targetId: string; message: Message }
  | { type: "remove"; targetId: string }
  | { type: "truncate" };

export interface ConversationState {
  readonly baseMessages: Message[];
  readonly events: MessageEvent[];
  readonly nextMessages: Message[];
  toLlmMessages(): CoreMessage[];
}

export interface EventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly traceId?: string;
  readonly metadata?: JsonObject;
}

export interface EventSource {
  readonly kind: "agent" | "connector";
  readonly name: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface ReplyChannel {
  readonly target: string;
  readonly correlationId: string;
}

export interface TurnPrincipal {
  type: string;
  id: string;
  [key: string]: JsonValue;
}

export interface TurnAuth {
  readonly principal?: TurnPrincipal;
  readonly [key: string]: JsonValue | TurnPrincipal | undefined;
}

export interface AgentEvent extends EventEnvelope {
  readonly input?: string;
  readonly instanceKey?: string;
  readonly source: EventSource;
  readonly auth?: TurnAuth;
  readonly replyTo?: ReplyChannel;
}

export type ProcessStatus =
  | "spawning"
  | "idle"
  | "processing"
  | "draining"
  | "terminated"
  | "crashed"
  | "crashLoopBackOff";

export interface IpcMessage {
  type: "event" | "shutdown" | "shutdown_ack";
  from: string;
  to: string;
  payload: JsonValue;
}

export type ShutdownReason = "restart" | "config_change" | "orchestrator_shutdown";

export interface ExecutionContext {
  readonly agentName: string;
  readonly instanceKey: string;
  readonly turnId: string;
  readonly traceId: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export interface ToolError {
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly suggestion?: string;
  readonly helpUrl?: string;
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output?: JsonValue;
  readonly status: "ok" | "error";
  readonly error?: ToolError;
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

export type ToolHandler = (ctx: ToolContext, input: JsonObject) => Promise<JsonValue> | JsonValue;

export interface TurnResult {
  readonly turnId: string;
  readonly responseMessage?: Message;
  readonly finishReason: "text_response" | "max_steps" | "error";
  readonly error?: {
    message: string;
    code?: string;
  };
}

export interface StepResult {
  status: "completed" | "failed";
  /** turn 루프를 계속할지 여부. 기본값: toolCalls.length > 0. step 미들웨어에서 override 가능. */
  shouldContinue: boolean;
  toolCalls: ToolCall[];
  toolResults: ToolCallResult[];
  metadata: Record<string, JsonValue>;
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

export interface Step {
  readonly id: string;
  readonly index: number;
  readonly toolCatalog: ToolCatalogItem[];
  readonly toolCalls: ToolCall[];
  readonly toolResults: ToolCallResult[];
  status: "llm_call" | "tool_exec" | "completed";
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: JsonValue[];
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
}

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
  instanceKey?: string;
}

export interface RuntimeConnectorInboundContext extends RuntimeInboundBaseContext {
  kind: "connector";
  properties: Record<string, string>;
}

export interface RuntimeInboundCallerContext {
  agent: string;
  instanceKey?: string;
  turnId?: string;
  callSource?: string;
  callStack?: string[];
}

export interface RuntimeAgentInboundContext extends RuntimeInboundBaseContext {
  kind: "agent";
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
  model?: {
    provider: string;
    modelName: string;
  };
  call?: RuntimeCallContext;
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
export type ToolCallMiddleware = (ctx: ToolCallMiddlewareContext) => Promise<ToolCallResult>;

export interface TurnProcessorStepInput {
  stepIndex: number;
  toolCatalog?: ToolCatalogItem[];
  metadata?: Record<string, JsonValue>;
}

export interface TurnProcessorToolCallInput {
  stepIndex: number;
  toolName: string;
  toolCallId: string;
  args: JsonObject;
  metadata?: Record<string, JsonValue>;
}

export interface TurnProcessorModelConfig {
  provider: string;
  apiKey: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
}

export interface TurnProcessorOutput {
  turnResult: TurnResult;
  finalResponseText: string;
  stepCount: number;
}

export interface TurnProcessorContext extends ExecutionContext {
  readonly inputEvent: AgentEvent;
  readonly conversationState: ConversationState;
  readonly agents: MiddlewareAgentsApi;
  readonly runtime: RuntimeContext;
  readonly model: TurnProcessorModelConfig;
  readonly maxSteps: number;
  readonly workdir: string;
  readonly logger: Console;
  resolveToolCatalog(): ToolCatalogItem[];
  runTurn(core: TurnMiddleware): Promise<TurnResult>;
  runStep(input: TurnProcessorStepInput, core: StepMiddleware): Promise<StepResult>;
  runToolCall(input: TurnProcessorToolCallInput): Promise<ToolCallResult>;
}

export type TurnProcessor = (ctx: TurnProcessorContext) => Promise<TurnProcessorOutput>;

export interface PipelineRegistry {
  register(type: "turn", fn: TurnMiddleware, options?: { priority?: number }): void;
  register(type: "step", fn: StepMiddleware, options?: { priority?: number }): void;
  register(type: "toolCall", fn: ToolCallMiddleware, options?: { priority?: number }): void;
}

export interface ExtensionApi {
  pipeline: PipelineRegistry;
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
  session: {
    registerTurnProcessor(processor: TurnProcessor): void;
  };
  logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export type ConnectorEventMessage =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "file"; url: string; name: string };

export interface ConnectorEvent {
  name: string;
  message: ConnectorEventMessage;
  properties?: Record<string, string>;
  instanceKey: string;
}

export interface ConnectorContext {
  emit(event: ConnectorEvent): Promise<void>;
  config: Record<string, string>;
  secrets: Record<string, string>;
  logger: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export type KnownKind =
  | "Model"
  | "Agent"
  | "Swarm"
  | "Tool"
  | "Extension"
  | "Connector"
  | "Connection"
  | "Package";

export interface ResourceMetadata {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Resource<T = unknown> {
  apiVersion: string;
  kind: KnownKind;
  metadata: ResourceMetadata;
  spec: T;
}

export interface ValidationError {
  code: string;
  message: string;
  path: string;
  suggestion?: string;
  helpUrl?: string;
}

export interface RuntimeResource<T = unknown> extends Resource<T> {
  __file: string;
  __docIndex: number;
  __package?: string;
  __rootDir?: string;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return true;
}

export function isObjectRef(value: unknown): value is ObjectRef {
  if (!isJsonObject(value)) {
    return false;
  }

  if (typeof value.kind !== "string" || typeof value.name !== "string") {
    return false;
  }

  if ("package" in value && value.package !== undefined && typeof value.package !== "string") {
    return false;
  }

  if ("apiVersion" in value && value.apiVersion !== undefined && typeof value.apiVersion !== "string") {
    return false;
  }

  return true;
}

export function isObjectRefLike(value: unknown): value is ObjectRefLike {
  if (typeof value === "string") {
    return true;
  }

  return isObjectRef(value);
}

export function isKnownKind(value: string): value is KnownKind {
  return (
    value === "Model" ||
    value === "Agent" ||
    value === "Swarm" ||
    value === "Tool" ||
    value === "Extension" ||
    value === "Connector" ||
    value === "Connection" ||
    value === "Package"
  );
}

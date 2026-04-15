// tool — foundational primitives
export type {
  JsonSchema,
  JsonSchemaWrapper,
  ToolParameters,
  JsonObject,
  JsonValue,
  ToolResult,
  ToolContext,
  ToolDefinition,
  ToolInfo,
} from "./tool.js";
export {
  isJsonSchemaWrapper,
  resolveToolParameters,
} from "./tool.js";

// conversation
export type {
  Message,
  MessageEvent,
  ConversationState,
  NonSystemMessage,
  SystemMessage,
} from "./conversation.js";
export type {
  ModelMessage,
  SystemModelMessage,
  UserModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
} from "ai";

// ingress
export type {
  InboundContentPart,
  EventSource,
  InboundEnvelope,
  ConnectorContext,
  Connector,
  RoutingMatch,
  RoutingRule,
  IngressAcceptResult,
  ConnectionInfo,
  IngressApi,
} from "./ingress.js";

// middleware
export type {
  MiddlewareLevel,
  MiddlewareOptions,
  TurnContext,
  StepContext,
  ToolCallContext,
  ToolCallSummary,
  StepSummary,
  TurnResult,
  StepResult,
  IngressContext,
  RouteContext,
  RouteResult,
  TurnMiddleware,
  StepMiddleware,
  ToolCallMiddleware,
  IngressMiddleware,
  RouteMiddleware,
  LlmResponse,
  LlmChatOptions,
  LlmStreamCallbacks,
  LlmClient,
} from "./middleware.js";

// extension
export type {
  ModelInfo,
  ExtensionInfo,
  AgentInfo,
  RuntimeInfo,
  ExtensionApi,
  Extension,
} from "./extension.js";

// events
export type {
  TurnStartPayload,
  TurnDonePayload,
  TurnErrorPayload,
  StepStartPayload,
  StepDonePayload,
  StepErrorPayload,
  ToolStartPayload,
  ToolDonePayload,
  ToolErrorPayload,
  StepTextDeltaPayload,
  StepToolCallDeltaPayload,
  IngressReceivedPayload,
  IngressAcceptedPayload,
  IngressRejectedPayload,
  EventPayload,
} from "./events.js";

// config — includes value exports (defineHarness, env)
export type { EnvRef, EnvResolvable, ModelConfig, AgentConfig, ConnectionConfig, HarnessConfig, ProcessTurnOptions } from "./config.js";
export { defineHarness, env } from "./config.js";

// runtime
export type {
  AbortResult,
  ControlApi,
  HarnessRuntime,
  RuntimeEventListener,
  RuntimeEventType,
  RuntimeEventsApi,
  RuntimeEventUnsubscribeFn,
} from "./runtime.js";

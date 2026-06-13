// tool — foundational primitives
export type {
  JsonSchema,
  JsonSchemaWrapper,
  ToolParameters,
  JsonObject,
  JsonValue,
  ToolResult,
  ToolContext,
  HumanApprovalStatus,
  HumanTaskStatus,
  HumanTaskType,
  HumanTaskDefinition,
  HumanApprovalPolicy,
  HumanResult,
  ToolCallSnapshot,
  HumanApprovalRecord,
  HumanApprovalFailureInfo,
  HumanTaskRecord,
  HumanTaskView,
  HumanTaskCreateInput,
  CreateHumanApprovalInput,
  CreateHumanApprovalResult,
  HumanTaskFilter,
  SubmitHumanResultInput,
  SubmitHumanResult,
  AcquireHumanApprovalInput,
  ResumeHumanApprovalInput,
  MarkHumanApprovalHandlerStartedInput,
  CompleteHumanApprovalInput,
  FailHumanApprovalInput,
  CancelHumanApprovalInput,
  HumanApprovalRecoveryFilter,
  HumanApprovalStore,
  HumanApprovalReferenceStore,
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
  CreateMessageInput,
} from "./conversation.js";
export {
  createMessage,
  getCreatedBy,
  isCreatedBy,
  isSynthetic,
  CORE_CREATED_BY,
  UNKNOWN_CREATED_BY,
  CREATED_BY_METADATA_KEY,
} from "./conversation.js";

// slots (F6)
export type { SlotKey, SlotProvision, SlotStore } from "./slots.js";
export { createSlot } from "./slots.js";

// recovery (F4)
export type {
  ErrorClass,
  RecoveryMatcher,
  RecoveryInfo,
  RecoveryOutcome,
  RecoveryClaimOptions,
  RecoveryClaimMeta,
  RecoveryApi,
} from "./recovery.js";

// prompt (F2)
export type {
  PromptView,
  PromptProjection,
  PromptTransformOptions,
  PromptApi,
} from "./prompt.js";
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
  InboundItemStatus,
  IngressDisposition,
  ConversationBlockerType,
  ConversationBlockerRef,
  ConversationBlockerSelector,
  LeaseInfo,
  InboundSource,
  InboundFailureInfo,
  DurableInboundItem,
  AppendInboundInput,
  AppendInboundResult,
  AcquireInboundInput,
  MarkInboundDeliveredInput,
  MarkInboundBlockedInput,
  MarkInboundConsumedInput,
  FailInboundInput,
  InboundItemFilter,
  DeadLetterInboundInput,
  ReleaseInboundItemInput,
  RetryInboundInput,
  ReleaseBlockedInboundInput,
  DurableInboundStore,
  DurableInboundReferenceStore,
  IngressAcceptResult,
  InboundAcceptedHandle,
  InboundScheduleDecision,
  ConnectionInfo,
  IngressApi,
} from "./ingress.js";

// middleware
export type {
  MiddlewareLevel,
  MiddlewarePhase,
  MiddlewareOptions,
  TurnContext,
  StepContext,
  ToolCallContext,
  ToolCallNextOverride,
  ToolCallSummary,
  LlmUsage,
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
  LlmFinishReason,
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
  EventsApi,
  AgentExtensionApi,
  ConnectionExtensionApi,
  AgentExtension,
  ConnectionExtension,
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
  StepToolCallsSuppressedPayload,
  IngressReceivedPayload,
  IngressAcceptedPayload,
  IngressRejectedPayload,
  InboundAppendedPayload,
  InboundDuplicatePayload,
  InboundLeasedPayload,
  InboundDeliveredPayload,
  InboundBlockedPayload,
  InboundConsumedPayload,
  InboundFailedPayload,
  InboundDeadLetteredPayload,
  HumanApprovalCreatedPayload,
  HumanTaskCreatedPayload,
  HumanTaskResolvedPayload,
  HumanTaskRejectedPayload,
  HumanApprovalReadyPayload,
  HumanApprovalResumingPayload,
  HumanApprovalCompletedPayload,
  HumanApprovalFailedPayload,
  HumanApprovalCanceledPayload,
  StepRetryPayload,
  RecoveryExhaustedPayload,
  CoreHarnessEvents,
  CustomHarnessEvents,
  HarnessEvents,
  CoreHarnessEventType,
  AgentScopeEventType,
  ConnectionScopeEventType,
  EventPayload,
} from "./events.js";
export { AGENT_SCOPE_EVENTS, CONNECTION_SCOPE_EVENTS } from "./events.js";

// config — includes value exports (defineHarness, env)
export type {
  EnvRef,
  EnvResolvable,
  ModelConfig,
  AgentConfig,
  ConnectionConfig,
  DurableInboundConfig,
  HumanApprovalConfig,
  ConversationTurnCoordinatorStatus,
  ConversationTurnCoordinatorRejectReason,
  ConversationTurnStartPurpose,
  ConversationTurnCoordinatorAcquireInput,
  ConversationTurnCoordinatorAcquireResult,
  ConversationTurnCoordinator,
  HarnessConfig,
  ProcessTurnOptions,
} from "./config.js";
export { defineHarness, env } from "./config.js";

// runtime
export type {
  AbortResult,
  ControlApi,
  DurableControlApi,
  HumanApprovalResumeResult,
  HarnessRuntime,
  DurableHarnessRuntime,
  RuntimeEventListener,
  RuntimeEventType,
  RuntimeEventsApi,
  RuntimeEventUnsubscribeFn,
} from "./runtime.js";

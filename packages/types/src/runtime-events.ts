/**
 * RuntimeEvent 타입 (O11y 이벤트 계약)
 * 원형: docs/specs/shared-types.md 섹션 9
 *
 * Runtime이 발행하는 관측성 이벤트의 계약.
 * 이 계약은 @goondan/openharness-types가 소유하며, Runtime은 발행자이다.
 */

export type RuntimeEventType =
  | "ingress.received"
  | "ingress.accepted"
  | "ingress.rejected"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "tool.called"
  | "tool.completed"
  | "tool.failed";

export interface RuntimeEventBase {
  /** 이벤트 종류 (discriminant) */
  type: RuntimeEventType;
  /** ISO 8601 타임스탬프 */
  timestamp: string;
  /** 이벤트를 발행한 에이전트 이름. ingress 단계에서는 아직 없을 수 있다. */
  agentName?: string;
  /** 에이전트 인스턴스 키. ingress 단계에서는 아직 없을 수 있다. */
  conversationId?: string;
  /** OTel 호환 추적 컨텍스트 */
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface IngressReceivedEvent extends RuntimeEventBase {
  type: "ingress.received";
  connectionName: string;
  connectorName: string;
  eventId: string;
}

export interface IngressAcceptedEvent extends RuntimeEventBase {
  type: "ingress.accepted";
  connectionName: string;
  connectorName: string;
  eventId: string;
  eventName: string;
  turnId: string;
  accepted: true;
}

export interface IngressRejectedEvent extends RuntimeEventBase {
  type: "ingress.rejected";
  connectionName: string;
  connectorName: string;
  eventId: string;
  eventName?: string;
  turnId?: string;
  errorMessage: string;
  errorCode?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TurnStartedEvent extends RuntimeEventBase {
  type: "turn.started";
  turnId: string;
}

export interface TurnCompletedEvent extends RuntimeEventBase {
  type: "turn.completed";
  turnId: string;
  /** 실제 실행된 Step 수 (0이 아닌 실측값이어야 한다) */
  stepCount: number;
  /** Turn 소요 시간 (밀리초) */
  duration: number;
  /** 토큰 사용량 */
  tokenUsage?: TokenUsage;
}

export interface TurnFailedEvent extends RuntimeEventBase {
  type: "turn.failed";
  turnId: string;
  duration: number;
  errorMessage: string;
}

export interface StepStartedLlmInputMessage {
  role: string;
  content: string;
  contentSource?: StepStartedLlmInputMessageContentSource;
  parts?: StepStartedLlmInputMessagePart[];
}

export type StepStartedLlmInputMessageContentSource = "verbatim" | "summary";

export interface StepStartedLlmInputTextPart {
  type: "text";
  text: string;
  truncated?: true;
}

export interface StepStartedLlmInputToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
  truncated?: true;
}

export interface StepStartedLlmInputToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
  truncated?: true;
}

export type StepStartedLlmInputMessagePart =
  | StepStartedLlmInputTextPart
  | StepStartedLlmInputToolCallPart
  | StepStartedLlmInputToolResultPart;

export interface StepStartedEvent extends RuntimeEventBase {
  type: "step.started";
  stepId: string;
  stepIndex: number;
  turnId: string;
  /** 관측 목적의 LLM 입력 메시지 요약 (선택) */
  llmInputMessages?: StepStartedLlmInputMessage[];
}

export interface StepCompletedEvent extends RuntimeEventBase {
  type: "step.completed";
  stepId: string;
  stepIndex: number;
  turnId: string;
  toolCallCount: number;
  duration: number;
  /** Step 단위 토큰 사용량 (선택) */
  tokenUsage?: TokenUsage;
}

export interface StepFailedEvent extends RuntimeEventBase {
  type: "step.failed";
  stepId: string;
  stepIndex: number;
  turnId: string;
  duration: number;
  errorMessage: string;
}

export interface ToolCalledEvent extends RuntimeEventBase {
  type: "tool.called";
  toolCallId: string;
  toolName: string;
  stepId: string;
  turnId: string;
}

export interface ToolCompletedEvent extends RuntimeEventBase {
  type: "tool.completed";
  toolCallId: string;
  toolName: string;
  status: "ok" | "error";
  duration: number;
  stepId: string;
  turnId: string;
}

export interface ToolFailedEvent extends RuntimeEventBase {
  type: "tool.failed";
  toolCallId: string;
  toolName: string;
  duration: number;
  stepId: string;
  turnId: string;
  errorMessage: string;
}

export type RuntimeEvent =
  | IngressReceivedEvent
  | IngressAcceptedEvent
  | IngressRejectedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | ToolCalledEvent
  | ToolCompletedEvent
  | ToolFailedEvent;

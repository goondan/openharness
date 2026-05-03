import type { TurnResult, StepResult, StepSummary } from "./middleware.js";
import type { ToolResult, JsonObject, HumanTaskType } from "./tool.js";
import type {
  ConversationBlockerRef,
  InboundItemStatus,
  IngressDisposition,
} from "./ingress.js";

// -----------------------------------------------------------------------
// Core execution event payloads
// -----------------------------------------------------------------------

export interface TurnStartPayload {
  type: "turn.start";
  turnId: string;
  agentName: string;
  conversationId: string;
}

export interface TurnDonePayload {
  type: "turn.done";
  turnId: string;
  agentName: string;
  conversationId: string;
  result: TurnResult;
}

export interface TurnErrorPayload {
  type: "turn.error";
  turnId: string;
  agentName: string;
  conversationId: string;
  status: "aborted" | "error";
  error: Error;
}

export interface StepStartPayload {
  type: "step.start";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
}

export interface StepDonePayload {
  type: "step.done";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  result: StepResult;
}

export interface StepErrorPayload {
  type: "step.error";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  error: Error;
}

export interface ToolStartPayload {
  type: "tool.start";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  args: JsonObject;
}

export interface ToolDonePayload {
  type: "tool.done";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  result: ToolResult;
}

export interface ToolErrorPayload {
  type: "tool.error";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  error: Error;
}

// -----------------------------------------------------------------------
// Streaming event payloads (FR-CORE-010)
// -----------------------------------------------------------------------

export interface StepTextDeltaPayload {
  type: "step.textDelta";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  delta: string;
}

export interface StepToolCallDeltaPayload {
  type: "step.toolCallDelta";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  argsDelta: string;
}

// -----------------------------------------------------------------------
// Ingress event payloads
// -----------------------------------------------------------------------

export interface IngressReceivedPayload {
  type: "ingress.received";
  connectionName: string;
  payload: unknown;
  receivedAt: string;
}

export interface IngressAcceptedPayload {
  type: "ingress.accepted";
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName?: string;
  turnId?: string;
  disposition: IngressDisposition;
  inboundItemId?: string;
  blocker?: ConversationBlockerRef;
}

export interface IngressRejectedPayload {
  type: "ingress.rejected";
  connectionName: string;
  reason: string;
}

// -----------------------------------------------------------------------
// Durable inbound event payloads
// -----------------------------------------------------------------------

export interface InboundAppendedPayload {
  type: "inbound.appended";
  inboundItemId: string;
  agentName: string;
  conversationId: string;
  sequence: number;
  idempotencyKey: string;
}

export interface InboundDuplicatePayload {
  type: "inbound.duplicate";
  inboundItemId: string;
  agentName: string;
  conversationId: string;
  idempotencyKey: string;
  status: InboundItemStatus;
}

export interface InboundLeasedPayload {
  type: "inbound.leased";
  inboundItemId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface InboundDeliveredPayload {
  type: "inbound.delivered";
  inboundItemId: string;
  turnId: string;
  sequence: number;
}

export interface InboundBlockedPayload {
  type: "inbound.blocked";
  inboundItemId: string;
  blockedBy: ConversationBlockerRef;
}

export interface InboundConsumedPayload {
  type: "inbound.consumed";
  inboundItemId: string;
  turnId: string;
  commitRef: string;
}

export interface InboundFailedPayload {
  type: "inbound.failed";
  inboundItemId: string;
  attempt: number;
  retryable: boolean;
  reason: string;
}

export interface InboundDeadLetteredPayload {
  type: "inbound.deadLettered";
  inboundItemId: string;
  reason: string;
}

// -----------------------------------------------------------------------
// Human Approval event payloads
// -----------------------------------------------------------------------

export interface HumanApprovalCreatedPayload {
  type: "humanApproval.created";
  humanApprovalId: string;
  agentName: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
}

export interface HumanTaskCreatedPayload {
  type: "humanTask.created";
  humanApprovalId: string;
  humanTaskId: string;
  taskType: HumanTaskType;
  agentName: string;
  conversationId: string;
}

export interface HumanTaskResolvedPayload {
  type: "humanTask.resolved";
  humanTaskId: string;
  humanApprovalId: string;
  idempotencyKey: string;
}

export interface HumanTaskRejectedPayload {
  type: "humanTask.rejected";
  humanTaskId: string;
  humanApprovalId: string;
  idempotencyKey: string;
}

export interface HumanApprovalReadyPayload {
  type: "humanApproval.ready";
  humanApprovalId: string;
  taskIds: string[];
}

export interface HumanApprovalResumingPayload {
  type: "humanApproval.resuming";
  humanApprovalId: string;
  leaseOwner: string;
  turnId: string;
}

export interface HumanApprovalCompletedPayload {
  type: "humanApproval.completed";
  humanApprovalId: string;
  turnId: string;
  blockedInboundItemIds: string[];
}

export interface HumanApprovalFailedPayload {
  type: "humanApproval.failed";
  humanApprovalId: string;
  retryable: boolean;
  reason: string;
}

export interface HumanApprovalCanceledPayload {
  type: "humanApproval.canceled";
  humanApprovalId: string;
  reason?: string;
}

// -----------------------------------------------------------------------
// Union
// -----------------------------------------------------------------------

export type EventPayload =
  | TurnStartPayload
  | TurnDonePayload
  | TurnErrorPayload
  | StepStartPayload
  | StepDonePayload
  | StepErrorPayload
  | StepTextDeltaPayload
  | StepToolCallDeltaPayload
  | ToolStartPayload
  | ToolDonePayload
  | ToolErrorPayload
  | IngressReceivedPayload
  | IngressAcceptedPayload
  | IngressRejectedPayload
  | InboundAppendedPayload
  | InboundDuplicatePayload
  | InboundLeasedPayload
  | InboundDeliveredPayload
  | InboundBlockedPayload
  | InboundConsumedPayload
  | InboundFailedPayload
  | InboundDeadLetteredPayload
  | HumanApprovalCreatedPayload
  | HumanTaskCreatedPayload
  | HumanTaskResolvedPayload
  | HumanTaskRejectedPayload
  | HumanApprovalReadyPayload
  | HumanApprovalResumingPayload
  | HumanApprovalCompletedPayload
  | HumanApprovalFailedPayload
  | HumanApprovalCanceledPayload;

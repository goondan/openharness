import type { TurnResult, StepResult, StepSummary } from "./middleware.js";
import type { ToolResult, JsonObject } from "./tool.js";
import type { IngressDisposition } from "./ingress.js";
import type { HitlBatchView, HitlRequestView } from "./hitl.js";

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
// HITL event payloads
// -----------------------------------------------------------------------

export interface HitlBatchRequestedPayload {
  type: "hitl.batch.requested";
  batch: HitlBatchView;
}

export interface HitlRequestedPayload {
  type: "hitl.requested";
  request: HitlRequestView;
}

export interface HitlResolvedPayload {
  type: "hitl.resolved";
  batchId: string;
  requestId: string;
  turnId: string;
  toolCallId: string;
  conversationId: string;
}

export interface HitlRejectedPayload {
  type: "hitl.rejected";
  batchId: string;
  requestId: string;
  turnId: string;
  toolCallId: string;
  conversationId: string;
  reason?: string;
}

export interface HitlBatchReadyPayload {
  type: "hitl.batch.ready";
  batchId: string;
  requestIds: string[];
}

export interface HitlBatchResumingPayload {
  type: "hitl.batch.resuming";
  batchId: string;
  requestIds: string[];
}

export interface HitlCompletedPayload {
  type: "hitl.completed";
  batchId: string;
  requestId: string;
  turnId: string;
  toolCallId: string;
  conversationId: string;
  result: ToolResult;
}

export interface HitlBatchCompletedPayload {
  type: "hitl.batch.completed";
  batchId: string;
  requestIds: string[];
}

export interface HitlFailedPayload {
  type: "hitl.failed";
  batchId: string;
  requestId?: string;
  turnId?: string;
  toolCallId?: string;
  conversationId?: string;
  retryable: boolean;
  error: Error;
}

export interface HitlSteerQueuedPayload {
  type: "hitl.steer.queued";
  batchId: string;
  conversationId: string;
  queuedInputId: string;
}

export interface HitlRecoveryPayload {
  type: "hitl.recovery";
  recoveredBatches: number;
  pendingBatches: number;
  queuedForResume: number;
  error?: Error;
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
  turnId?: string;
  batchId?: string;
  disposition: IngressDisposition;
}

export interface IngressRejectedPayload {
  type: "ingress.rejected";
  connectionName: string;
  reason: string;
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
  | HitlBatchRequestedPayload
  | HitlRequestedPayload
  | HitlResolvedPayload
  | HitlRejectedPayload
  | HitlBatchReadyPayload
  | HitlBatchResumingPayload
  | HitlCompletedPayload
  | HitlBatchCompletedPayload
  | HitlFailedPayload
  | HitlSteerQueuedPayload
  | HitlRecoveryPayload
  | IngressReceivedPayload
  | IngressAcceptedPayload
  | IngressRejectedPayload;

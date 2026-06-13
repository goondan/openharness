import type { TurnResult, StepResult } from "./middleware.js";
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

export interface StepToolCallsSuppressedPayload {
  type: "step.toolCallsSuppressed";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  reason: "humanApprovalBarrier";
  committedToolCallId: string;
  suppressedToolCalls: Array<{
    toolCallId: string;
    toolName: string;
  }>;
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
// Event registry
//
// `CoreHarnessEvents` is the fixed map of event name → payload that the runtime
// emits (29 core events). `CustomHarnessEvents` is an open interface extensions
// augment via `declare module` to add their own typed events. `HarnessEvents`
// is the merged view used for typed `on`/`emit`/`tap`.
// -----------------------------------------------------------------------

export interface CoreHarnessEvents {
  "turn.start": TurnStartPayload;
  "turn.done": TurnDonePayload;
  "turn.error": TurnErrorPayload;
  "step.start": StepStartPayload;
  "step.done": StepDonePayload;
  "step.error": StepErrorPayload;
  "step.textDelta": StepTextDeltaPayload;
  "step.toolCallDelta": StepToolCallDeltaPayload;
  "step.toolCallsSuppressed": StepToolCallsSuppressedPayload;
  "tool.start": ToolStartPayload;
  "tool.done": ToolDonePayload;
  "tool.error": ToolErrorPayload;
  "ingress.received": IngressReceivedPayload;
  "ingress.accepted": IngressAcceptedPayload;
  "ingress.rejected": IngressRejectedPayload;
  "inbound.appended": InboundAppendedPayload;
  "inbound.duplicate": InboundDuplicatePayload;
  "inbound.leased": InboundLeasedPayload;
  "inbound.delivered": InboundDeliveredPayload;
  "inbound.blocked": InboundBlockedPayload;
  "inbound.consumed": InboundConsumedPayload;
  "inbound.failed": InboundFailedPayload;
  "inbound.deadLettered": InboundDeadLetteredPayload;
  "humanApproval.created": HumanApprovalCreatedPayload;
  "humanTask.created": HumanTaskCreatedPayload;
  "humanTask.resolved": HumanTaskResolvedPayload;
  "humanTask.rejected": HumanTaskRejectedPayload;
  "humanApproval.ready": HumanApprovalReadyPayload;
  "humanApproval.resuming": HumanApprovalResumingPayload;
  "humanApproval.completed": HumanApprovalCompletedPayload;
  "humanApproval.failed": HumanApprovalFailedPayload;
  "humanApproval.canceled": HumanApprovalCanceledPayload;
}

/**
 * Open interface for extension-defined events. Augment it with `declare module`:
 *
 * @example
 * declare module "@goondan/openharness-types" {
 *   interface CustomHarnessEvents {
 *     "myext.cacheWarmed": { type: "myext.cacheWarmed"; keys: number };
 *   }
 * }
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface CustomHarnessEvents {}

/** Merged event map: core events plus any declared custom events. */
export type HarnessEvents = CoreHarnessEvents & CustomHarnessEvents;

/** All core event names. */
export type CoreHarnessEventType = keyof CoreHarnessEvents;

/**
 * @deprecated Use {@link HarnessEvents} keys with typed `on`/`emit`. Retained as
 * the union of core payloads for back-compat.
 */
export type EventPayload = CoreHarnessEvents[CoreHarnessEventType];

// -----------------------------------------------------------------------
// Scope split
//
// Agent-scoped events flow on a per-agent bus (turn/step/tool/human-approval
// lifecycle, plus the turn-coupled inbound transitions). Connection-scoped
// events belong to ingress/dispatch. The two arrays are disjoint and together
// cover every core event; `create-harness` wiring is verified against them.
// -----------------------------------------------------------------------

export const AGENT_SCOPE_EVENTS = [
  "turn.start",
  "turn.done",
  "turn.error",
  "step.start",
  "step.done",
  "step.error",
  "step.textDelta",
  "step.toolCallDelta",
  "step.toolCallsSuppressed",
  "tool.start",
  "tool.done",
  "tool.error",
  "inbound.delivered",
  "inbound.consumed",
  "inbound.failed",
  "inbound.deadLettered",
  "humanApproval.created",
  "humanTask.created",
  "humanTask.resolved",
  "humanTask.rejected",
  "humanApproval.ready",
  "humanApproval.resuming",
  "humanApproval.completed",
  "humanApproval.failed",
  "humanApproval.canceled",
] as const;

export const CONNECTION_SCOPE_EVENTS = [
  "ingress.received",
  "ingress.accepted",
  "ingress.rejected",
  "inbound.appended",
  "inbound.duplicate",
  "inbound.leased",
  "inbound.blocked",
] as const;

export type AgentScopeEventType = (typeof AGENT_SCOPE_EVENTS)[number];
export type ConnectionScopeEventType = (typeof CONNECTION_SCOPE_EVENTS)[number];

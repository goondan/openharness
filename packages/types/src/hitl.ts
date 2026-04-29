import type { MessageEvent } from "./conversation.js";
import type { InboundEnvelope } from "./ingress.js";
import type { ToolResult, JsonObject, JsonSchema, JsonValue } from "./tool.js";
import type { ToolCallContext } from "./middleware.js";

export type HitlDecision = "approve" | "reject";

export type HitlResponseSchema =
  | { type: "approval" }
  | { type: "text"; schema?: JsonSchema; minLength?: number; maxLength?: number }
  | { type: "form"; schema: JsonSchema };

export type HitlCondition = (
  ctx: ToolCallContext,
) => boolean | Promise<boolean>;

export type HitlResultMapperResult =
  | { action: "approve"; args?: JsonObject }
  | { action: "reject"; result?: ToolResult };

export type HitlResultMapper = (
  input: {
    request: HitlRequestRecord;
    result: HitlHumanResult;
  },
) => HitlResultMapperResult | Promise<HitlResultMapperResult>;

export type HitlPolicy =
  | { mode: "never" }
  | {
      mode: "required" | "conditional";
      when?: HitlCondition;
      prompt?: string | ((ctx: ToolCallContext) => string);
      response: HitlResponseSchema;
      mapResult?: HitlResultMapper;
      ttlMs?: number;
      onTimeout?: "reject" | "expire";
    };

export type HitlBatchStatus =
  | "preparing"
  | "waitingForHuman"
  | "ready"
  | "resuming"
  | "continuing"
  | "completed"
  | "failed"
  | "expired"
  | "canceled"
  | "blocked";

export type HitlRequestStatus =
  | "pending"
  | "resolved"
  | "rejected"
  | "completed"
  | "failed"
  | "expired"
  | "canceled"
  | "blocked";

export type HitlHumanResult =
  | { kind: "approve"; approved?: true; value?: boolean | string | JsonObject; submittedBy?: string; submittedAt?: string; comment?: string }
  | { kind: "reject"; approved?: false; reason?: string; submittedBy?: string; submittedAt?: string; comment?: string }
  | { kind: "text"; value: string; submittedBy?: string; submittedAt?: string; comment?: string }
  | { kind: "form"; value: JsonObject; submittedBy?: string; submittedAt?: string; comment?: string }
  // Backward-compatible input shape accepted by the runtime.
  | { decision: "approve"; value?: boolean | string | JsonObject; submittedBy?: string; submittedAt?: string; comment?: string }
  | { decision: "reject"; reason?: string; submittedBy?: string; submittedAt?: string; comment?: string };

export interface HitlCompletion {
  toolResult: ToolResult;
  finalArgs?: JsonObject;
  completedAt: string;
}

export interface HitlFailure {
  error: string;
  retryable: boolean;
  failedAt: string;
}

export interface HitlLease {
  ownerId: string;
  token: string;
  expiresAt: string;
}

export interface HitlLeaseGuard {
  ownerId: string;
  token: string;
}

export interface HitlBatchToolCallSnapshot {
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  toolArgs: JsonObject;
  requiresHitl: boolean;
  requestId?: string;
}

export interface HitlBatchToolExecutionMarker {
  batchId?: string;
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  requestId?: string;
  startedAt: string;
}

export interface HitlBatchToolResult {
  batchId: string;
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  result: ToolResult;
  finalArgs?: JsonObject;
  recordedAt: string;
}

export interface HitlBatchAppendCommit {
  committedAt: string;
  toolResultEventIds: string[];
  queuedSteerEventIds: string[];
  queuedSteerIds: string[];
  continuationTurnId: string;
  conversationEvents?: MessageEvent[];
}

export interface HitlBatchCompletion {
  completedAt: string;
  continuationTurnId: string;
  continuationStatus: "completed" | "maxStepsReached" | "waitingForHuman";
}

export interface HitlBatchRecord {
  batchId: string;
  status: HitlBatchStatus;
  agentName: string;
  conversationId: string;
  turnId: string;
  stepNumber: number;
  toolCalls: HitlBatchToolCallSnapshot[];
  toolResults: HitlBatchToolResult[];
  toolExecutions: HitlBatchToolExecutionMarker[];
  conversationEvents: MessageEvent[];
  createdAt: string;
  updatedAt: string;
  lease?: HitlLease;
  appendCommit?: HitlBatchAppendCommit;
  completion?: HitlBatchCompletion;
  failure?: HitlFailure;
  metadata?: Record<string, JsonValue>;
}

export interface HitlRequestRecord {
  requestId: string;
  batchId?: string;
  status: HitlRequestStatus;
  agentName: string;
  conversationId: string;
  turnId: string;
  stepNumber: number;
  toolCallId: string;
  toolCallIndex?: number;
  toolName: string;
  originalArgs: JsonObject;
  finalArgs?: JsonObject;
  prompt?: string;
  responseSchema: HitlResponseSchema;
  conversationEvents?: MessageEvent[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  result?: HitlHumanResult;
  completion?: HitlCompletion;
  failure?: HitlFailure;
  lease?: HitlLease;
  metadata?: Record<string, JsonValue>;
}

export type HitlRequestView = HitlRequestRecord & {
  hasConversationSnapshot?: boolean;
};

export interface HitlBatchView extends HitlBatchRecord {
  requests: HitlRequestView[];
  queuedSteerCount: number;
}

export interface HitlBatchFilter {
  agentName?: string;
  conversationId?: string;
  status?: HitlBatchStatus | HitlBatchStatus[];
}

export interface HitlRequestFilter {
  agentName?: string;
  conversationId?: string;
  batchId?: string;
  status?: HitlRequestStatus | HitlRequestStatus[];
}

export interface HitlQueuedSteerInput {
  source: "ingress" | "dispatch";
  envelope: InboundEnvelope;
  receivedAt: string;
  metadata?: Record<string, JsonValue>;
}

export interface HitlQueuedSteer extends HitlQueuedSteerInput {
  queuedInputId: string;
  batchId: string;
  status: "queued" | "draining" | "drained" | "canceled";
}

export type CreateHitlBatchResult =
  | { status: "created"; batch: HitlBatchRecord; requests: HitlRequestRecord[] }
  | { status: "conflict"; openBatch: HitlBatchRecord };

export type HitlBatchLeaseResult =
  | { status: "acquired"; guard: HitlLeaseGuard; batch: HitlBatchRecord }
  | { status: "busy"; batch: HitlBatchRecord | null };

export interface SubmitHitlResultInput {
  requestId: string;
  result: HitlHumanResult;
  idempotencyKey?: string;
  agentName?: string;
  conversationId?: string;
}

export type HitlSubmitResume =
  | { status: "waitingForPeers"; batchId: string; pendingRequestIds: string[] }
  | { status: "scheduled"; batchId: string; requestIds: string[] }
  | { status: "error"; batchId?: string; requestId: string; error: string };

export type SubmitHitlResult =
  | { status: "accepted"; request: HitlRequestView; resume: HitlSubmitResume }
  | { status: "duplicate"; request: HitlRequestView; resume?: HitlSubmitResume }
  | { status: "notFound"; requestId: string }
  | { status: "invalid"; requestId: string; error: string }
  | { status: "error"; requestId: string; request?: HitlRequestView; error: string };

export type ResumeHitlResult =
  | { status: "completed"; batch: HitlBatchView; result?: ToolResult }
  | { status: "scheduled"; batchId: string }
  | { status: "alreadyCompleted"; batch: HitlBatchView }
  | { status: "notReady"; batch: HitlBatchView; pendingRequestIds: string[] }
  | { status: "notFound"; batchId?: string; requestId?: string }
  | { status: "leaseConflict"; batch: HitlBatchView | null }
  | { status: "failed"; batch: HitlBatchView; error: string }
  | { status: "error"; batchId?: string; requestId?: string; batch?: HitlBatchView; error: string };

export interface CancelHitlBatchInput {
  batchId: string;
  reason?: string;
}

export interface CancelHitlInput {
  requestId: string;
  reason?: string;
}

export type CancelHitlResult =
  | { status: "canceled"; batch: HitlBatchView }
  | { status: "notFound"; batchId?: string; requestId?: string }
  | { status: "notCancelable"; batch: HitlBatchView }
  | { status: "error"; batchId?: string; requestId?: string; batch?: HitlBatchView; error: string };

export interface HitlStore {
  createBatch(input: {
    batch: HitlBatchRecord;
    requests: HitlRequestRecord[];
  }): Promise<CreateHitlBatchResult>;

  getBatch(batchId: string): Promise<HitlBatchRecord | null>;
  getRequest(requestId: string): Promise<HitlRequestRecord | null>;
  listPendingBatches(filter?: HitlBatchFilter): Promise<HitlBatchRecord[]>;
  listPendingRequests(filter?: HitlRequestFilter): Promise<HitlRequestRecord[]>;
  listBatchRequests(batchId: string): Promise<HitlRequestRecord[]>;
  listBatchToolResults(batchId: string): Promise<HitlBatchToolResult[]>;
  listRecoverableBatches(filter?: HitlBatchFilter): Promise<HitlBatchRecord[]>;
  getOpenBatchByConversation(agentName: string, conversationId: string): Promise<HitlBatchRecord | null>;

  startBatchToolExecution(
    batchId: string,
    marker: HitlBatchToolExecutionMarker,
  ): Promise<HitlBatchRecord>;
  recordBatchToolResult(batchId: string, result: HitlBatchToolResult): Promise<HitlBatchRecord>;
  markBatchWaitingForHuman(batchId: string): Promise<HitlBatchRecord>;

  resolveRequest(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord>;
  rejectRequest(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord>;

  enqueueSteer(batchId: string, input: HitlQueuedSteerInput): Promise<HitlQueuedSteer>;
  drainQueuedSteers(batchId: string, guard: HitlLeaseGuard): Promise<HitlQueuedSteer[]>;
  listQueuedSteers?(batchId: string): Promise<HitlQueuedSteer[]>;

  acquireBatchLease(batchId: string, ownerId: string, ttlMs: number): Promise<HitlBatchLeaseResult>;
  startRequestExecution(requestId: string, guard: HitlLeaseGuard, startedAt: string): Promise<HitlRequestRecord>;
  completeRequestWithToolResult(input: {
    batchId: string;
    requestId: string;
    toolResult: HitlBatchToolResult;
    completion: HitlCompletion;
    guard: HitlLeaseGuard;
  }): Promise<{ batch: HitlBatchRecord; request: HitlRequestRecord }>;
  completeRequest(requestId: string, completion: HitlCompletion, guard: HitlLeaseGuard): Promise<HitlRequestRecord>;
  failRequest(requestId: string, failure: HitlFailure, guard: HitlLeaseGuard): Promise<HitlRequestRecord>;
  commitBatchAppend(batchId: string, appendCommit: HitlBatchAppendCommit, guard: HitlLeaseGuard): Promise<HitlBatchRecord>;
  completeBatch(batchId: string, completion: HitlBatchCompletion, guard: HitlLeaseGuard): Promise<HitlBatchRecord>;
  failBatch(batchId: string, failure: HitlFailure, guard?: HitlLeaseGuard): Promise<HitlBatchRecord>;
  cancelBatch(batchId: string, reason?: string): Promise<HitlBatchRecord>;
  releaseBatchLease(batchId: string, guard: HitlLeaseGuard): Promise<void>;
}

export interface HitlRuntimeConfig {
  store: HitlStore;
  leaseTtlMs?: number;
  resumeOnStartup?: boolean;
}

// Backward-compatible exported names for older callers. New code should use
// batch-oriented names above.
export type CreateHitlRequestResult = CreateHitlBatchResult;
export type HitlLeaseResult = HitlBatchLeaseResult;

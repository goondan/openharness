import type { JsonObject, JsonSchema } from "@goondan/openharness-types";
import type { ConversationBlockerRef, LeaseInfo } from "../inbound/types.js";

export type HumanApprovalStatus =
  | "preparing"
  | "waitingForHuman"
  | "ready"
  | "resuming"
  | "completed"
  | "blocked"
  | "canceled"
  | "expired"
  | "failed";

export type HumanTaskStatus =
  | "waitingForHuman"
  | "resolved"
  | "rejected"
  | "canceled"
  | "expired";

export type HumanTaskType = "approval" | "text" | "form" | (string & {});

export type HumanResult =
  | { type: "approval"; approved: true; argsPatch?: JsonObject }
  | { type: "rejection"; reason?: string }
  | { type: "text"; text: string }
  | { type: "form"; data: JsonObject };

export interface HumanApprovalToolCallSnapshot {
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  toolArgs: JsonObject;
}

export interface HumanTaskCreateInput {
  humanTaskId?: string;
  type?: HumanTaskType;
  taskType?: HumanTaskType;
  title?: string;
  prompt?: string;
  required?: boolean;
  responseSchema?: JsonSchema;
  metadata?: Record<string, unknown>;
}

export interface HumanTaskRecord {
  id: string;
  humanApprovalId: string;
  taskType: HumanTaskType;
  status: HumanTaskStatus;
  title?: string;
  prompt?: string;
  required: boolean;
  responseSchema?: JsonSchema;
  result?: HumanResult;
  resultIdempotencyKey?: string;
  submittedBy?: string;
  submittedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface HumanTaskView extends HumanTaskRecord {
  agentName: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
}

export interface HumanApprovalRecord {
  id: string;
  status: HumanApprovalStatus;
  toolCall: HumanApprovalToolCallSnapshot;
  prompt?: string;
  expectedResultSchema?: JsonSchema;
  conversationCursor?: string;
  conversationSnapshot?: unknown;
  taskIds: string[];
  blocker: ConversationBlockerRef;
  blockedInboundItemIds?: string[];
  handlerStartedAt?: string;
  lease?: LeaseInfo;
  failure?: HumanApprovalFailureInfo;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HumanApprovalFailureInfo {
  reason: string;
  retryable: boolean;
  failedAt: string;
}

export interface CreateHumanApprovalInput {
  id?: string;
  humanApprovalId?: string;
  policy?: unknown;
  toolCall: HumanApprovalToolCallSnapshot;
  prompt?: string;
  expectedResultSchema?: JsonSchema;
  conversationCursor?: string;
  conversationSnapshot?: unknown;
  tasks: HumanTaskCreateInput[];
  now?: string;
}

export interface CreateHumanApprovalResult {
  approval: HumanApprovalRecord;
  tasks: HumanTaskRecord[];
  blocker: ConversationBlockerRef;
  created: boolean;
  duplicate: boolean;
}

export interface HumanTaskFilter {
  agentName?: string;
  conversationId?: string;
  humanApprovalId?: string;
  status?: HumanTaskStatus | HumanTaskStatus[];
  statuses?: HumanTaskStatus[];
  taskTypes?: HumanTaskType[];
  limit?: number;
}

export interface SubmitHumanResultInput {
  humanTaskId: string;
  result: HumanResult;
  idempotencyKey: string;
  submittedBy?: string;
  agentName?: string;
  conversationId?: string;
  now?: string;
}

export type SubmitHumanResult =
  | {
      status: "accepted" | "duplicate";
      task: HumanTaskRecord;
      approval: HumanApprovalRecord;
      approvalReady: boolean;
    }
  | {
      status: "notFound" | "invalid";
      reason: string;
    };

export interface AcquireHumanApprovalInput {
  humanApprovalId: string;
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: string;
}

export interface CompleteHumanApprovalInput {
  humanApprovalId: string;
  leaseOwner?: string;
  blockedInboundItemIds?: string[];
  now?: string;
}

export interface MarkHumanApprovalHandlerStartedInput {
  humanApprovalId: string;
  leaseOwner?: string;
  now?: string;
}

export interface FailHumanApprovalInput {
  humanApprovalId: string;
  reason: string;
  retryable: boolean;
  leaseOwner?: string;
  now?: string;
}

export interface CancelHumanApprovalInput {
  humanApprovalId: string;
  reason?: string;
  expired?: boolean;
  status?: Extract<HumanApprovalStatus, "canceled" | "expired">;
  now?: string;
}

export interface HumanApprovalRecoveryFilter {
  agentName?: string;
  conversationId?: string;
  includeFailed?: boolean;
  limit?: number;
}

export interface HumanApprovalStore {
  createApproval(input: CreateHumanApprovalInput): Promise<CreateHumanApprovalResult>;
  listTasks(filter: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  acquireApprovalForResume(input: AcquireHumanApprovalInput): Promise<HumanApprovalRecord | null>;
  markApprovalHandlerStarted(input: MarkHumanApprovalHandlerStartedInput): Promise<HumanApprovalRecord>;
  markApprovalCompleted(input: CompleteHumanApprovalInput): Promise<HumanApprovalRecord>;
  markApprovalFailed(input: FailHumanApprovalInput): Promise<HumanApprovalRecord>;
  cancelApproval(input: CancelHumanApprovalInput): Promise<HumanApprovalRecord>;
  listRecoverableApprovals(filter?: HumanApprovalRecoveryFilter): Promise<HumanApprovalRecord[]>;
}

export interface HumanApprovalReferenceStore extends HumanApprovalStore {
  getApproval(id: string): Promise<HumanApprovalRecord | null>;
  getTask(id: string): Promise<HumanTaskRecord | null>;
  getConversationBlocker(input: {
    agentName: string;
    conversationId: string;
  }): Promise<ConversationBlockerRef | null>;
}

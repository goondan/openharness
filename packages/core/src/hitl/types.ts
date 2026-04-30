import type { JsonObject, JsonSchema } from "@goondan/openharness-types";
import type { ConversationBlockerRef, LeaseInfo } from "../inbound/types.js";

export type HumanGateStatus =
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

export interface HumanGateToolCallSnapshot {
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
  humanGateId: string;
  taskType: HumanTaskType;
  status: HumanTaskStatus;
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

export interface HumanGateRecord {
  id: string;
  status: HumanGateStatus;
  toolCall: HumanGateToolCallSnapshot;
  prompt?: string;
  expectedResultSchema?: JsonSchema;
  conversationCursor?: string;
  conversationSnapshot?: unknown;
  taskIds: string[];
  blocker: ConversationBlockerRef;
  blockedInboundItemIds?: string[];
  handlerStartedAt?: string;
  lease?: LeaseInfo;
  failure?: HumanGateFailureInfo;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HumanGateFailureInfo {
  reason: string;
  retryable: boolean;
  failedAt: string;
}

export interface CreateHumanGateInput {
  id?: string;
  humanGateId?: string;
  policy?: unknown;
  toolCall: HumanGateToolCallSnapshot;
  prompt?: string;
  expectedResultSchema?: JsonSchema;
  conversationCursor?: string;
  conversationSnapshot?: unknown;
  tasks: HumanTaskCreateInput[];
  now?: string;
}

export interface CreateHumanGateResult {
  gate: HumanGateRecord;
  tasks: HumanTaskRecord[];
  blocker: ConversationBlockerRef;
  created: boolean;
  duplicate: boolean;
}

export interface HumanTaskFilter {
  agentName?: string;
  conversationId?: string;
  humanGateId?: string;
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
      gate: HumanGateRecord;
      gateReady: boolean;
    }
  | {
      status: "notFound" | "invalid";
      reason: string;
    };

export interface AcquireHumanGateInput {
  humanGateId: string;
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: string;
}

export interface CompleteHumanGateInput {
  humanGateId: string;
  leaseOwner?: string;
  blockedInboundItemIds?: string[];
  now?: string;
}

export interface MarkHumanGateHandlerStartedInput {
  humanGateId: string;
  leaseOwner?: string;
  now?: string;
}

export interface FailHumanGateInput {
  humanGateId: string;
  reason: string;
  retryable: boolean;
  leaseOwner?: string;
  now?: string;
}

export interface CancelHumanGateInput {
  humanGateId: string;
  reason?: string;
  status?: Extract<HumanGateStatus, "canceled" | "expired">;
  now?: string;
}

export interface HumanGateRecoveryFilter {
  agentName?: string;
  conversationId?: string;
  includeFailed?: boolean;
  limit?: number;
}

export interface HumanGateStore {
  createGate(input: CreateHumanGateInput): Promise<CreateHumanGateResult>;
  listTasks(filter: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  acquireGateForResume(input: AcquireHumanGateInput): Promise<HumanGateRecord | null>;
  markGateHandlerStarted(input: MarkHumanGateHandlerStartedInput): Promise<HumanGateRecord>;
  markGateCompleted(input: CompleteHumanGateInput): Promise<HumanGateRecord>;
  markGateFailed(input: FailHumanGateInput): Promise<HumanGateRecord>;
  cancelGate(input: CancelHumanGateInput): Promise<HumanGateRecord>;
  listRecoverableGates(filter?: HumanGateRecoveryFilter): Promise<HumanGateRecord[]>;
}

export interface HumanGateReferenceStore extends HumanGateStore {
  getGate(id: string): Promise<HumanGateRecord | null>;
  getTask(id: string): Promise<HumanTaskRecord | null>;
  getConversationBlocker(input: {
    agentName: string;
    conversationId: string;
  }): Promise<ConversationBlockerRef | null>;
}

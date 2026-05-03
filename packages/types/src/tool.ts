import type { Schema } from "ai";
import type { ConversationBlockerRef, LeaseInfo } from "./ingress.js";

// JsonSchema / primitive types
export type JsonSchema = Record<string, unknown>;
export type JsonSchemaWrapper = Schema;
export type ToolParameters = JsonSchema | JsonSchemaWrapper;
export type JsonObject = Record<string, unknown>;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ToolResult
export type ToolResult =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "error"; error: string };

// ToolContext — used by tool handlers (distinct from ToolCallContext in middleware)
export interface ToolContext {
  conversationId: string;
  agentName: string;
  abortSignal: AbortSignal;
}

// Human Approval / durable HITL types
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

export type HumanTaskType = "approval" | "text" | "form";

export interface HumanTaskDefinition {
  taskType: HumanTaskType;
  title?: string;
  prompt?: string;
  required?: boolean;
  responseSchema?: JsonSchema;
}

export interface HumanApprovalPolicy {
  required?: boolean;
  prompt?: string;
  tasks?: HumanTaskDefinition[];
  responseSchema?: JsonSchema;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export type HumanResult =
  | { type: "approval"; approved: true; argsPatch?: JsonObject }
  | { type: "rejection"; reason?: string }
  | { type: "text"; text: string }
  | { type: "form"; data: JsonObject };

export interface ToolCallSnapshot {
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  toolArgs: JsonObject;
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

export interface HumanApprovalFailureInfo {
  reason: string;
  retryable: boolean;
  failedAt: string;
}

export interface HumanApprovalRecord {
  id: string;
  agentName: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  status: HumanApprovalStatus;
  toolCall: ToolCallSnapshot;
  prompt?: string;
  expectedResultSchema?: JsonSchema;
  conversationCursor?: string;
  conversationSnapshot?: unknown;
  taskIds: string[];
  requiredTaskIds?: string[];
  blocker: ConversationBlockerRef;
  blockedInboundItemIds?: string[];
  handlerStartedAt?: string;
  lease?: LeaseInfo;
  result?: HumanResult;
  failure?: HumanApprovalFailureInfo;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HumanTaskCreateInput {
  humanTaskId?: string;
  taskType: HumanTaskType;
  title?: string;
  prompt?: string;
  required?: boolean;
  responseSchema?: JsonSchema;
  metadata?: Record<string, unknown>;
}

export interface CreateHumanApprovalInput {
  id: string;
  toolCall: ToolCallSnapshot;
  tasks: HumanTaskCreateInput[];
  prompt?: string;
  expectedResultSchema?: JsonSchema;
  conversationCursor?: string;
  conversationSnapshot?: unknown;
  createdAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface CreateHumanApprovalResult {
  approval: HumanApprovalRecord;
  tasks: HumanTaskRecord[] | HumanTaskView[];
  blocker?: ConversationBlockerRef;
  duplicate: boolean;
}

export interface HumanTaskFilter {
  agentName?: string;
  conversationId?: string;
  humanApprovalId?: string;
  status?: HumanTaskStatus | HumanTaskStatus[];
  taskType?: HumanTaskType | HumanTaskType[];
  limit?: number;
}

export interface SubmitHumanResultInput {
  humanTaskId: string;
  result: HumanResult;
  idempotencyKey: string;
  agentName?: string;
  conversationId?: string;
  submittedAt?: string;
  submittedBy?: string;
  now?: string;
}

export type SubmitHumanResult =
  | {
      status: "accepted" | "duplicate";
      accepted?: true;
      duplicate: boolean;
      task: HumanTaskRecord | HumanTaskView;
      approval: HumanApprovalRecord;
      approvalReady?: boolean;
    }
  | {
      status: "notFound" | "invalid";
      accepted?: false;
      reason: string;
    };

export interface AcquireHumanApprovalInput {
  id: string;
  leaseOwner: string;
  leaseExpiresAt?: string;
  leaseTtlMs?: number;
  now?: string;
}

export interface CompleteHumanApprovalInput {
  id: string;
  leaseOwner?: string;
  turnId?: string;
  blockedInboundItemIds?: string[];
  now?: string;
}

export interface MarkHumanApprovalHandlerStartedInput {
  id: string;
  leaseOwner?: string;
  now?: string;
}

export interface FailHumanApprovalInput {
  id: string;
  reason: string;
  retryable: boolean;
  leaseOwner?: string;
  now?: string;
}

export interface CancelHumanApprovalInput {
  id: string;
  reason?: string;
  status?: Extract<HumanApprovalStatus, "canceled" | "expired">;
  now?: string;
}

export interface HumanApprovalRecoveryFilter {
  agentName?: string;
  conversationId?: string;
  status?: HumanApprovalStatus | HumanApprovalStatus[];
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

// ToolDefinition
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  humanApproval?: HumanApprovalPolicy;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}

// ToolInfo — lightweight summary (no handler)
export interface ToolInfo {
  name: string;
  description: string;
}

export function isJsonSchemaWrapper(value: unknown): value is JsonSchemaWrapper {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "jsonSchema" in value;
}

export function resolveToolParameters(parameters: ToolParameters | undefined): JsonSchema {
  if (!parameters) {
    return {};
  }

  if (isJsonSchemaWrapper(parameters)) {
    const schema = parameters.jsonSchema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema) || "then" in schema) {
      throw new Error("Tool parameters must resolve to a JSON schema object before registration");
    }
    return schema;
  }

  return parameters;
}

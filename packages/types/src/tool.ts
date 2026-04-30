import type { Schema } from "ai";
import type { ConversationBlockerRef } from "./ingress.js";

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
  type: HumanTaskType;
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

export interface HumanApprovalRecord {
  id: string;
  agentName: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  status: HumanApprovalStatus;
  toolCall: ToolCallSnapshot;
  taskIds: string[];
  requiredTaskIds: string[];
  blocker: ConversationBlockerRef;
  blockedInboundItemIds?: string[];
  handlerStartedAt?: string;
  lease?: {
    owner: string;
    expiresAt: string;
    token?: string;
  };
  result?: HumanResult;
  failure?: {
    reason: string;
    retryable: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HumanTaskView {
  id: string;
  humanApprovalId: string;
  type: HumanTaskType;
  status: HumanTaskStatus;
  agentName: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  title?: string;
  prompt?: string;
  responseSchema?: JsonSchema;
  result?: HumanResult;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHumanApprovalInput {
  id: string;
  toolCall: ToolCallSnapshot;
  policy: HumanApprovalPolicy;
  tasks: HumanTaskDefinition[];
  createdAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateHumanApprovalResult {
  approval: HumanApprovalRecord;
  tasks: HumanTaskView[];
  duplicate: boolean;
}

export interface HumanTaskFilter {
  agentName?: string;
  conversationId?: string;
  humanApprovalId?: string;
  status?: HumanTaskStatus | HumanTaskStatus[];
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
}

export interface SubmitHumanResult {
  accepted: true;
  duplicate: boolean;
  task: HumanTaskView;
  approval: HumanApprovalRecord;
}

export interface AcquireHumanApprovalInput {
  humanApprovalId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  now?: string;
}

export interface CompleteHumanApprovalInput {
  humanApprovalId: string;
  turnId: string;
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
  now?: string;
}

export interface CancelHumanApprovalInput {
  humanApprovalId: string;
  reason?: string;
  expired?: boolean;
  now?: string;
}

export interface HumanApprovalRecoveryFilter {
  agentName?: string;
  conversationId?: string;
  status?: HumanApprovalStatus | HumanApprovalStatus[];
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
  getConversationBlocker(input: {
    agentName: string;
    conversationId: string;
  }): Promise<ConversationBlockerRef | null>;
  getApproval(id: string): Promise<HumanApprovalRecord | null>;
  getTask(id: string): Promise<HumanTaskView | null>;
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

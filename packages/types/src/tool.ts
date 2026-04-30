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

export type HumanGatePolicy = HumanApprovalPolicy;

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

export interface HumanGateRecord {
  id: string;
  agentName: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  status: HumanGateStatus;
  toolCall: ToolCallSnapshot;
  taskIds: string[];
  requiredTaskIds: string[];
  blocker: ConversationBlockerRef;
  blockedInboundItemIds?: string[];
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
  humanGateId: string;
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

export interface CreateHumanGateInput {
  id: string;
  toolCall: ToolCallSnapshot;
  policy: HumanApprovalPolicy;
  tasks: HumanTaskDefinition[];
  createdAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateHumanGateResult {
  gate: HumanGateRecord;
  tasks: HumanTaskView[];
  duplicate: boolean;
}

export interface HumanTaskFilter {
  agentName?: string;
  conversationId?: string;
  humanGateId?: string;
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
  gate: HumanGateRecord;
}

export interface AcquireHumanGateInput {
  humanGateId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  now?: string;
}

export interface CompleteHumanGateInput {
  humanGateId: string;
  turnId: string;
  blockedInboundItemIds?: string[];
  now?: string;
}

export interface FailHumanGateInput {
  humanGateId: string;
  reason: string;
  retryable: boolean;
  now?: string;
}

export interface CancelHumanGateInput {
  humanGateId: string;
  reason?: string;
  expired?: boolean;
  now?: string;
}

export interface HumanGateRecoveryFilter {
  agentName?: string;
  conversationId?: string;
  status?: HumanGateStatus | HumanGateStatus[];
  limit?: number;
}

export interface HumanGateStore {
  createGate(input: CreateHumanGateInput): Promise<CreateHumanGateResult>;
  listTasks(filter: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  acquireGateForResume(input: AcquireHumanGateInput): Promise<HumanGateRecord | null>;
  markGateCompleted(input: CompleteHumanGateInput): Promise<HumanGateRecord>;
  markGateFailed(input: FailHumanGateInput): Promise<HumanGateRecord>;
  cancelGate(input: CancelHumanGateInput): Promise<HumanGateRecord>;
  listRecoverableGates(filter?: HumanGateRecoveryFilter): Promise<HumanGateRecord[]>;
  getConversationBlocker(input: {
    agentName: string;
    conversationId: string;
  }): Promise<ConversationBlockerRef | null>;
  getGate(id: string): Promise<HumanGateRecord | null>;
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

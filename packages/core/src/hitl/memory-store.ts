import type {
  AcquireHumanApprovalInput,
  CancelHumanApprovalInput,
  CompleteHumanApprovalInput,
  CreateHumanApprovalInput,
  CreateHumanApprovalResult,
  FailHumanApprovalInput,
  HumanApprovalRecord,
  HumanApprovalRecoveryFilter,
  HumanApprovalReferenceStore,
  HumanApprovalStatus,
  HumanResult,
  HumanTaskFilter,
  HumanTaskRecord,
  HumanTaskStatus,
  HumanTaskView,
  MarkHumanApprovalHandlerStartedInput,
  SubmitHumanResult,
  SubmitHumanResultInput,
} from "./types.js";
import type { ConversationBlockerRef } from "../inbound/types.js";

export interface InMemoryHumanApprovalStoreOptions {
  defaultLeaseTtlMs?: number;
  now?: () => string;
}

export class InMemoryHumanApprovalStore implements HumanApprovalReferenceStore {
  private readonly _gates = new Map<string, HumanApprovalRecord>();
  private readonly _tasks = new Map<string, HumanTaskRecord>();
  private readonly _gateIdByToolCall = new Map<string, string>();
  private readonly _blockerByConversation = new Map<string, ConversationBlockerRef>();
  private readonly _defaultLeaseTtlMs: number;
  private readonly _now: () => string;

  constructor(options: InMemoryHumanApprovalStoreOptions = {}) {
    this._defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;
    this._now = options.now ?? (() => new Date().toISOString());
  }

  async createApproval(input: CreateHumanApprovalInput): Promise<CreateHumanApprovalResult> {
    if (input.tasks.length === 0) {
      throw new Error("Human approval requires at least one human task.");
    }

    const gateId = input.humanApprovalId ?? input.id ?? defaultHumanApprovalId(input);
    const toolCallKey = humanApprovalToolCallKey(input);
    const duplicateGateId = this._gates.has(gateId)
      ? gateId
      : this._gateIdByToolCall.get(toolCallKey);

    if (duplicateGateId) {
      const gate = this._mustGetGate(duplicateGateId);
      const tasks = gate.taskIds.map((taskId) => this._mustGetTask(taskId));
      return {
        approval: cloneValue(gate),
        tasks: tasks.map(cloneValue),
        blocker: cloneValue(gate.blocker),
        created: false,
        duplicate: true,
      };
    }

    const now = input.now ?? this._now();
    const blocker: ConversationBlockerRef = createHumanApprovalBlockerRef(gateId);
    const taskIds = input.tasks.map((task, index) => task.humanTaskId ?? defaultHumanTaskId(gateId, index));
    const approval: HumanApprovalRecord = {
      id: gateId,
      status: "waitingForHuman",
      toolCall: cloneValue(input.toolCall),
      prompt: input.prompt,
      expectedResultSchema: cloneValue(input.expectedResultSchema),
      conversationCursor: input.conversationCursor,
      conversationSnapshot: cloneValue(input.conversationSnapshot),
      taskIds,
      blocker,
      createdAt: now,
      updatedAt: now,
    };
    const tasks: HumanTaskRecord[] = input.tasks.map((task, index) => ({
      id: taskIds[index] ?? defaultHumanTaskId(gateId, index),
      humanApprovalId: gateId,
      taskType: task.taskType ?? task.type ?? "approval",
      status: "waitingForHuman",
      prompt: task.prompt,
      required: task.required ?? true,
      responseSchema: cloneValue(task.responseSchema),
      metadata: cloneValue(task.metadata),
      createdAt: now,
      updatedAt: now,
    }));

    const duplicateTaskId = tasks.find((task) => this._tasks.has(task.id));
    if (duplicateTaskId) {
      throw new Error(`Duplicate human task id: "${duplicateTaskId.id}".`);
    }

    this._gates.set(approval.id, approval);
    this._gateIdByToolCall.set(toolCallKey, approval.id);
    for (const task of tasks) {
      this._tasks.set(task.id, task);
    }
    this._blockerByConversation.set(
      conversationKey(approval.toolCall.agentName, approval.toolCall.conversationId),
      blocker,
    );

    return {
      approval: cloneValue(approval),
      tasks: tasks.map(cloneValue),
      blocker: cloneValue(blocker),
      created: true,
      duplicate: false,
    };
  }

  async listTasks(filter: HumanTaskFilter = {}): Promise<HumanTaskView[]> {
    const statusValues = filter.status
      ? (Array.isArray(filter.status) ? filter.status : [filter.status])
      : filter.statuses;
    const statuses = statusValues ? new Set<HumanTaskStatus>(statusValues) : null;
    const taskTypes = filter.taskTypes ? new Set(filter.taskTypes) : null;
    const views: HumanTaskView[] = [];

    for (const task of this._orderedTasks()) {
      const gate = this._mustGetGate(task.humanApprovalId);
      if (filter.agentName && gate.toolCall.agentName !== filter.agentName) {
        continue;
      }
      if (filter.conversationId && gate.toolCall.conversationId !== filter.conversationId) {
        continue;
      }
      if (filter.humanApprovalId && task.humanApprovalId !== filter.humanApprovalId) {
        continue;
      }
      if (statuses && !statuses.has(task.status)) {
        continue;
      }
      if (taskTypes && !taskTypes.has(task.taskType)) {
        continue;
      }

      views.push({
        ...cloneValue(task),
        agentName: gate.toolCall.agentName,
        conversationId: gate.toolCall.conversationId,
        turnId: gate.toolCall.turnId,
        toolCallId: gate.toolCall.toolCallId,
        toolName: gate.toolCall.toolName,
      });
    }

    return typeof filter.limit === "number" ? views.slice(0, filter.limit) : views;
  }

  async submitResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult> {
    const task = this._tasks.get(input.humanTaskId);
    if (!task) {
      return { status: "notFound", reason: `Unknown human task: "${input.humanTaskId}".` };
    }

    const gate = this._mustGetGate(task.humanApprovalId);
    if (input.agentName && input.agentName !== gate.toolCall.agentName) {
      return { status: "invalid", reason: "agentName does not match the human task scope." };
    }
    if (input.conversationId && input.conversationId !== gate.toolCall.conversationId) {
      return { status: "invalid", reason: "conversationId does not match the human task scope." };
    }
    if (isTerminalGateStatus(gate.status)) {
      return { status: "invalid", reason: `Human approval is already terminal: "${gate.status}".` };
    }
    if (task.status !== "waitingForHuman") {
      if (task.resultIdempotencyKey === input.idempotencyKey) {
        return {
          status: "duplicate",
          task: cloneValue(task),
          approval: cloneValue(gate),
          approvalReady: gate.status === "ready",
        };
      }
      return { status: "invalid", reason: `Human task is already "${task.status}".` };
    }
    if (!isValidHumanResult(input.result)) {
      return { status: "invalid", reason: "Invalid human result payload." };
    }

    const now = input.now ?? this._now();
    task.result = cloneValue(input.result);
    task.status = resultToTaskStatus(input.result);
    task.resultIdempotencyKey = input.idempotencyKey;
    task.submittedBy = input.submittedBy;
    task.submittedAt = now;
    task.updatedAt = now;

    const approvalReady = this._allRequiredTasksSettled(gate);
    if (approvalReady) {
      gate.status = "ready";
      gate.updatedAt = now;
    }

    return {
      status: "accepted",
      task: cloneValue(task),
      approval: cloneValue(gate),
      approvalReady,
    };
  }

  async acquireApprovalForResume(input: AcquireHumanApprovalInput): Promise<HumanApprovalRecord | null> {
    const gate = this._gates.get(input.humanApprovalId);
    if (!gate) {
      return null;
    }

    const now = input.now ?? this._now();
    const resumeLeaseActive = gate.status === "resuming" &&
      gate.lease &&
      Date.parse(gate.lease.expiresAt) > Date.parse(now);
    if (resumeLeaseActive) {
      return null;
    }
    const resumeLeaseExpired = gate.status === "resuming" && !resumeLeaseActive;
    if (resumeLeaseExpired && gate.handlerStartedAt) {
      return null;
    }
    const retryableFailure = gate.status === "failed" && gate.failure?.retryable;
    if (gate.status !== "ready" && !retryableFailure && !resumeLeaseExpired) {
      return null;
    }

    gate.status = "resuming";
    gate.lease = {
      owner: input.leaseOwner,
      acquiredAt: now,
      expiresAt: addMs(now, input.leaseTtlMs ?? this._defaultLeaseTtlMs),
    };
    gate.updatedAt = now;
    return cloneValue(gate);
  }

  async markApprovalHandlerStarted(input: MarkHumanApprovalHandlerStartedInput): Promise<HumanApprovalRecord> {
    const gate = this._mustGetGate(input.humanApprovalId);
    this._assertLeaseOwner(gate, input.leaseOwner);
    if (gate.status !== "resuming") {
      throw new Error(`Cannot mark human approval "${gate.id}" handler started from status "${gate.status}".`);
    }
    if (!gate.handlerStartedAt) {
      const now = input.now ?? this._now();
      gate.handlerStartedAt = now;
      gate.updatedAt = now;
    }
    return cloneValue(gate);
  }

  async markApprovalCompleted(input: CompleteHumanApprovalInput): Promise<HumanApprovalRecord> {
    const gate = this._mustGetGate(input.humanApprovalId);
    this._assertLeaseOwner(gate, input.leaseOwner);
    if (gate.status === "completed") {
      return cloneValue(gate);
    }
    if (gate.status !== "resuming") {
      throw new Error(`Cannot complete human approval "${gate.id}" from status "${gate.status}".`);
    }

    const now = input.now ?? this._now();
    gate.status = "completed";
    gate.lease = undefined;
    gate.failure = undefined;
    gate.blockedInboundItemIds = [...(input.blockedInboundItemIds ?? [])];
    gate.completedAt = now;
    gate.updatedAt = now;
    this._blockerByConversation.delete(conversationKey(gate.toolCall.agentName, gate.toolCall.conversationId));
    return cloneValue(gate);
  }

  async markApprovalFailed(input: FailHumanApprovalInput): Promise<HumanApprovalRecord> {
    const gate = this._mustGetGate(input.humanApprovalId);
    this._assertLeaseOwner(gate, input.leaseOwner);
    const now = input.now ?? this._now();

    gate.status = "failed";
    gate.lease = undefined;
    gate.failure = {
      reason: input.reason,
      retryable: input.retryable,
      failedAt: now,
    };
    gate.updatedAt = now;
    return cloneValue(gate);
  }

  async cancelApproval(input: CancelHumanApprovalInput): Promise<HumanApprovalRecord> {
    const gate = this._mustGetGate(input.humanApprovalId);
    if (isTerminalGateStatus(gate.status)) {
      return cloneValue(gate);
    }

    const now = input.now ?? this._now();
    const status = input.status ?? "canceled";
    gate.status = status;
    gate.lease = undefined;
    gate.failure = input.reason
      ? { reason: input.reason, retryable: false, failedAt: now }
      : gate.failure;
    gate.updatedAt = now;

    for (const taskId of gate.taskIds) {
      const task = this._mustGetTask(taskId);
      if (task.status === "waitingForHuman") {
        task.status = status;
        task.updatedAt = now;
      }
    }

    this._blockerByConversation.delete(conversationKey(gate.toolCall.agentName, gate.toolCall.conversationId));
    return cloneValue(gate);
  }

  async listRecoverableApprovals(filter: HumanApprovalRecoveryFilter = {}): Promise<HumanApprovalRecord[]> {
    const gates = [...this._gates.values()].filter((gate) => {
      if (filter.agentName && gate.toolCall.agentName !== filter.agentName) {
        return false;
      }
      if (filter.conversationId && gate.toolCall.conversationId !== filter.conversationId) {
        return false;
      }
      if (gate.status === "ready" || gate.status === "resuming") {
        if (gate.status === "resuming" && gate.handlerStartedAt) {
          return false;
        }
        return true;
      }
      return !!filter.includeFailed && gate.status === "failed" && gate.failure?.retryable === true;
    });

    const ordered = gates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const limited = typeof filter.limit === "number" ? ordered.slice(0, filter.limit) : ordered;
    return limited.map(cloneValue);
  }

  async getApproval(id: string): Promise<HumanApprovalRecord | null> {
    const gate = this._gates.get(id);
    return gate ? cloneValue(gate) : null;
  }

  async getTask(id: string): Promise<HumanTaskRecord | null> {
    const task = this._tasks.get(id);
    return task ? cloneValue(task) : null;
  }

  async getConversationBlocker(input: {
    agentName: string;
    conversationId: string;
  }): Promise<ConversationBlockerRef | null> {
    const blocker = this._blockerByConversation.get(conversationKey(input.agentName, input.conversationId));
    return blocker ? cloneValue(blocker) : null;
  }

  private _allRequiredTasksSettled(approval: HumanApprovalRecord): boolean {
    return approval.taskIds.every((taskId) => {
      const task = this._mustGetTask(taskId);
      if (!task.required) {
        return true;
      }
      return task.status === "resolved" || task.status === "rejected";
    });
  }

  private _mustGetGate(id: string): HumanApprovalRecord {
    const gate = this._gates.get(id);
    if (!gate) {
      throw new Error(`Unknown human approval: "${id}".`);
    }
    return gate;
  }

  private _mustGetTask(id: string): HumanTaskRecord {
    const task = this._tasks.get(id);
    if (!task) {
      throw new Error(`Unknown human task: "${id}".`);
    }
    return task;
  }

  private _orderedTasks(): HumanTaskRecord[] {
    return [...this._tasks.values()].sort((a, b) => {
      const gateOrder = a.humanApprovalId.localeCompare(b.humanApprovalId);
      if (gateOrder !== 0) {
        return gateOrder;
      }
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  }

  private _assertLeaseOwner(approval: HumanApprovalRecord, expectedOwner: string | undefined): void {
    if (!expectedOwner) {
      return;
    }
    if (!approval.lease || approval.lease.owner !== expectedOwner) {
      throw new Error(`Human approval "${approval.id}" is not leased by "${expectedOwner}".`);
    }
  }
}

export function createInMemoryHumanApprovalStore(
  options?: InMemoryHumanApprovalStoreOptions,
): InMemoryHumanApprovalStore {
  return new InMemoryHumanApprovalStore(options);
}

export function createHumanApprovalBlockerRef(humanApprovalId: string): ConversationBlockerRef {
  return {
    type: "humanApproval",
    id: humanApprovalId,
  };
}

export function isHumanApprovalBlockerRef(blocker: ConversationBlockerRef | null | undefined): boolean {
  return blocker?.type === "humanApproval";
}

export function defaultHumanApprovalId(input: CreateHumanApprovalInput): string {
  const { toolCall } = input;
  return [
    "humanApproval",
    toolCall.agentName,
    toolCall.conversationId,
    toolCall.turnId,
    toolCall.toolCallId,
  ].join(":");
}

export function defaultHumanTaskId(humanApprovalId: string, index: number): string {
  return `${humanApprovalId}:task:${index + 1}`;
}

function humanApprovalToolCallKey(input: CreateHumanApprovalInput): string {
  const { toolCall } = input;
  return [
    toolCall.agentName,
    toolCall.conversationId,
    toolCall.turnId,
    toolCall.stepNumber,
    toolCall.toolCallId,
  ].join(":");
}

function conversationKey(agentName: string, conversationId: string): string {
  return `${agentName}\u0000${conversationId}`;
}

function resultToTaskStatus(result: HumanResult): Extract<HumanTaskStatus, "resolved" | "rejected"> {
  return result.type === "rejection" ? "rejected" : "resolved";
}

function isValidHumanResult(result: HumanResult): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  if (result.type === "approval") {
    return result.approved === true;
  }
  if (result.type === "rejection") {
    return result.reason === undefined || typeof result.reason === "string";
  }
  if (result.type === "text") {
    return typeof result.text === "string";
  }
  if (result.type === "form") {
    return !!result.data && typeof result.data === "object" && !Array.isArray(result.data);
  }
  return false;
}

function isTerminalGateStatus(status: HumanApprovalStatus): boolean {
  return status === "completed" || status === "canceled" || status === "expired";
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

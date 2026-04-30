import type {
  AcquireHumanGateInput,
  CancelHumanGateInput,
  CompleteHumanGateInput,
  CreateHumanGateInput,
  CreateHumanGateResult,
  FailHumanGateInput,
  HumanGateRecord,
  HumanGateRecoveryFilter,
  HumanGateReferenceStore,
  HumanGateStatus,
  HumanResult,
  HumanTaskFilter,
  HumanTaskRecord,
  HumanTaskStatus,
  HumanTaskView,
  SubmitHumanResult,
  SubmitHumanResultInput,
} from "./types.js";
import type { ConversationBlockerRef } from "../inbound/types.js";

export interface InMemoryHumanGateStoreOptions {
  defaultLeaseTtlMs?: number;
  now?: () => string;
}

export class InMemoryHumanGateStore implements HumanGateReferenceStore {
  private readonly _gates = new Map<string, HumanGateRecord>();
  private readonly _tasks = new Map<string, HumanTaskRecord>();
  private readonly _gateIdByToolCall = new Map<string, string>();
  private readonly _blockerByConversation = new Map<string, ConversationBlockerRef>();
  private readonly _defaultLeaseTtlMs: number;
  private readonly _now: () => string;

  constructor(options: InMemoryHumanGateStoreOptions = {}) {
    this._defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;
    this._now = options.now ?? (() => new Date().toISOString());
  }

  async createGate(input: CreateHumanGateInput): Promise<CreateHumanGateResult> {
    if (input.tasks.length === 0) {
      throw new Error("Human gate requires at least one human task.");
    }

    const gateId = input.humanGateId ?? input.id ?? defaultHumanGateId(input);
    const toolCallKey = humanGateToolCallKey(input);
    const duplicateGateId = this._gates.has(gateId)
      ? gateId
      : this._gateIdByToolCall.get(toolCallKey);

    if (duplicateGateId) {
      const gate = this._mustGetGate(duplicateGateId);
      const tasks = gate.taskIds.map((taskId) => this._mustGetTask(taskId));
      return {
        gate: cloneValue(gate),
        tasks: tasks.map(cloneValue),
        blocker: cloneValue(gate.blocker),
        created: false,
        duplicate: true,
      };
    }

    const now = input.now ?? this._now();
    const blocker: ConversationBlockerRef = createHumanGateBlockerRef(gateId);
    const taskIds = input.tasks.map((task, index) => task.humanTaskId ?? defaultHumanTaskId(gateId, index));
    const gate: HumanGateRecord = {
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
      humanGateId: gateId,
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

    this._gates.set(gate.id, gate);
    this._gateIdByToolCall.set(toolCallKey, gate.id);
    for (const task of tasks) {
      this._tasks.set(task.id, task);
    }
    this._blockerByConversation.set(
      conversationKey(gate.toolCall.agentName, gate.toolCall.conversationId),
      blocker,
    );

    return {
      gate: cloneValue(gate),
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
      const gate = this._mustGetGate(task.humanGateId);
      if (filter.agentName && gate.toolCall.agentName !== filter.agentName) {
        continue;
      }
      if (filter.conversationId && gate.toolCall.conversationId !== filter.conversationId) {
        continue;
      }
      if (filter.humanGateId && task.humanGateId !== filter.humanGateId) {
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

    const gate = this._mustGetGate(task.humanGateId);
    if (input.agentName && input.agentName !== gate.toolCall.agentName) {
      return { status: "invalid", reason: "agentName does not match the human task scope." };
    }
    if (input.conversationId && input.conversationId !== gate.toolCall.conversationId) {
      return { status: "invalid", reason: "conversationId does not match the human task scope." };
    }
    if (isTerminalGateStatus(gate.status)) {
      return { status: "invalid", reason: `Human gate is already terminal: "${gate.status}".` };
    }
    if (task.status !== "waitingForHuman") {
      if (task.resultIdempotencyKey === input.idempotencyKey) {
        return {
          status: "duplicate",
          task: cloneValue(task),
          gate: cloneValue(gate),
          gateReady: gate.status === "ready",
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

    const gateReady = this._allRequiredTasksSettled(gate);
    if (gateReady) {
      gate.status = "ready";
      gate.updatedAt = now;
    }

    return {
      status: "accepted",
      task: cloneValue(task),
      gate: cloneValue(gate),
      gateReady,
    };
  }

  async acquireGateForResume(input: AcquireHumanGateInput): Promise<HumanGateRecord | null> {
    const gate = this._gates.get(input.humanGateId);
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

  async markGateCompleted(input: CompleteHumanGateInput): Promise<HumanGateRecord> {
    const gate = this._mustGetGate(input.humanGateId);
    this._assertLeaseOwner(gate, input.leaseOwner);
    if (gate.status === "completed") {
      return cloneValue(gate);
    }
    if (gate.status !== "resuming") {
      throw new Error(`Cannot complete human gate "${gate.id}" from status "${gate.status}".`);
    }

    const now = input.now ?? this._now();
    gate.status = "completed";
    gate.lease = undefined;
    gate.failure = undefined;
    gate.completedAt = now;
    gate.updatedAt = now;
    this._blockerByConversation.delete(conversationKey(gate.toolCall.agentName, gate.toolCall.conversationId));
    return cloneValue(gate);
  }

  async markGateFailed(input: FailHumanGateInput): Promise<HumanGateRecord> {
    const gate = this._mustGetGate(input.humanGateId);
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

  async cancelGate(input: CancelHumanGateInput): Promise<HumanGateRecord> {
    const gate = this._mustGetGate(input.humanGateId);
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

  async listRecoverableGates(filter: HumanGateRecoveryFilter = {}): Promise<HumanGateRecord[]> {
    const gates = [...this._gates.values()].filter((gate) => {
      if (filter.agentName && gate.toolCall.agentName !== filter.agentName) {
        return false;
      }
      if (filter.conversationId && gate.toolCall.conversationId !== filter.conversationId) {
        return false;
      }
      if (gate.status === "ready" || gate.status === "resuming") {
        return true;
      }
      return !!filter.includeFailed && gate.status === "failed" && gate.failure?.retryable === true;
    });

    const ordered = gates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const limited = typeof filter.limit === "number" ? ordered.slice(0, filter.limit) : ordered;
    return limited.map(cloneValue);
  }

  async getGate(id: string): Promise<HumanGateRecord | null> {
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

  private _allRequiredTasksSettled(gate: HumanGateRecord): boolean {
    return gate.taskIds.every((taskId) => {
      const task = this._mustGetTask(taskId);
      if (!task.required) {
        return true;
      }
      return task.status === "resolved" || task.status === "rejected";
    });
  }

  private _mustGetGate(id: string): HumanGateRecord {
    const gate = this._gates.get(id);
    if (!gate) {
      throw new Error(`Unknown human gate: "${id}".`);
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
      const gateOrder = a.humanGateId.localeCompare(b.humanGateId);
      if (gateOrder !== 0) {
        return gateOrder;
      }
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  }

  private _assertLeaseOwner(gate: HumanGateRecord, expectedOwner: string | undefined): void {
    if (!expectedOwner) {
      return;
    }
    if (!gate.lease || gate.lease.owner !== expectedOwner) {
      throw new Error(`Human gate "${gate.id}" is not leased by "${expectedOwner}".`);
    }
  }
}

export function createInMemoryHumanGateStore(
  options?: InMemoryHumanGateStoreOptions,
): InMemoryHumanGateStore {
  return new InMemoryHumanGateStore(options);
}

export function createHumanGateBlockerRef(humanGateId: string): ConversationBlockerRef {
  return {
    type: "humanGate",
    id: humanGateId,
  };
}

export function isHumanGateBlockerRef(blocker: ConversationBlockerRef | null | undefined): boolean {
  return blocker?.type === "humanGate";
}

export function defaultHumanGateId(input: CreateHumanGateInput): string {
  const { toolCall } = input;
  return [
    "humanGate",
    toolCall.agentName,
    toolCall.conversationId,
    toolCall.turnId,
    toolCall.toolCallId,
  ].join(":");
}

export function defaultHumanTaskId(humanGateId: string, index: number): string {
  return `${humanGateId}:task:${index + 1}`;
}

function humanGateToolCallKey(input: CreateHumanGateInput): string {
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

function isTerminalGateStatus(status: HumanGateStatus): boolean {
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

import type {
  CreateHitlBatchResult,
  HitlBatchAppendCommit,
  HitlBatchCompletion,
  HitlBatchFilter,
  HitlBatchLeaseResult,
  HitlBatchRecord,
  HitlBatchStatus,
  HitlBatchToolExecutionMarker,
  HitlBatchToolResult,
  HitlBatchView,
  HitlCompletion,
  HitlFailure,
  HitlHumanResult,
  HitlLeaseGuard,
  HitlQueuedSteer,
  HitlQueuedSteerInput,
  HitlRequestFilter,
  HitlRequestRecord,
  HitlRequestStatus,
  HitlRequestView,
  HitlStore,
} from "@goondan/openharness-types";
import { randomBytes } from "node:crypto";

const CONVERSATION_OPEN_BATCH_STATUSES = new Set<HitlBatchStatus>([
  "preparing",
  "waitingForHuman",
  "ready",
  "resuming",
  "continuing",
]);

const STEER_QUEUE_OPEN_BATCH_STATUSES = new Set<HitlBatchStatus>([
  "waitingForHuman",
  "ready",
  "resuming",
]);

export function createHitlBatchId(): string {
  return createSortableOpaqueId("hitl-batch");
}

export function createHitlRequestId(): string {
  return createSortableOpaqueId("hitl-request");
}

export function createHitlQueuedInputId(): string {
  return createSortableOpaqueId("hitl-input");
}

function createSortableOpaqueId(prefix: string): string {
  const time = Date.now().toString(36).padStart(10, "0");
  const entropy = randomBytes(10).toString("base64url");
  return `${prefix}-${time}${entropy}`;
}

export function toHitlRequestView(record: HitlRequestRecord): HitlRequestView {
  return {
    ...clone(record),
    hasConversationSnapshot: (record.conversationEvents?.length ?? 0) > 0,
  };
}

export function toHitlBatchView(
  batch: HitlBatchRecord,
  requests: HitlRequestRecord[] = [],
  queuedSteerCount = 0,
): HitlBatchView {
  return {
    ...clone(batch),
    requests: requests.map(clone),
    queuedSteerCount,
  };
}

export class HitlStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HitlStoreError";
  }
}

export class InMemoryHitlStore implements HitlStore {
  private readonly batches = new Map<string, HitlBatchRecord>();
  private readonly requests = new Map<string, HitlRequestRecord>();
  private readonly queuedSteers = new Map<string, HitlQueuedSteer[]>();
  private readonly resultKeys = new Map<string, { requestId: string; result: HitlHumanResult }>();
  private leaseSequence = 0;

  async createBatch(input: {
    batch: HitlBatchRecord;
    requests: HitlRequestRecord[];
  }): Promise<CreateHitlBatchResult> {
    const existing = this.batches.get(input.batch.batchId);
    if (existing) {
      return {
        status: "conflict",
        openBatch: clone(existing),
      };
    }

    const open = this.findOpenBatchByConversation(input.batch.agentName, input.batch.conversationId);
    if (open) {
      return {
        status: "conflict",
        openBatch: clone(open),
      };
    }

    if (input.batch.status !== "preparing") {
      throw new HitlStoreError("New HITL batches must start in preparing state");
    }
    if (input.requests.length === 0) {
      throw new HitlStoreError("HITL batch requires at least one request");
    }

    const now = nowIso();
    const batch = touchBatch({
      ...clone(input.batch),
      toolResults: input.batch.toolResults.map(clone),
      toolExecutions: input.batch.toolExecutions.map(clone),
      createdAt: input.batch.createdAt || now,
      updatedAt: now,
    });
    const requests = input.requests.map((request) => {
      if (request.status !== "pending") {
        throw new HitlStoreError("New HITL requests must start in pending state");
      }
      if (request.batchId !== batch.batchId) {
        throw new HitlStoreError("HITL request batchId must match batch");
      }
      const toolCall = batch.toolCalls.find(
        (candidate) => candidate.requestId === request.requestId || candidate.toolCallId === request.toolCallId,
      );
      return touchRequest({
        ...clone(request),
        toolCallIndex: request.toolCallIndex ?? toolCall?.toolCallIndex ?? 0,
        createdAt: request.createdAt || now,
        updatedAt: now,
      });
    });

    this.batches.set(batch.batchId, batch);
    for (const request of requests) {
      this.requests.set(request.requestId, request);
    }
    this.queuedSteers.set(batch.batchId, []);

    return {
      status: "created",
      batch: clone(batch),
      requests: requests.map(clone),
    };
  }

  async getBatch(batchId: string): Promise<HitlBatchRecord | null> {
    const batch = this.batches.get(batchId);
    return batch ? clone(batch) : null;
  }

  async getRequest(requestId: string): Promise<HitlRequestRecord | null> {
    const request = this.requests.get(requestId);
    return request ? clone(request) : null;
  }

  async listPendingBatches(filter?: HitlBatchFilter): Promise<HitlBatchRecord[]> {
    return Array.from(this.batches.values())
      .filter((batch) => batch.status === "waitingForHuman")
      .filter((batch) => matchesBatchFilter(batch, filter))
      .map(clone);
  }

  async listPendingRequests(filter?: HitlRequestFilter): Promise<HitlRequestRecord[]> {
    return Array.from(this.requests.values())
      .filter((request) => request.status === "pending")
      .filter((request) => {
        const batch = request.batchId ? this.batches.get(request.batchId) : undefined;
        return batch?.status === "waitingForHuman";
      })
      .filter((request) => matchesRequestFilter(request, filter))
      .map(clone);
  }

  async listBatchRequests(batchId: string): Promise<HitlRequestRecord[]> {
    return Array.from(this.requests.values())
      .filter((request) => request.batchId === batchId)
      .sort((a, b) => getRequestToolCallIndex(a) - getRequestToolCallIndex(b))
      .map(clone);
  }

  async listBatchToolResults(batchId: string): Promise<HitlBatchToolResult[]> {
    const batch = mustGetBatch(this.batches, batchId);
    return batch.toolResults
      .slice()
      .sort((a, b) => a.toolCallIndex - b.toolCallIndex)
      .map(clone);
  }

  async listRecoverableBatches(filter?: HitlBatchFilter): Promise<HitlBatchRecord[]> {
    return Array.from(this.batches.values())
      .filter(
        (batch) =>
          batch.status === "preparing" ||
          batch.status === "waitingForHuman" ||
          batch.status === "ready" ||
          batch.status === "resuming" ||
          batch.status === "continuing" ||
          (batch.status === "failed" && batch.failure?.retryable === true),
      )
      .filter((batch) => matchesBatchFilter(batch, filter))
      .map(clone);
  }

  async getOpenBatchByConversation(agentName: string, conversationId: string): Promise<HitlBatchRecord | null> {
    for (const batch of this.batches.values()) {
      if (
        batch.agentName === agentName &&
        batch.conversationId === conversationId &&
        isSteerQueueOpenBatch(batch)
      ) {
        return clone(batch);
      }
    }
    return null;
  }

  private findOpenBatchByConversation(agentName: string, conversationId: string): HitlBatchRecord | null {
    for (const batch of this.batches.values()) {
      if (
        batch.agentName === agentName &&
        batch.conversationId === conversationId &&
        isConversationOpenBatch(batch)
      ) {
        return batch;
      }
    }
    return null;
  }

  async startBatchToolExecution(
    batchId: string,
    marker: HitlBatchToolExecutionMarker,
  ): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    if (batch.status !== "preparing" && batch.status !== "resuming") {
      throw new HitlStoreError(`Cannot start batch tool execution from ${batch.status}`);
    }
    const exists = batch.toolExecutions.some(
      (item) => item.toolCallId === marker.toolCallId && item.requestId === marker.requestId,
    );
    const updated = touchBatch({
      ...batch,
      toolExecutions: exists ? batch.toolExecutions : [...batch.toolExecutions, clone(marker)],
    });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async recordBatchToolResult(batchId: string, result: HitlBatchToolResult): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    const toolResults = batch.toolResults.filter((item) => item.toolCallId !== result.toolCallId);
    toolResults.push(clone(result));
    const updated = touchBatch({
      ...batch,
      toolResults: toolResults.sort((a, b) => a.toolCallIndex - b.toolCallIndex),
    });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async completeRequestWithToolResult(input: {
    batchId: string;
    requestId: string;
    toolResult: HitlBatchToolResult;
    completion: HitlCompletion;
    guard: HitlLeaseGuard;
  }): Promise<{ batch: HitlBatchRecord; request: HitlRequestRecord }> {
    const request = mustGetRequest(this.requests, input.requestId);
    const batch = mustGetBatch(this.batches, input.batchId);
    if (requireRequestBatchId(request) !== input.batchId) {
      throw new HitlStoreError("HITL request batchId must match batch");
    }
    if (input.toolResult.batchId !== input.batchId) {
      throw new HitlStoreError("HITL tool result batchId must match batch");
    }
    if (input.toolResult.toolCallId !== request.toolCallId) {
      throw new HitlStoreError("HITL tool result toolCallId must match request");
    }
    assertBatchLease(batch, input.guard);
    if (
      request.status !== "resolved" &&
      request.status !== "rejected" &&
      request.status !== "blocked" &&
      request.status !== "completed" &&
      !(request.status === "failed" && request.failure?.retryable === true)
    ) {
      throw new HitlStoreError(`Cannot complete HITL request from ${request.status}`);
    }

    const toolResults = batch.toolResults.filter((item) => item.toolCallId !== input.toolResult.toolCallId);
    toolResults.push(clone(input.toolResult));
    const updatedBatch = touchBatch({
      ...batch,
      toolResults: toolResults.sort((a, b) => a.toolCallIndex - b.toolCallIndex),
    });
    const updatedRequest = touchRequest({
      ...request,
      status: "completed",
      finalArgs: input.completion.finalArgs,
      completion: clone(input.completion),
    });
    this.batches.set(input.batchId, updatedBatch);
    this.requests.set(input.requestId, updatedRequest);
    return {
      batch: clone(updatedBatch),
      request: clone(updatedRequest),
    };
  }

  async markBatchWaitingForHuman(batchId: string): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    if (batch.status !== "preparing") {
      throw new HitlStoreError(`Cannot mark HITL batch waitingForHuman from ${batch.status}`);
    }
    const missing = batch.toolCalls.filter(
      (toolCall) =>
        !toolCall.requiresHitl &&
        !batch.toolResults.some((result) => result.toolCallId === toolCall.toolCallId),
    );
    if (missing.length > 0) {
      throw new HitlStoreError("Cannot expose HITL batch before all non-HITL results are recorded");
    }
    const status = hasPendingRequests(batch.batchId, this.requests) ? "waitingForHuman" : "ready";
    const updated = touchBatch({ ...batch, status });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async resolveRequest(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord> {
    return this.applyResult(requestId, "resolved", result, idempotencyKey);
  }

  async rejectRequest(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord> {
    return this.applyResult(requestId, "rejected", result, idempotencyKey);
  }

  async enqueueSteer(batchId: string, input: HitlQueuedSteerInput): Promise<HitlQueuedSteer> {
    const batch = mustGetBatch(this.batches, batchId);
    if (!isSteerQueueOpenBatch(batch)) {
      throw new HitlStoreError(`Cannot queue steer for HITL batch in ${batch.status}`);
    }
    const item: HitlQueuedSteer = {
      ...clone(input),
      batchId,
      queuedInputId: createHitlQueuedInputId(),
      status: "queued",
    };
    const items = this.queuedSteers.get(batchId) ?? [];
    items.push(item);
    this.queuedSteers.set(batchId, items);
    return clone(item);
  }

  async drainQueuedSteers(batchId: string, guard: HitlLeaseGuard): Promise<HitlQueuedSteer[]> {
    const batch = mustGetBatch(this.batches, batchId);
    assertBatchLease(batch, guard);
    this.batches.set(batchId, touchBatch({
      ...batch,
      metadata: {
        ...batch.metadata,
        steerQueueClosedAt: batch.metadata?.["steerQueueClosedAt"] ?? nowIso(),
      },
    }));
    const items = this.queuedSteers.get(batchId) ?? [];
    const draining = items.map((item) =>
      item.status === "queued" ? { ...item, status: "draining" as const } : item,
    );
    this.queuedSteers.set(batchId, draining);
    return draining.filter((item) => item.status === "draining").map(clone);
  }

  async acquireBatchLease(batchId: string, ownerId: string, ttlMs: number): Promise<HitlBatchLeaseResult> {
    const batch = this.batches.get(batchId);
    if (!batch) {
      return { status: "busy", batch: null };
    }

    const now = Date.now();
    const leaseExpiresAt = batch.lease?.expiresAt ? Date.parse(batch.lease.expiresAt) : 0;
    if (batch.lease && leaseExpiresAt > now && batch.lease.ownerId !== ownerId) {
      return { status: "busy", batch: clone(batch) };
    }
    if (!isResumableBatch(batch)) {
      return { status: "busy", batch: clone(batch) };
    }

    const nextStatus: HitlBatchStatus = batch.status === "continuing" ? "continuing" : "resuming";
    const updated = touchBatch({
      ...batch,
      status: nextStatus,
      lease: {
        ownerId,
        token: `${ownerId}:${++this.leaseSequence}`,
        expiresAt: new Date(now + ttlMs).toISOString(),
      },
    });
    this.batches.set(batchId, updated);
    return {
      status: "acquired",
      guard: { ownerId: updated.lease!.ownerId, token: updated.lease!.token },
      batch: clone(updated),
    };
  }

  async startRequestExecution(
    requestId: string,
    guard: HitlLeaseGuard,
    startedAt: string,
  ): Promise<HitlRequestRecord> {
    const request = mustGetRequest(this.requests, requestId);
    const batch = mustGetBatch(this.batches, requireRequestBatchId(request));
    assertBatchLease(batch, guard);
    if (request.status === "blocked") {
      return clone(request);
    }
    if (request.status !== "resolved" && !(request.status === "failed" && request.failure?.retryable === true)) {
      throw new HitlStoreError(`Cannot start HITL execution from ${request.status}`);
    }
    const updated = touchRequest({
      ...request,
      status: "blocked",
      metadata: {
        ...request.metadata,
        executionStartedAt: startedAt,
      },
    });
    this.requests.set(requestId, updated);
    return clone(updated);
  }

  async completeRequest(
    requestId: string,
    completion: HitlCompletion,
    guard: HitlLeaseGuard,
  ): Promise<HitlRequestRecord> {
    const request = mustGetRequest(this.requests, requestId);
    const batch = mustGetBatch(this.batches, requireRequestBatchId(request));
    assertBatchLease(batch, guard);
    if (
      request.status !== "resolved" &&
      request.status !== "rejected" &&
      request.status !== "blocked" &&
      request.status !== "completed" &&
      !(request.status === "failed" && request.failure?.retryable === true)
    ) {
      throw new HitlStoreError(`Cannot complete HITL request from ${request.status}`);
    }
    if (request.status === "completed") {
      return clone(request);
    }
    const updated = touchRequest({
      ...request,
      status: "completed",
      finalArgs: completion.finalArgs,
      completion,
    });
    this.requests.set(requestId, updated);
    return clone(updated);
  }

  async failRequest(
    requestId: string,
    failure: HitlFailure,
    guard: HitlLeaseGuard,
  ): Promise<HitlRequestRecord> {
    const request = mustGetRequest(this.requests, requestId);
    const batch = mustGetBatch(this.batches, requireRequestBatchId(request));
    assertBatchLease(batch, guard);
    const updated = touchRequest({
      ...request,
      status: "failed",
      failure,
    });
    this.requests.set(requestId, updated);
    return clone(updated);
  }

  async commitBatchAppend(
    batchId: string,
    appendCommit: HitlBatchAppendCommit,
    guard: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    assertBatchLease(batch, guard);
    const steers = this.queuedSteers.get(batchId) ?? [];
    this.queuedSteers.set(
      batchId,
      steers.map((item) =>
        appendCommit.queuedSteerIds.includes(item.queuedInputId)
          ? { ...item, status: "drained" as const }
          : item,
      ),
    );
    const updated = touchBatch({
      ...batch,
      status: "continuing",
      appendCommit: clone(appendCommit),
    });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async completeBatch(
    batchId: string,
    completion: HitlBatchCompletion,
    guard: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    assertBatchLease(batch, guard);
    const updated = touchBatch({
      ...batch,
      status: "completed",
      completion: clone(completion),
      lease: undefined,
    });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async failBatch(batchId: string, failure: HitlFailure, guard: HitlLeaseGuard): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    assertBatchLease(batch, guard);
    const updated = touchBatch({
      ...batch,
      status: "failed",
      failure: clone(failure),
      lease: undefined,
    });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async cancelBatch(batchId: string, reason?: string): Promise<HitlBatchRecord> {
    const batch = mustGetBatch(this.batches, batchId);
    if (batch.status !== "preparing" && batch.status !== "waitingForHuman") {
      throw new HitlStoreError(`Cannot cancel HITL batch from ${batch.status}`);
    }
    for (const request of this.requests.values()) {
      if (request.batchId === batchId && request.status === "pending") {
        this.requests.set(
          request.requestId,
          touchRequest({
            ...request,
            status: "canceled",
            metadata: {
              ...request.metadata,
              ...(reason ? { cancelReason: reason } : {}),
            },
          }),
        );
      }
    }
    const steers = this.queuedSteers.get(batchId) ?? [];
    this.queuedSteers.set(batchId, steers.map((item) => ({ ...item, status: "canceled" })));
    const updated = touchBatch({
      ...batch,
      status: "canceled",
      metadata: {
        ...batch.metadata,
        ...(reason ? { cancelReason: reason } : {}),
      },
      lease: undefined,
    });
    this.batches.set(batchId, updated);
    return clone(updated);
  }

  async releaseBatchLease(batchId: string, guard: HitlLeaseGuard): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || !batchLeaseMatches(batch, guard)) {
      return;
    }
    this.batches.set(batchId, touchBatch({ ...batch, lease: undefined }));
  }

  async listQueuedSteers(batchId: string): Promise<HitlQueuedSteer[]> {
    return (this.queuedSteers.get(batchId) ?? []).map(clone);
  }

  async create(request: HitlRequestRecord): Promise<{ created: boolean; request: HitlRequestRecord }> {
    const batchId = request.batchId ?? `hitl-batch-${request.requestId}`;
    const now = nowIso();
    const created = await this.createBatch({
      batch: {
        batchId,
        status: "preparing",
        agentName: request.agentName,
        conversationId: request.conversationId,
        turnId: request.turnId,
        stepNumber: request.stepNumber,
        toolCalls: [{
          toolCallId: request.toolCallId,
          toolCallIndex: request.toolCallIndex ?? 0,
          toolName: request.toolName,
          toolArgs: request.originalArgs,
          requiresHitl: true,
          requestId: request.requestId,
        }],
        toolResults: [],
        toolExecutions: [],
        conversationEvents: request.conversationEvents ?? [],
        createdAt: request.createdAt || now,
        updatedAt: now,
      },
      requests: [{
        ...request,
        batchId,
        toolCallIndex: request.toolCallIndex ?? 0,
      }],
    });
    if (created.status === "conflict") {
      const existing = this.requests.get(request.requestId);
      if (existing) {
        return { created: false, request: clone(withLease(existing, this.batches.get(requireRequestBatchId(existing)))) };
      }
      throw new HitlStoreError("Conversation already has an open HITL batch");
    }
    await this.markBatchWaitingForHuman(batchId);
    return { created: true, request: clone(withLease(created.requests[0]!, this.batches.get(batchId))) };
  }

  async get(requestId: string): Promise<HitlRequestRecord | null> {
    const request = await this.getRequest(requestId);
    return request ? withLease(request, this.batches.get(requireRequestBatchId(request))) : null;
  }

  async listPending(filter?: HitlRequestFilter): Promise<HitlRequestRecord[]> {
    const requests = await this.listPendingRequests(filter);
    return requests.map((request) => withLease(request, this.batches.get(requireRequestBatchId(request))));
  }

  async listRecoverable(filter?: HitlRequestFilter): Promise<HitlRequestRecord[]> {
    return Array.from(this.requests.values())
      .filter((request) => {
        const batch = request.batchId ? this.batches.get(request.batchId) : undefined;
        return Boolean(batch && (
          request.status === "pending" ||
          request.status === "resolved" ||
          request.status === "rejected" ||
          (request.status === "failed" && request.failure?.retryable === true) ||
          (batch.status === "failed" && batch.failure?.retryable === true)
        ));
      })
      .filter((request) => matchesRequestFilter(request, filter))
      .map((request) => clone(withLease(request, this.batches.get(requireRequestBatchId(request)))));
  }

  async resolve(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord> {
    const updated = await this.resolveRequest(requestId, result, idempotencyKey);
    return withLease(updated, this.batches.get(requireRequestBatchId(updated)));
  }

  async reject(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord> {
    const updated = await this.rejectRequest(requestId, result, idempotencyKey);
    return withLease(updated, this.batches.get(requireRequestBatchId(updated)));
  }

  async acquireLease(
    requestId: string,
    ownerId: string,
    ttlMs: number,
  ): Promise<
    | { acquired: true; request: HitlRequestRecord }
    | { acquired: false; request: HitlRequestRecord | null }
  > {
    const request = mustGetRequest(this.requests, requestId);
    const lease = await this.acquireBatchLease(requireRequestBatchId(request), ownerId, ttlMs);
    if (lease.status === "acquired") {
      return {
        acquired: true,
        request: clone(withLease(request, lease.batch)),
      };
    }
    return {
      acquired: false,
      request: lease.batch ? clone(withLease(request, lease.batch)) : null,
    };
  }

  async startExecution(requestId: string, guard: HitlLeaseGuard, startedAt: string): Promise<HitlRequestRecord> {
    return this.startRequestExecution(requestId, guard, startedAt);
  }

  async complete(requestId: string, completion: HitlCompletion, guard: HitlLeaseGuard): Promise<HitlRequestRecord> {
    const completed = await this.completeRequest(requestId, completion, guard);
    return withLease(completed, this.batches.get(requireRequestBatchId(completed)));
  }

  async fail(requestId: string, failure: HitlFailure, guard: HitlLeaseGuard): Promise<HitlRequestRecord> {
    const failed = await this.failRequest(requestId, failure, guard);
    const batchId = requireRequestBatchId(failed);
    await this.failBatch(batchId, failure, guard);
    return withLease(failed, this.batches.get(batchId));
  }

  async cancel(requestId: string, reason?: string): Promise<HitlRequestRecord> {
    const request = mustGetRequest(this.requests, requestId);
    const batchId = requireRequestBatchId(request);
    await this.cancelBatch(batchId, reason);
    return clone(withLease(mustGetRequest(this.requests, requestId), this.batches.get(batchId)));
  }

  async releaseLease(requestId: string, guard: HitlLeaseGuard): Promise<void> {
    const request = this.requests.get(requestId);
    if (!request) {
      return;
    }
    await this.releaseBatchLease(requireRequestBatchId(request), guard);
  }

  private async applyResult(
    requestId: string,
    status: "resolved" | "rejected",
    result: HitlHumanResult,
    idempotencyKey?: string,
  ): Promise<HitlRequestRecord> {
    const request = mustGetRequest(this.requests, requestId);
    const batch = mustGetBatch(this.batches, requireRequestBatchId(request));
    if (batch.status !== "waitingForHuman") {
      throw new HitlStoreError(`Cannot submit HITL result for batch in ${batch.status}`);
    }

    if (idempotencyKey) {
      const existing = this.resultKeys.get(idempotencyKey);
      if (existing && existing.requestId !== requestId) {
        throw new HitlStoreError("Idempotency key belongs to another HITL request");
      }
    }

    if (request.status === status || request.status === "completed") {
      return clone(request);
    }
    if (request.status !== "pending") {
      throw new HitlStoreError(`Cannot submit HITL result from ${request.status}`);
    }

    if (idempotencyKey) {
      this.resultKeys.set(idempotencyKey, { requestId, result: clone(result) });
    }

    const updated = touchRequest({
      ...request,
      status,
      result: clone(result),
    });
    this.requests.set(requestId, updated);

    if (!hasPendingRequests(batch.batchId, this.requests)) {
      this.batches.set(batch.batchId, touchBatch({ ...batch, status: "ready" }));
    }

    return clone(updated);
  }
}

function isResumableBatch(batch: HitlBatchRecord): boolean {
  return (
    batch.status === "ready" ||
    batch.status === "resuming" ||
    batch.status === "continuing" ||
    (batch.status === "failed" && batch.failure?.retryable === true)
  );
}

function isSteerQueueOpenBatch(batch: HitlBatchRecord): boolean {
  return STEER_QUEUE_OPEN_BATCH_STATUSES.has(batch.status) && !batch.metadata?.["steerQueueClosedAt"];
}

function isConversationOpenBatch(batch: HitlBatchRecord): boolean {
  return (
    CONVERSATION_OPEN_BATCH_STATUSES.has(batch.status) ||
    (batch.status === "failed" && batch.failure?.retryable === true)
  ) && !batch.metadata?.["steerQueueClosedAt"];
}

function hasPendingRequests(batchId: string, requests: Map<string, HitlRequestRecord>): boolean {
  for (const request of requests.values()) {
    if (request.batchId === batchId && request.status === "pending") {
      return true;
    }
  }
  return false;
}

function matchesBatchFilter(batch: HitlBatchRecord, filter: HitlBatchFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter.agentName && batch.agentName !== filter.agentName) {
    return false;
  }
  if (filter.conversationId && batch.conversationId !== filter.conversationId) {
    return false;
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(batch.status)) {
      return false;
    }
  }
  return true;
}

function matchesRequestFilter(request: HitlRequestRecord, filter: HitlRequestFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter.agentName && request.agentName !== filter.agentName) {
    return false;
  }
  if (filter.conversationId && request.conversationId !== filter.conversationId) {
    return false;
  }
  if (filter.batchId && request.batchId !== filter.batchId) {
    return false;
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(request.status)) {
      return false;
    }
  }
  return true;
}

function assertBatchLease(batch: HitlBatchRecord, guard: HitlLeaseGuard): void {
  if (!batchLeaseMatches(batch, guard)) {
    throw new HitlStoreError("HITL lease no longer belongs to this runtime");
  }
}

function batchLeaseMatches(batch: HitlBatchRecord, guard: HitlLeaseGuard): boolean {
  return batch.lease?.ownerId === guard.ownerId && batch.lease?.token === guard.token;
}

function mustGetBatch(records: Map<string, HitlBatchRecord>, batchId: string): HitlBatchRecord {
  const batch = records.get(batchId);
  if (!batch) {
    throw new HitlStoreError(`HITL batch not found: ${batchId}`);
  }
  return batch;
}

function mustGetRequest(records: Map<string, HitlRequestRecord>, requestId: string): HitlRequestRecord {
  const request = records.get(requestId);
  if (!request) {
    throw new HitlStoreError(`HITL request not found: ${requestId}`);
  }
  return request;
}

function requireRequestBatchId(request: HitlRequestRecord): string {
  if (!request.batchId) {
    throw new HitlStoreError(`HITL request is not attached to a batch: ${request.requestId}`);
  }
  return request.batchId;
}

function getRequestToolCallIndex(request: HitlRequestRecord): number {
  return request.toolCallIndex ?? 0;
}

function withLease(request: HitlRequestRecord, batch: HitlBatchRecord | undefined): HitlRequestRecord {
  return batch?.lease
    ? { ...request, lease: clone(batch.lease) }
    : { ...request, lease: undefined };
}

function touchBatch(record: HitlBatchRecord): HitlBatchRecord {
  return {
    ...record,
    updatedAt: nowIso(),
  };
}

function touchRequest(record: HitlRequestRecord): HitlRequestRecord {
  return {
    ...record,
    updatedAt: nowIso(),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

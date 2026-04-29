import type {
  HarnessRuntime,
  InboundEnvelope,
  MessageEvent,
  IngressApi,
  ControlApi,
  AbortResult,
  ProcessTurnOptions,
  TurnResult,
  LlmClient,
  EventPayload,
  HitlBatchFilter,
  HitlBatchRecord,
  HitlBatchView,
  HitlFailure,
  HitlHumanResult,
  HitlLeaseGuard,
  HitlRequestFilter,
  HitlRequestRecord,
  HitlRequestView,
  HitlRuntimeConfig,
  HitlStore,
  JsonObject,
  ResumeHitlResult,
  SubmitHitlResultInput,
  HitlSubmitResume,
  ToolResult,
} from "@goondan/openharness-types";
import type { ConversationStateImpl } from "./conversation-state.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { MiddlewareRegistry } from "./middleware-chain.js";
import type { EventBus } from "./event-bus.js";
import type { IngressPipeline } from "./ingress/pipeline.js";
import { createConversationState } from "./conversation-state.js";
import { executeContinuationTurn, executeTurn, type TurnSteeringController } from "./execution/turn.js";
import { HarnessError, ConfigError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { toHitlBatchView, toHitlRequestView } from "./hitl/store.js";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

const CLOSE_TIMEOUT_MS = 5000;
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;
const hitlAjv = createHitlAjv();

// ---------------------------------------------------------------------------
// Per-agent deps
// ---------------------------------------------------------------------------

export interface AgentDeps {
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  middlewareRegistry: MiddlewareRegistry;
  eventBus: EventBus;
  maxSteps: number;
}

const DEFAULT_HITL_LEASE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// In-flight turn tracking
// ---------------------------------------------------------------------------

interface InFlightTurn {
  turnId: string;
  agentName: string;
  conversationId: string;
  abortController: AbortController;
  promise: Promise<TurnResult>;
  steeringInbox: SteeringInbox;
}

interface InFlightHitlResume {
  batchId: string;
  abortController: AbortController;
  promise: Promise<ResumeHitlResult>;
}

class SteeringInbox implements TurnSteeringController {
  private _queue: InboundEnvelope[] = [];
  private _closed = false;

  enqueue(input: InboundEnvelope): boolean {
    if (this._closed) {
      return false;
    }
    this._queue.push(input);
    return true;
  }

  drain(): InboundEnvelope[] {
    const inputs = this._queue;
    this._queue = [];
    return inputs;
  }

  close(): void {
    this._closed = true;
    this._queue = [];
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// HarnessRuntimeImpl
// ---------------------------------------------------------------------------

export class HarnessRuntimeImpl implements HarnessRuntime {
  private readonly _agents: Map<string, AgentDeps>;
  private readonly _conversations: Map<string, ConversationStateImpl> = new Map();
  private readonly _inFlightTurns: Map<string, InFlightTurn> = new Map();
  private readonly _activeTurnByConversation: Map<string, InFlightTurn> = new Map();
  private readonly _ingressPipeline: IngressPipeline;
  private readonly _runtimeEvents: EventBus;
  private readonly _hitlStore: HitlStore | undefined;
  private readonly _hitlLeaseTtlMs: number;
  private readonly _resumeOwnerId = `runtime-${randomUUID()}`;
  private readonly _inFlightHitlResumes: Map<string, InFlightHitlResume> = new Map();
  private _closed = false;

  constructor(
    agents: Map<string, AgentDeps>,
    ingressPipeline: IngressPipeline,
    runtimeEvents: EventBus,
    hitlConfig?: HitlRuntimeConfig,
  ) {
    this._agents = agents;
    this._ingressPipeline = ingressPipeline;
    this._runtimeEvents = runtimeEvents;
    this._hitlStore = hitlConfig?.store;
    this._hitlLeaseTtlMs = hitlConfig?.leaseTtlMs ?? DEFAULT_HITL_LEASE_TTL_MS;

    if (this._hitlStore && hitlConfig?.resumeOnStartup !== false) {
      void this._recoverHitlBatches().catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this._runtimeEvents.emit("hitl.recovery", {
          type: "hitl.recovery",
          recoveredBatches: 0,
          pendingBatches: 0,
          queuedForResume: 0,
          error,
        });
      });
    }
  }

  private _conversationKey(agentName: string, conversationId: string): string {
    return `${agentName}::${conversationId}`;
  }

  private async _processTurnInternal(
    agentName: string,
    input: string | InboundEnvelope,
    options?: (ProcessTurnOptions & { turnId?: string }),
  ): Promise<TurnResult> {
    if (this._closed) {
      throw new HarnessError("Runtime is closed");
    }

    const agentDeps = this._agents.get(agentName);
    if (!agentDeps) {
      throw new ConfigError(`Unknown agent: "${agentName}"`);
    }

    const conversationId =
      options?.conversationId ??
      (typeof input !== "string" && input.conversationId
        ? input.conversationId
        : randomUUID());
    const turnId = options?.turnId ?? `turn-${randomUUID()}`;

    const hitlBarrier = await this._getHitlBarrierTurnResult(agentName, conversationId, turnId);
    if (hitlBarrier) {
      return hitlBarrier;
    }

    const conversationKey = this._conversationKey(agentName, conversationId);

    let conversationState = this._conversations.get(conversationKey);
    if (!conversationState) {
      conversationState = createConversationState();
      this._conversations.set(conversationKey, conversationState);
    }

    const abortController = new AbortController();
    const steeringInbox = new SteeringInbox();
    const trackedTurn = createDeferred<TurnResult>();

    const inFlightTurn: InFlightTurn = {
      turnId,
      agentName,
      conversationId,
      abortController,
      promise: trackedTurn.promise,
      steeringInbox,
    };

    this._inFlightTurns.set(turnId, inFlightTurn);
    this._activeTurnByConversation.set(conversationKey, inFlightTurn);

    try {
      const turnPromise = executeTurn(agentName, input, { ...options, conversationId, turnId }, {
        llmClient: agentDeps.llmClient,
        toolRegistry: agentDeps.toolRegistry,
        middlewareRegistry: agentDeps.middlewareRegistry,
        eventBus: agentDeps.eventBus,
        conversationState,
        maxSteps: agentDeps.maxSteps,
        hitlStore: this._hitlStore,
        abortController,
        steering: steeringInbox,
      });
      void turnPromise.then(trackedTurn.resolve, trackedTurn.reject);
    } catch (err) {
      trackedTurn.reject(err);
    }

    try {
      return await trackedTurn.promise;
    } finally {
      steeringInbox.close();
      this._inFlightTurns.delete(turnId);
      if (this._activeTurnByConversation.get(conversationKey)?.turnId === turnId) {
        this._activeTurnByConversation.delete(conversationKey);
      }
    }
  }

  // -----------------------------------------------------------------------
  // processTurn
  // -----------------------------------------------------------------------

  async processTurn(
    agentName: string,
    input: string | InboundEnvelope,
    options?: ProcessTurnOptions,
  ): Promise<TurnResult> {
    return this._processTurnInternal(agentName, input, options);
  }

  async dispatchTurn(
    agentName: string,
    input: InboundEnvelope,
    options: { conversationId: string; turnId: string },
  ): Promise<TurnResult> {
    return this._processTurnInternal(agentName, input, options);
  }

  steerTurn(
    agentName: string,
    input: InboundEnvelope,
    conversationId: string,
  ): { turnId: string; disposition: "steered" } | null {
    const conversationKey = this._conversationKey(agentName, conversationId);
    const activeTurn = this._activeTurnByConversation.get(conversationKey);
    if (!activeTurn) {
      return null;
    }

    const enqueued = activeTurn.steeringInbox.enqueue(input);
    if (!enqueued) {
      return null;
    }

    return {
      turnId: activeTurn.turnId,
      disposition: "steered",
    };
  }

  private async _getHitlBarrierTurnResult(
    agentName: string,
    conversationId: string,
    turnId: string,
  ): Promise<TurnResult | null> {
    if (!this._hitlStore) {
      return null;
    }
    const batches = await this._hitlStore.listRecoverableBatches({ agentName, conversationId });
    const batch = batches[0];
    if (!batch) {
      return null;
    }
    const requests = await this._hitlStore.listBatchRequests(batch.batchId);
    const pendingRequestIds = requests
      .filter((request) => request.status === "pending")
      .map((request) => request.requestId);
    if (batch.status === "waitingForHuman" || pendingRequestIds.length > 0) {
      return {
        turnId,
        agentName,
        conversationId,
        status: "waitingForHuman",
        steps: [],
        pendingHitlBatchId: batch.batchId,
        pendingHitlRequestIds: pendingRequestIds,
      };
    }
    return {
      turnId,
      agentName,
      conversationId,
      status: "error",
      steps: [],
      error: new HarnessError(`Conversation "${conversationId}" has an active HITL barrier`),
    };
  }

  // -----------------------------------------------------------------------
  // ingress
  // -----------------------------------------------------------------------

  get ingress(): IngressApi {
    return this._ingressPipeline;
  }

  get events(): HarnessRuntime["events"] {
    return {
      on: <T extends EventPayload["type"]>(
        event: T,
        listener: (payload: Extract<EventPayload, { type: T }>) => void,
      ) => this._runtimeEvents.on(event, listener),
    };
  }

  // -----------------------------------------------------------------------
  // control
  // -----------------------------------------------------------------------

  get control(): ControlApi {
    return {
      abortConversation: async (input: {
        conversationId: string;
        agentName?: string;
        reason?: string;
      }): Promise<AbortResult> => {
        let abortedTurns = 0;

        for (const [id, turn] of this._inFlightTurns) {
          if (turn.conversationId !== input.conversationId) continue;
          if (input.agentName && turn.agentName !== input.agentName) continue;

          turn.abortController.abort(input.reason ?? "abortConversation");
          abortedTurns++;
        }

        return {
          conversationId: input.conversationId,
          abortedTurns,
          reason: input.reason,
        };
      },
      listPendingHitl: async (filter?: HitlRequestFilter): Promise<HitlRequestView[]> => {
        const hitlStore = this._getHitlStore();
        const records = await hitlStore.listPendingRequests(filter);
        return records.map(toHitlRequestView);
      },
      listPendingHitlBatches: async (filter?: HitlBatchFilter): Promise<HitlBatchView[]> => {
        const hitlStore = this._getHitlStore();
        const records = await hitlStore.listPendingBatches(filter);
        return Promise.all(records.map((record) => this._toHitlBatchView(record)));
      },
      getHitlBatch: async (batchId: string): Promise<HitlBatchView | null> => {
        const hitlStore = this._getHitlStore();
        const record = await hitlStore.getBatch(batchId);
        return record ? this._toHitlBatchView(record) : null;
      },
      getHitlRequest: async (requestId: string): Promise<HitlRequestView | null> => {
        const hitlStore = this._getHitlStore();
        const record = await hitlStore.getRequest(requestId);
        return record ? toHitlRequestView(record) : null;
      },
      submitHitlResult: async (input) => {
        if (this._closed) {
          return { status: "error", requestId: input.requestId, error: "Runtime is closed" };
        }
        const hitlStore = this._getHitlStore();
        const record = await safeGetHitlRecord(hitlStore, input.requestId);
        if (record instanceof Error) {
          return { status: "error", requestId: input.requestId, error: record.message };
        }
        if (!record) {
          return { status: "notFound", requestId: input.requestId };
        }
        const scopeError = validateHitlScope(record, input.agentName, input.conversationId);
        if (scopeError) {
          return { status: "invalid", requestId: input.requestId, error: scopeError };
        }
        if (record.status !== "pending") {
          return { status: "duplicate", request: toHitlRequestView(record) };
        }
        if (!record.batchId) {
          return { status: "error", requestId: input.requestId, request: toHitlRequestView(record), error: "HITL request is not attached to a batch" };
        }
        const recordBatchId = record.batchId;
        const batch = await hitlStore.getBatch(recordBatchId);
        if (!batch) {
          return { status: "error", requestId: input.requestId, request: toHitlRequestView(record), error: "Owning HITL batch not found" };
        }
        if (batch.status !== "waitingForHuman") {
          return { status: "invalid", requestId: input.requestId, error: `HITL batch is ${batch.status}` };
        }
        const validationError = validateHitlResult(record, input.result);
        if (validationError) {
          return { status: "invalid", requestId: input.requestId, error: validationError };
        }
        if (this._closed) {
          return { status: "error", requestId: input.requestId, request: toHitlRequestView(record), error: "Runtime is closed" };
        }

        const updated = await this._submitHitlDecision(hitlStore, input);
        if (updated instanceof Error) {
          const latest = await safeGetHitlRecord(hitlStore, input.requestId);
          if (!(latest instanceof Error) && latest && latest.status !== "pending") {
            return { status: "duplicate", request: toHitlRequestView(latest) };
          }
          return {
            status: "error",
            requestId: input.requestId,
            ...(latest instanceof Error || !latest ? {} : { request: toHitlRequestView(latest) }),
            error: updated.message,
          };
        }

        const rejected = isHitlRejectResult(input.result);
        if (!updated.batchId) {
          return {
            status: "accepted",
            request: toHitlRequestView(updated),
            resume: { status: "error", requestId: updated.requestId, error: "HITL request is not attached to a batch" },
          };
        }
        const updatedBatchId = updated.batchId;
        this._runtimeEvents.emit(rejected ? "hitl.rejected" : "hitl.resolved", {
          type: rejected ? "hitl.rejected" : "hitl.resolved",
          batchId: updatedBatchId,
          requestId: updated.requestId,
          turnId: updated.turnId,
          toolCallId: updated.toolCallId,
          conversationId: updated.conversationId,
          ...(rejected ? { reason: getHitlRejectReason(input.result) } : {}),
        } as EventPayload);

        const requestView = toHitlRequestView(updated);
        const latestBatch = await hitlStore.getBatch(updatedBatchId);
        if (!latestBatch) {
          return {
            status: "accepted",
            request: requestView,
            resume: { status: "error", requestId: updated.requestId, batchId: updatedBatchId, error: "Owning HITL batch not found" },
          };
        }
        const pendingPeers = (await hitlStore.listBatchRequests(updatedBatchId))
          .filter((request) => request.status === "pending")
          .map((request) => request.requestId);
        const resume = pendingPeers.length > 0
          ? { status: "waitingForPeers" as const, batchId: updatedBatchId, pendingRequestIds: pendingPeers }
          : this._scheduleReadyHitlBatchResume(latestBatch);
        return { status: "accepted", request: requestView, resume };
      },
      resumeHitlBatch: async (batchId: string) => {
        if (this._closed) {
          return { status: "error", batchId, error: "Runtime is closed" };
        }
        this._getHitlStore();
        const task = this._startHitlBatchResume(batchId);
        return task instanceof Error
          ? { status: "error", batchId, error: task.message }
          : task.promise;
      },
      resumeHitl: async (requestId: string) => {
        if (this._closed) {
          return { status: "error", requestId, error: "Runtime is closed" };
        }
        const hitlStore = this._getHitlStore();
        const request = await hitlStore.getRequest(requestId);
        if (!request) {
          return { status: "notFound", requestId };
        }
        if (!request.batchId) {
          return { status: "error", requestId, error: "HITL request is not attached to a batch" };
        }
        const batchId = request.batchId;
        const task = this._startHitlBatchResume(batchId);
        return task instanceof Error
          ? { status: "error", requestId, batchId, error: task.message }
          : task.promise;
      },
      cancelHitlBatch: async (input) => {
        if (this._closed) {
          return { status: "error", batchId: input.batchId, error: "Runtime is closed" };
        }
        const hitlStore = this._getHitlStore();
        const batch = await hitlStore.getBatch(input.batchId);
        if (!batch) {
          return { status: "notFound", batchId: input.batchId };
        }
        if (batch.status !== "preparing" && batch.status !== "waitingForHuman") {
          return { status: "notCancelable", batch: await this._toHitlBatchView(batch) };
        }
        const canceled = await hitlStore.cancelBatch(input.batchId, input.reason);
        return { status: "canceled", batch: await this._toHitlBatchView(canceled) };
      },
      cancelHitl: async (input) => {
        if (this._closed) {
          return { status: "error", requestId: input.requestId, error: "Runtime is closed" };
        }
        const hitlStore = this._getHitlStore();
        const record = await hitlStore.getRequest(input.requestId);
        if (!record) {
          return { status: "notFound", requestId: input.requestId };
        }
        if (!record.batchId) {
          return { status: "error", requestId: input.requestId, error: "HITL request is not attached to a batch" };
        }
        const batchId = record.batchId;
        const batch = await hitlStore.getBatch(batchId);
        if (!batch) {
          return { status: "notFound", batchId, requestId: input.requestId };
        }
        if (batch.status !== "preparing" && batch.status !== "waitingForHuman") {
          return { status: "notCancelable", batch: await this._toHitlBatchView(batch) };
        }
        const canceled = await hitlStore.cancelBatch(batchId, input.reason);
        return { status: "canceled", batch: await this._toHitlBatchView(canceled) };
      },
    };
  }

  private _getHitlStore(): HitlStore {
    if (!this._hitlStore) {
      throw new ConfigError("HITL store is not configured");
    }
    return this._hitlStore;
  }

  private async _recoverHitlBatches(): Promise<void> {
    if (!this._hitlStore) {
      return;
    }
    const batches = await this._hitlStore.listRecoverableBatches();
    let queuedForResume = 0;
    for (const batch of batches) {
      if (batch.status === "ready" || batch.status === "resuming" || batch.status === "continuing" || (batch.status === "failed" && batch.failure?.retryable)) {
        queuedForResume++;
        this._scheduleHitlBatchResume(batch);
      }
    }
    this._runtimeEvents.emit("hitl.recovery", {
      type: "hitl.recovery",
      recoveredBatches: batches.length,
      pendingBatches: batches.filter((batch) => batch.status === "waitingForHuman").length,
      queuedForResume,
    });
  }

  private _scheduleHitlBatchResume(batch: HitlBatchRecord): HitlSubmitResume {
    const task = this._startHitlBatchResume(batch.batchId, batch);
    return task instanceof Error
      ? { status: "error", batchId: batch.batchId, requestId: batch.toolCalls.find((toolCall) => toolCall.requestId)?.requestId ?? "", error: task.message }
      : {
          status: "scheduled",
          batchId: batch.batchId,
          requestIds: batch.toolCalls.flatMap((toolCall) => toolCall.requestId ? [toolCall.requestId] : []),
        };
  }

  private _scheduleReadyHitlBatchResume(batch: HitlBatchRecord): HitlSubmitResume {
    const requestIds = batch.toolCalls.flatMap((toolCall) => toolCall.requestId ? [toolCall.requestId] : []);
    this._runtimeEvents.emit("hitl.batch.ready", {
      type: "hitl.batch.ready",
      batchId: batch.batchId,
      requestIds,
    });
    return this._scheduleHitlBatchResume(batch);
  }

  private _startHitlBatchResume(
    batchId: string,
    observedBatch?: HitlBatchRecord,
  ): InFlightHitlResume | Error {
    if (this._closed) {
      return new Error("Runtime is closed");
    }
    const existing = this._inFlightHitlResumes.get(batchId);
    if (existing) {
      return existing;
    }

    const abortController = new AbortController();
    let promise!: Promise<ResumeHitlResult>;
    promise = this._resumeHitlBatchInternal(batchId, abortController.signal)
      .then((result) => {
        if (result.status === "error" && observedBatch) {
          this._emitHitlRecoveryFailure(observedBatch, new Error(result.error));
        }
        return result;
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (observedBatch) {
          this._emitHitlRecoveryFailure(observedBatch, error);
        }
        return {
          status: "error",
          batchId,
          error: error.message,
        } satisfies ResumeHitlResult;
      })
      .finally(() => {
        if (this._inFlightHitlResumes.get(batchId)?.promise === promise) {
          this._inFlightHitlResumes.delete(batchId);
        }
      });

    const task: InFlightHitlResume = { batchId, abortController, promise };
    this._inFlightHitlResumes.set(batchId, task);
    return task;
  }

  private _emitHitlRecoveryFailure(batch: HitlBatchRecord, error: Error): void {
    this._runtimeEvents.emit("hitl.failed", {
      type: "hitl.failed",
      batchId: batch.batchId,
      turnId: batch.turnId,
      conversationId: batch.conversationId,
      retryable: true,
      error,
    });
  }

  private async _resumeHitlBatchInternal(
    batchId: string,
    abortSignal?: AbortSignal,
  ): Promise<ResumeHitlResult> {
    if (!this._hitlStore) {
      throw new ConfigError("HITL store is not configured");
    }
    if (abortSignal?.aborted) {
      return { status: "error", batchId, error: "HITL resume aborted" };
    }

    const initial = await this._hitlStore.getBatch(batchId);
    if (!initial) {
      return { status: "notFound", batchId };
    }
    if (initial.status === "completed") {
      return { status: "alreadyCompleted", batch: await this._toHitlBatchView(initial) };
    }
    if (
      initial.status === "blocked" ||
      initial.status === "canceled" ||
      initial.status === "expired" ||
      (initial.status === "failed" && initial.failure?.retryable !== true)
    ) {
      return {
        status: "notReady",
        batch: await this._toHitlBatchView(initial),
        pendingRequestIds: [],
      };
    }
    const batchRequests = await this._hitlStore.listBatchRequests(batchId);
    const pendingRequests = batchRequests.filter((request) => request.status === "pending");
    const blockedRequests = batchRequests.filter((request) => request.status === "blocked");
    if (pendingRequests.length > 0 || initial.status === "waitingForHuman" || initial.status === "preparing") {
      return {
        status: "notReady",
        batch: await this._toHitlBatchView(initial),
        pendingRequestIds: pendingRequests.map((request) => request.requestId),
      };
    }
    if (blockedRequests.length > 0 && !initial.appendCommit) {
      return {
        status: "notReady",
        batch: await this._toHitlBatchView(initial),
        pendingRequestIds: blockedRequests.map((request) => request.requestId),
      };
    }

    const lease = await this._hitlStore.acquireBatchLease(batchId, this._resumeOwnerId, this._hitlLeaseTtlMs);
    if (lease.status !== "acquired") {
      return {
        status: "leaseConflict",
        batch: lease.batch ? await this._toHitlBatchView(lease.batch) : null,
      };
    }

    const guard = lease.guard;
    let batch = lease.batch;
    this._runtimeEvents.emit("hitl.batch.resuming", {
      type: "hitl.batch.resuming",
      batchId,
      requestIds: (await this._hitlStore.listBatchRequests(batchId)).map((request) => request.requestId),
    });

    try {
      const agentDeps = this._agents.get(batch.agentName);
      if (!agentDeps) {
        throw new HitlResumeError(`Unknown agent: "${batch.agentName}"`, false);
      }

      const conversationKey = this._conversationKey(batch.agentName, batch.conversationId);
      let conversationState = this._conversations.get(conversationKey);
      if (!conversationState) {
        conversationState = createConversationState();
        this._conversations.set(conversationKey, conversationState);
      }

      const continuationTurnId = batch.appendCommit?.continuationTurnId ?? `turn-${randomUUID()}`;
      const continuationAbortController = createLinkedAbortController(abortSignal);
      const continuationSteeringInbox = new SteeringInbox();
      const trackedContinuationTurn = createDeferred<TurnResult>();
      const continuationInFlightTurn: InFlightTurn = {
        turnId: continuationTurnId,
        agentName: batch.agentName,
        conversationId: batch.conversationId,
        abortController: continuationAbortController,
        promise: trackedContinuationTurn.promise,
        steeringInbox: continuationSteeringInbox,
      };
      const previousActiveTurn = this._activeTurnByConversation.get(conversationKey);

      let continuationStarted = false;
      let continuationRegistered = false;
      const registerContinuationTurn = () => {
        this._inFlightTurns.set(continuationTurnId, continuationInFlightTurn);
        this._activeTurnByConversation.set(conversationKey, continuationInFlightTurn);
        continuationRegistered = true;
      };
      try {
        if (!batch.appendCommit) {
          batch = await this._prepareBatchToolResults(batch, guard, abortSignal);
          try {
            conversationState.restore(batch.conversationEvents);
            conversationState._turnActive = true;
            const appendedEvents: MessageEvent[] = [];
            for (const result of batch.toolResults.slice().sort((a, b) => a.toolCallIndex - b.toolCallIndex)) {
              const event = createToolResultEvent(batch.batchId, result);
              emitAppendIfMissing(conversationState, event.message.id, event);
              appendedEvents.push(event);
            }

            const drainedSteers = await this._hitlStore.drainQueuedSteers(batchId, guard);
            for (const steer of drainedSteers) {
              const event = createQueuedSteerEvent(steer);
              emitAppendIfMissing(conversationState, event.message.id, event);
              appendedEvents.push(event);
            }

            batch = await this._hitlStore.commitBatchAppend(batchId, {
              committedAt: new Date().toISOString(),
              toolResultEventIds: batch.toolResults.map((result) => `tool-result-${batch.batchId}-${result.toolCallId}`),
              queuedSteerEventIds: drainedSteers.map((steer) => `hitl-steer-${steer.queuedInputId}`),
              queuedSteerIds: drainedSteers.map((steer) => steer.queuedInputId),
              continuationTurnId,
              conversationEvents: appendedEvents,
            }, guard);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw error instanceof HitlResumeError
              ? error
              : new HitlResumeError(error.message, true);
          } finally {
            conversationState._turnActive = false;
          }
        }

        registerContinuationTurn();

        conversationState.restore([
          ...batch.conversationEvents,
          ...(batch.appendCommit?.conversationEvents ?? []),
        ]);
        continuationStarted = true;
        const continuationPromise = executeContinuationTurn(batch.agentName, {
          conversationId: batch.conversationId,
          turnId: continuationTurnId,
        }, {
          llmClient: agentDeps.llmClient,
          toolRegistry: agentDeps.toolRegistry,
          middlewareRegistry: agentDeps.middlewareRegistry,
          eventBus: agentDeps.eventBus,
          conversationState,
          maxSteps: agentDeps.maxSteps,
          hitlStore: this._hitlStore,
          abortController: continuationAbortController,
          steering: continuationSteeringInbox,
        });
        void continuationPromise.then(trackedContinuationTurn.resolve, trackedContinuationTurn.reject);
        const continuationResult = await trackedContinuationTurn.promise;

        const completed = await this._hitlStore.completeBatch(batchId, {
          completedAt: new Date().toISOString(),
          continuationTurnId,
          continuationStatus: continuationResult.status,
        }, guard);
        const completedRequests = await this._hitlStore.listBatchRequests(batchId);
        this._runtimeEvents.emit("hitl.batch.completed", {
          type: "hitl.batch.completed",
          batchId,
          requestIds: completedRequests.map((request) => request.requestId),
        });

        return { status: "completed", batch: await this._toHitlBatchView(completed) };
      } finally {
        if (!continuationStarted) {
          trackedContinuationTurn.resolve({
            turnId: continuationTurnId,
            agentName: batch.agentName,
            conversationId: batch.conversationId,
            status: continuationAbortController.signal.aborted ? "aborted" : "error",
            steps: [],
          });
        }
        continuationSteeringInbox.close();
        if (continuationRegistered) {
          this._inFlightTurns.delete(continuationTurnId);
        }
        if (continuationRegistered && this._activeTurnByConversation.get(conversationKey)?.turnId === continuationTurnId) {
          if (
            previousActiveTurn &&
            this._inFlightTurns.get(previousActiveTurn.turnId) === previousActiveTurn
          ) {
            this._activeTurnByConversation.set(conversationKey, previousActiveTurn);
          } else {
            this._activeTurnByConversation.delete(conversationKey);
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const retryable = isRetryableHitlResumeError(error);
      return await this._recordHitlBatchFailure(batch, guard, error, retryable);
    } finally {
      await this._releaseHitlBatchLease(batchId, guard);
    }
  }

  private async _submitHitlDecision(
    hitlStore: HitlStore,
    input: SubmitHitlResultInput,
  ): Promise<HitlRequestRecord | Error> {
    try {
      return isHitlRejectResult(input.result)
        ? await hitlStore.rejectRequest(input.requestId, input.result, input.idempotencyKey)
        : await hitlStore.resolveRequest(input.requestId, input.result, input.idempotencyKey);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  private async _prepareBatchToolResults(
    batch: HitlBatchRecord,
    guard: HitlLeaseGuard,
    abortSignal?: AbortSignal,
  ): Promise<HitlBatchRecord> {
    if (!this._hitlStore) {
      throw new ConfigError("HITL store is not configured");
    }
    let current = batch;
    const requests = await this._hitlStore.listBatchRequests(batch.batchId);
    for (const toolCall of batch.toolCalls.slice().sort((a, b) => a.toolCallIndex - b.toolCallIndex)) {
      if (current.toolResults.some((result) => result.toolCallId === toolCall.toolCallId)) {
        continue;
      }
      if (!toolCall.requiresHitl) {
        throw new HitlResumeError(`Missing recorded non-HITL result for "${toolCall.toolCallId}"`, false);
      }
      const request = requests.find((item) => item.requestId === toolCall.requestId);
      if (!request) {
        throw new HitlResumeError(`HITL request not found for "${toolCall.toolCallId}"`, false);
      }
      const { result, finalArgs } = await this._executeHitlRequestTool(request, guard, abortSignal);
      current = await this._hitlStore.recordBatchToolResult(batch.batchId, {
        batchId: batch.batchId,
        toolCallId: request.toolCallId,
        toolCallIndex: requireHitlRequestToolCallIndex(request),
        toolName: request.toolName,
        result,
        finalArgs,
        recordedAt: new Date().toISOString(),
      });
      await this._hitlStore.completeRequest(request.requestId, {
        toolResult: result,
        finalArgs,
        completedAt: new Date().toISOString(),
      }, guard);
      this._runtimeEvents.emit("tool.done", {
        type: "tool.done",
        turnId: request.turnId,
        agentName: request.agentName,
        conversationId: request.conversationId,
        stepNumber: request.stepNumber,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        args: finalArgs,
        result,
      });
      this._runtimeEvents.emit("hitl.completed", {
        type: "hitl.completed",
        batchId: requireHitlRequestBatchId(request),
        requestId: request.requestId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
        conversationId: request.conversationId,
        result,
      });
    }
    return current;
  }

  private async _executeHitlRequestTool(
    request: HitlRequestRecord,
    guard: HitlLeaseGuard,
    abortSignal?: AbortSignal,
  ): Promise<{ result: ToolResult; finalArgs: JsonObject }> {
    const agentDeps = this._agents.get(request.agentName);
    if (!agentDeps) {
      throw new HitlResumeError(`Unknown agent: "${request.agentName}"`, false);
    }
    if (request.status === "rejected" || isHitlRejectResult(request.result)) {
      return {
        result: {
          type: "error",
          error: getHitlRejectReason(request.result) ?? "Human rejected tool call",
        },
        finalArgs: request.originalArgs,
      };
    }
    const tool = agentDeps.toolRegistry.get(request.toolName);
    if (!tool) {
      throw new HitlResumeError(`Tool "${request.toolName}" not found`, false);
    }
    const mapped = tool.hitl && tool.hitl.mode !== "never" && tool.hitl.mapResult
      ? await tool.hitl.mapResult({ request, result: mustHaveHitlResult(request) })
      : defaultHitlMapping(request);
    if (mapped.action === "reject") {
      return {
        result: mapped.result ?? { type: "error", error: "Human rejected tool call" },
        finalArgs: request.originalArgs,
      };
    }
    if (abortSignal?.aborted) {
      throw new HitlResumeError("HITL resume aborted", true);
    }
    const finalArgs = mapped.args ?? request.originalArgs;
    const validation = agentDeps.toolRegistry.validate(request.toolName, finalArgs);
    if (!validation.valid) {
      throw new HitlResumeError(`Invalid arguments: ${validation.errors}`, false);
    }
    await this._getHitlStore().startRequestExecution(request.requestId, guard, new Date().toISOString());
    try {
      const result = await tool.handler(finalArgs, {
        agentName: request.agentName,
        conversationId: request.conversationId,
        abortSignal: abortSignal ?? new AbortController().signal,
      });
      return { result, finalArgs };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new HitlResumeError(error.message, false);
    }
  }

  private async _recordHitlBatchFailure(
    batch: HitlBatchRecord,
    guard: HitlLeaseGuard,
    error: Error,
    retryable: boolean,
  ): Promise<ResumeHitlResult> {
    if (!this._hitlStore) {
      throw new ConfigError("HITL store is not configured");
    }
    const failure: HitlFailure = {
      error: error.message,
      retryable,
      failedAt: new Date().toISOString(),
    };
    try {
      const requests = await this._hitlStore.listBatchRequests(batch.batchId);
      for (const request of requests) {
        if (
          request.status === "completed" ||
          request.status === "canceled" ||
          request.status === "expired" ||
          request.status === "failed"
        ) {
          continue;
        }
        await this._hitlStore.failRequest(request.requestId, failure, guard);
      }
      const failed = await this._hitlStore.failBatch(batch.batchId, failure, guard);
      this._runtimeEvents.emit("hitl.failed", {
        type: "hitl.failed",
        batchId: batch.batchId,
        turnId: batch.turnId,
        conversationId: batch.conversationId,
        retryable,
        error,
      });
      return { status: "failed", batch: await this._toHitlBatchView(failed), error: error.message };
    } catch (persistErr) {
      const persistenceError = persistErr instanceof Error ? persistErr : new Error(String(persistErr));
      const latest = await this._hitlStore.getBatch(batch.batchId).catch(() => null);
      if (latest?.lease && !hitlLeaseMatches(latest, guard)) {
        return { status: "leaseConflict", batch: await this._toHitlBatchView(latest) };
      }
      return {
        status: "error",
        batchId: batch.batchId,
        batch: await this._toHitlBatchView(batch),
        error: `Failed to persist HITL failure after "${error.message}": ${persistenceError.message}`,
      };
    }
  }

  private async _releaseHitlBatchLease(batchId: string, guard: HitlLeaseGuard): Promise<void> {
    if (!this._hitlStore) {
      return;
    }
    try {
      await this._hitlStore.releaseBatchLease(batchId, guard);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._runtimeEvents.emit("hitl.failed", {
        type: "hitl.failed",
        batchId,
        retryable: true,
        error,
      });
    }
  }

  private async _toHitlBatchView(batch: HitlBatchRecord): Promise<HitlBatchView> {
    const hitlStore = this._getHitlStore();
    const requests = await hitlStore.listBatchRequests(batch.batchId);
    const queuedSteers = hitlStore.listQueuedSteers
      ? await hitlStore.listQueuedSteers(batch.batchId)
      : [];
    return toHitlBatchView(batch, requests, queuedSteers.filter((item) => item.status === "queued").length);
  }

  async queueHitlSteer(
    agentName: string,
    input: InboundEnvelope,
    conversationId: string,
  ): Promise<{ batchId: string; pendingRequestIds: string[]; disposition: "queuedForHitl" } | null> {
    if (!this._hitlStore) {
      return null;
    }
    const batch = await this._hitlStore.getOpenBatchByConversation(agentName, conversationId);
    if (!batch) {
      return null;
    }
    let queued: Awaited<ReturnType<HitlStore["enqueueSteer"]>>;
    try {
      queued = await this._hitlStore.enqueueSteer(batch.batchId, {
        source: "ingress",
        envelope: input,
        receivedAt: new Date().toISOString(),
      });
    } catch (err) {
      const latest = await this._hitlStore.getOpenBatchByConversation(agentName, conversationId);
      if (!latest || latest.batchId !== batch.batchId) {
        return null;
      }
      throw err;
    }
    const pendingRequestIds = (await this._hitlStore.listBatchRequests(batch.batchId))
      .filter((request) => request.status === "pending")
      .map((request) => request.requestId);
    this._runtimeEvents.emit("hitl.steer.queued", {
      type: "hitl.steer.queued",
      batchId: batch.batchId,
      conversationId,
      queuedInputId: queued.queuedInputId,
    });
    return {
      batchId: batch.batchId,
      pendingRequestIds,
      disposition: "queuedForHitl",
    };
  }

  async hasHitlBarrier(agentName: string, conversationId: string): Promise<boolean> {
    if (!this._hitlStore) {
      return false;
    }
    const batches = await this._hitlStore.listRecoverableBatches({ agentName, conversationId });
    return batches.length > 0;
  }

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    this._closed = true;

    // Abort all in-flight turns
    const promises: Promise<unknown>[] = [];
    for (const [, turn] of this._inFlightTurns) {
      turn.abortController.abort("Runtime closed");
      turn.steeringInbox.close();
      promises.push(turn.promise.catch(() => {}));
    }
    for (const [, resume] of this._inFlightHitlResumes) {
      resume.abortController.abort("Runtime closed");
      promises.push(resume.promise.catch(() => {}));
    }

    // Wait for turns to settle (with timeout)
    if (promises.length > 0) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS));
      await Promise.race([Promise.allSettled(promises), timeout]);
    }

    // Clean up
    this._inFlightTurns.clear();
    this._inFlightHitlResumes.clear();
    this._activeTurnByConversation.clear();
    this._conversations.clear();
  }
}

function validateHitlScope(
  record: HitlRequestRecord,
  agentName: string | undefined,
  conversationId: string | undefined,
): string | null {
  if (agentName && record.agentName !== agentName) {
    return `HITL request belongs to agent "${record.agentName}", not "${agentName}"`;
  }
  if (conversationId && record.conversationId !== conversationId) {
    return `HITL request belongs to conversation "${record.conversationId}", not "${conversationId}"`;
  }
  return null;
}

function validateHitlResult(
  record: HitlRequestRecord,
  result: HitlHumanResult,
): string | null {
  if (isHitlRejectResult(result)) {
    return null;
  }

  const value = getHitlResultValue(result);
  switch (record.responseSchema.type) {
    case "approval":
      return null;
    case "text":
      if (typeof value !== "string") {
        return "HITL text response requires a string value";
      }
      return record.responseSchema.schema
        ? validateSchema(record.responseSchema.schema, value)
        : null;
    case "form":
      if (!isJsonObject(value)) {
        return "HITL form response requires a JSON object value";
      }
      return validateSchema(record.responseSchema.schema, value);
  }
}

function validateSchema(schema: Record<string, unknown>, value: unknown): string | null {
  const validate = hitlAjv.compile(schema);
  if (validate(value)) {
    return null;
  }
  return hitlAjv.errorsText(validate.errors);
}

function mustHaveHitlResult(record: HitlRequestRecord): HitlHumanResult {
  if (!record.result) {
    throw new Error(`HITL request "${record.requestId}" has no human result`);
  }
  return record.result;
}

async function safeGetHitlRecord(
  hitlStore: HitlStore,
  requestId: string,
): Promise<HitlRequestRecord | null | Error> {
  try {
    return await hitlStore.getRequest(requestId);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

class HitlResumeError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "HitlResumeError";
  }
}

function requireHitlRequestBatchId(request: HitlRequestRecord): string {
  if (!request.batchId) {
    throw new HitlResumeError(`HITL request is not attached to a batch: ${request.requestId}`, false);
  }
  return request.batchId;
}

function requireHitlRequestToolCallIndex(request: HitlRequestRecord): number {
  if (request.toolCallIndex === undefined) {
    throw new HitlResumeError(`HITL request is missing toolCallIndex: ${request.requestId}`, false);
  }
  return request.toolCallIndex;
}

function hitlLeaseMatches(batch: HitlBatchRecord, guard: HitlLeaseGuard): boolean {
  return batch.lease?.ownerId === guard.ownerId && batch.lease?.token === guard.token;
}

function createLinkedAbortController(parentSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (!parentSignal) {
    return controller;
  }
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return controller;
  }
  parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });
  return controller;
}

function isRetryableHitlResumeError(error: Error): boolean {
  return error instanceof HitlResumeError ? error.retryable : false;
}

function defaultHitlMapping(record: HitlRequestRecord): { action: "approve"; args?: JsonObject } | { action: "reject"; result?: ToolResult } {
  const result = mustHaveHitlResult(record);
  if (isHitlRejectResult(result)) {
    return {
      action: "reject",
      result: {
        type: "error",
        error: getHitlRejectReason(result) ?? "Human rejected tool call",
      },
    };
  }

  const value = getHitlResultValue(result);
  if (record.responseSchema.type === "form" && isJsonObject(value)) {
    return {
      action: "approve",
      args: value,
    };
  }

  return { action: "approve", args: record.originalArgs };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHitlRejectResult(result: HitlHumanResult | undefined): boolean {
  if (!result) {
    return false;
  }
  return "kind" in result ? result.kind === "reject" : result.decision === "reject";
}

function getHitlRejectReason(result: HitlHumanResult | undefined): string | undefined {
  if (!result || !isHitlRejectResult(result)) {
    return undefined;
  }
  return (result as { reason?: string }).reason;
}

function getHitlResultValue(result: HitlHumanResult): unknown {
  return (result as { value?: unknown }).value;
}

function toToolResultOutput(toolResult: ToolResult) {
  return toolResult.type === "text"
    ? { type: "text" as const, value: toolResult.text }
    : toolResult.type === "json"
      ? { type: "json" as const, value: toolResult.data }
      : { type: "error-text" as const, value: toolResult.error };
}

function createToolResultEvent(batchId: string, result: {
  toolCallId: string;
  toolName: string;
  result: ToolResult;
}): Extract<MessageEvent, { type: "appendMessage" }> {
  return {
    type: "appendMessage",
    message: {
      id: `tool-result-${batchId}-${result.toolCallId}`,
      data: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            output: toToolResultOutput(result.result),
          },
        ],
      },
      metadata: {
        __createdBy: "core",
        __hitlBatchId: batchId,
      },
    },
  };
}

function createQueuedSteerEvent(steer: { queuedInputId: string; envelope: InboundEnvelope }): Extract<MessageEvent, { type: "appendMessage" }> {
  return {
    type: "appendMessage",
    message: {
      id: `hitl-steer-${steer.queuedInputId}`,
      data: {
        role: "user",
        content: extractEnvelopeText(steer.envelope),
      },
      metadata: {
        __createdBy: "core",
        __hitlQueuedSteer: true,
        __eventName: steer.envelope.name,
      },
    },
  };
}

function emitAppendIfMissing(
  conversationState: ConversationStateImpl,
  messageId: string,
  event: Extract<MessageEvent, { type: "appendMessage" }>,
): void {
  if (conversationState.messages.some((message) => message.id === messageId)) {
    return;
  }
  conversationState.emit(event);
}

function extractEnvelopeText(envelope: InboundEnvelope): string {
  return envelope.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function createHitlAjv() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv;
}

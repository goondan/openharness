import type {
  HarnessRuntime,
  InboundEnvelope,
  IngressApi,
  ControlApi,
  AbortResult,
  ProcessTurnOptions,
  TurnResult,
  LlmClient,
  EventPayload,
  DurableInboundReferenceStore,
  DurableInboundItem,
  DeadLetterInboundInput,
  ReleaseInboundItemInput,
  RetryInboundInput,
  HumanApprovalReferenceStore,
  HumanApprovalRecord,
  HumanTaskRecord,
  HumanTaskView,
  SubmitHumanResultInput,
  CancelHumanApprovalInput,
  ResumeHumanApprovalInput,
  HumanResult,
} from "@goondan/openharness-types";
import type { ConversationStateImpl } from "./conversation-state.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { MiddlewareRegistry } from "./middleware-chain.js";
import type { EventBus } from "./event-bus.js";
import type { IngressPipeline } from "./ingress/pipeline.js";
import { createConversationState } from "./conversation-state.js";
import { executeToolCall } from "./execution/tool-call.js";
import { executeTurn, type TurnSteeredInput, type TurnSteeringController } from "./execution/turn.js";
import { HarnessError, ConfigError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { inboundUserMessageCommitRef } from "./inbound/scheduler.js";
import { stableHash } from "./idempotency-key.js";

const CLOSE_TIMEOUT_MS = 5000;

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

interface PreparedContinuationTurn {
  turnId: string;
  promise: Promise<TurnResult>;
  start: () => Promise<TurnResult>;
  discard: () => void;
}

class SteeringInbox implements TurnSteeringController {
  private _queue: Array<InboundEnvelope | TurnSteeredInput> = [];
  private _closed = false;
  private _consume?: (input: TurnSteeredInput) => Promise<void> | void;

  constructor(consume?: (input: TurnSteeredInput) => Promise<void> | void) {
    this._consume = consume;
  }

  enqueue(input: InboundEnvelope | TurnSteeredInput): boolean {
    if (this._closed) {
      return false;
    }
    this._queue.push(input);
    return true;
  }

  drain(): Array<InboundEnvelope | TurnSteeredInput> {
    const inputs = this._queue;
    this._queue = [];
    return inputs;
  }

  async consume(input: TurnSteeredInput): Promise<void> {
    await this._consume?.(input);
  }

  tryCloseIfEmpty(): boolean {
    if (this._closed) {
      return true;
    }
    if (this._queue.length > 0) {
      return false;
    }
    this._closed = true;
    return true;
  }

  close(): void {
    this._closed = true;
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

function turnResultForDurableDuplicate(
  item: DurableInboundItem & { failure?: { reason?: string } },
  agentName: string,
  conversationId: string,
  cached?: TurnResult,
): TurnResult {
  const turnId = item.turnId ?? `turn-${randomUUID()}`;
  const base = {
    turnId,
    agentName,
    conversationId,
    steps: [],
  };

  switch (item.status) {
    case "blocked":
      return {
        ...base,
        status: "waitingForHuman",
      };
    case "consumed":
      if (cached) {
        return cached;
      }
      return {
        ...base,
        status: "aborted",
        error: new Error(
          `Durable inbound item "${item.id}" is consumed but has no cached turn result; duplicate caller must use recovery state instead of assuming completion.`,
        ),
      };
    case "pending":
    case "leased":
    case "delivered":
      return {
        ...base,
        status: "aborted",
        error: new Error(
          `Durable inbound item "${item.id}" is ${item.status}; duplicate caller must wait for recovery or the active turn.`,
        ),
      };
    case "failed":
    case "deadLetter": {
      const reason = item.failure?.reason ?? item.lastError ?? `Durable inbound item "${item.id}" is ${item.status}.`;
      return {
        ...base,
        status: "error",
        error: new Error(reason),
      };
    }
  }
}

type PublicHumanTaskView = (HumanTaskRecord | HumanTaskView) & {
  type?: string;
  idempotencyKey?: string;
};

type PublicHumanApprovalRecord = HumanApprovalRecord & {
  requiredTaskIds: string[];
};

function toPublicHumanTaskView<T extends HumanTaskRecord | HumanTaskView>(
  task: T,
): T & { type: string; idempotencyKey?: string };
function toPublicHumanTaskView(task: undefined | null): undefined | null;
function toPublicHumanTaskView(
  task: HumanTaskRecord | HumanTaskView | null | undefined,
): PublicHumanTaskView | null | undefined {
  if (!task) {
    return task;
  }
  return {
    ...task,
    type: task.taskType,
    idempotencyKey: task.resultIdempotencyKey,
  };
}

async function toPublicHumanApprovalRecord(
  approval: HumanApprovalRecord,
  store?: HumanApprovalReferenceStore,
): Promise<PublicHumanApprovalRecord>;
async function toPublicHumanApprovalRecord(
  approval: HumanApprovalRecord | null | undefined,
  store?: HumanApprovalReferenceStore,
): Promise<PublicHumanApprovalRecord | null | undefined>;
async function toPublicHumanApprovalRecord(
  approval: HumanApprovalRecord | null | undefined,
  store?: HumanApprovalReferenceStore,
): Promise<PublicHumanApprovalRecord | null | undefined> {
  if (!approval) {
    return approval;
  }
  const toolCall = approval.toolCall;
  const taskIds = approval.taskIds ?? [];
  let requiredTaskIds = approval.requiredTaskIds;
  if (!requiredTaskIds && store && taskIds.length > 0) {
    const tasks = await Promise.all(
      taskIds.map((taskId) => store.getTask(taskId)),
    );
    const required = tasks
      .filter((task): task is HumanTaskRecord => Boolean(task) && task!.required !== false)
      .map((task) => task.id);
    requiredTaskIds = tasks.some(Boolean) ? required : taskIds;
  }

  return {
    ...approval,
    agentName: approval.agentName ?? toolCall.agentName,
    conversationId: approval.conversationId ?? toolCall.conversationId,
    turnId: approval.turnId ?? toolCall.turnId,
    toolCallId: approval.toolCallId ?? toolCall.toolCallId,
    requiredTaskIds: requiredTaskIds ?? taskIds,
  };
}

function humanApprovalResumeStatus(
  approval: HumanApprovalRecord | null | undefined,
): "completed" | "failed" | "blocked" {
  const status = approval?.status;
  if (status === "completed") {
    return "completed";
  }
  return status === "failed" || status === "canceled" || status === "expired"
    ? "failed"
    : "blocked";
}

// ---------------------------------------------------------------------------
// HarnessRuntimeImpl
// ---------------------------------------------------------------------------

export class HarnessRuntimeImpl implements HarnessRuntime {
  private readonly _agents: Map<string, AgentDeps>;
  private readonly _conversations: Map<string, ConversationStateImpl> = new Map();
  private readonly _inFlightTurns: Map<string, InFlightTurn> = new Map();
  private readonly _activeTurnByConversation: Map<string, InFlightTurn> = new Map();
  private readonly _turnResultByInboundItem: Map<string, TurnResult> = new Map();
  private readonly _ingressPipeline: IngressPipeline;
  private readonly _runtimeEvents: EventBus;
  private readonly _durableInboundStore?: DurableInboundReferenceStore;
  private readonly _humanApprovalStore?: HumanApprovalReferenceStore;
  private readonly _humanApprovalResumeLeaseMs: number;
  private _closed = false;

  constructor(
    agents: Map<string, AgentDeps>,
    ingressPipeline: IngressPipeline,
    runtimeEvents: EventBus,
    durableInboundStore?: DurableInboundReferenceStore,
    humanApprovalStore?: HumanApprovalReferenceStore,
    humanApprovalResumeLeaseMs = 30_000,
  ) {
    this._agents = agents;
    this._ingressPipeline = ingressPipeline;
    this._runtimeEvents = runtimeEvents;
    this._durableInboundStore = durableInboundStore;
    this._humanApprovalStore = humanApprovalStore;
    this._humanApprovalResumeLeaseMs = humanApprovalResumeLeaseMs;
  }

  private _conversationKey(agentName: string, conversationId: string): string {
    return `${agentName}::${conversationId}`;
  }

  private _getConversationState(agentName: string, conversationId: string): ConversationStateImpl {
    const conversationKey = this._conversationKey(agentName, conversationId);
    let conversationState = this._conversations.get(conversationKey);
    if (!conversationState) {
      conversationState = createConversationState();
      this._conversations.set(conversationKey, conversationState);
    }
    return conversationState;
  }

  private _createSteeringInbox(turnId: string): SteeringInbox {
    return new SteeringInbox(async (steered) => {
      if (!this._durableInboundStore || !steered.inboundItem || !steered.commitRef) {
        return;
      }
      await this._durableInboundStore.markConsumed({
        id: steered.inboundItem.id,
        turnId,
        commitRef: steered.commitRef,
      });
      this._runtimeEvents.emit("inbound.consumed", {
        type: "inbound.consumed",
        inboundItemId: steered.inboundItem.id,
        turnId,
        commitRef: steered.commitRef,
      });
    });
  }

  private async _processTurnInternal(
    agentName: string,
    input: string | InboundEnvelope,
    options?: (ProcessTurnOptions & { turnId?: string }),
    durable?: {
      item: DurableInboundItem;
      commitRef: string;
    },
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

    const conversationKey = this._conversationKey(agentName, conversationId);

    const conversationState = this._getConversationState(agentName, conversationId);

    const abortController = new AbortController();
    const turnId = options?.turnId ?? `turn-${randomUUID()}`;
    const steeringInbox = this._createSteeringInbox(turnId);
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
      let inboundItem = durable?.item;
      if (inboundItem && this._durableInboundStore) {
        const wasDelivered = inboundItem.status === "delivered";
        inboundItem = await this._durableInboundStore.markDelivered({
          id: inboundItem.id,
          turnId,
        });
        if (!wasDelivered && inboundItem.status === "delivered") {
          this._runtimeEvents.emit("inbound.delivered", {
            type: "inbound.delivered",
            inboundItemId: inboundItem.id,
            turnId,
            sequence: inboundItem.sequence,
          });
        }
      }
      const turnPromise = executeTurn(agentName, input, { ...options, conversationId, turnId }, {
        llmClient: agentDeps.llmClient,
        toolRegistry: agentDeps.toolRegistry,
        middlewareRegistry: agentDeps.middlewareRegistry,
        eventBus: agentDeps.eventBus,
        conversationState,
        maxSteps: agentDeps.maxSteps,
        abortController,
        steering: steeringInbox,
        humanApprovalStore: this._humanApprovalStore,
        inboundItem,
        inboundCommitRef: durable?.commitRef,
        consumeInboundItem: async ({ item, turnId: consumedTurnId, commitRef }) => {
          if (!this._durableInboundStore) {
            return;
          }
          await this._durableInboundStore.markConsumed({
            id: item.id,
            turnId: consumedTurnId,
            commitRef,
          });
          this._runtimeEvents.emit("inbound.consumed", {
            type: "inbound.consumed",
            inboundItemId: item.id,
            turnId: consumedTurnId,
            commitRef,
          });
        },
        blockInboundItem: async ({ item, blocker }) => {
          if (!this._durableInboundStore) {
            return;
          }
          const blocked = await this._durableInboundStore.markBlocked({
            id: item.id,
            blockedBy: blocker,
          });
          this._runtimeEvents.emit("inbound.blocked", {
            type: "inbound.blocked",
            inboundItemId: blocked.id,
            blockedBy: blocker,
          });
        },
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

  private async _continueTurnInternal(
    agentName: string,
    conversationId: string,
  ): Promise<TurnResult> {
    const continuation = this._prepareContinuationTurn(agentName, conversationId);
    return continuation.start();
  }

  private _prepareContinuationTurn(
    agentName: string,
    conversationId: string,
  ): PreparedContinuationTurn {
    if (this._closed) {
      throw new HarnessError("Runtime is closed");
    }

    const agentDeps = this._agents.get(agentName);
    if (!agentDeps) {
      throw new ConfigError(`Unknown agent: "${agentName}"`);
    }

    const conversationKey = this._conversationKey(agentName, conversationId);
    const conversationState = this._getConversationState(agentName, conversationId);
    const abortController = new AbortController();
    const turnId = `turn-${randomUUID()}`;
    const steeringInbox = this._createSteeringInbox(turnId);
    const trackedTurn = createDeferred<TurnResult>();
    let started = false;
    let cleanedUp = false;

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

    const resumeEnvelope: InboundEnvelope = {
      name: "humanApproval.resume",
      content: [],
      properties: {},
      conversationId,
      source: {
        connector: "humanApproval",
        connectionName: "humanApproval",
        receivedAt: new Date().toISOString(),
      },
      metadata: {
        __createdBy: "core",
        __humanApprovalContinuation: true,
      },
    };

    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      steeringInbox.close();
      this._inFlightTurns.delete(turnId);
      if (this._activeTurnByConversation.get(conversationKey)?.turnId === turnId) {
        this._activeTurnByConversation.delete(conversationKey);
      }
    };

    return {
      turnId,
      promise: trackedTurn.promise,
      start: async () => {
        if (!started) {
          started = true;
          try {
            const turnPromise = executeTurn(agentName, resumeEnvelope, { conversationId, turnId }, {
              llmClient: agentDeps.llmClient,
              toolRegistry: agentDeps.toolRegistry,
              middlewareRegistry: agentDeps.middlewareRegistry,
              eventBus: agentDeps.eventBus,
              conversationState,
              maxSteps: agentDeps.maxSteps,
              abortController,
              steering: steeringInbox,
              humanApprovalStore: this._humanApprovalStore,
              skipInputAppend: true,
              consumeInboundItem: async ({ item, turnId: consumedTurnId, commitRef }) => {
                if (!this._durableInboundStore) {
                  return;
                }
                await this._durableInboundStore.markConsumed({
                  id: item.id,
                  turnId: consumedTurnId,
                  commitRef,
                });
                this._runtimeEvents.emit("inbound.consumed", {
                  type: "inbound.consumed",
                  inboundItemId: item.id,
                  turnId: consumedTurnId,
                  commitRef,
                });
              },
              blockInboundItem: async ({ item, blocker }) => {
                if (!this._durableInboundStore) {
                  return;
                }
                const blocked = await this._durableInboundStore.markBlocked({
                  id: item.id,
                  blockedBy: blocker,
                });
                this._runtimeEvents.emit("inbound.blocked", {
                  type: "inbound.blocked",
                  inboundItemId: blocked.id,
                  blockedBy: blocker,
                });
              },
            });
            void turnPromise.then(trackedTurn.resolve, trackedTurn.reject);
          } catch (err) {
            trackedTurn.reject(err);
          }
        }

        try {
          return await trackedTurn.promise;
        } finally {
          cleanup();
        }
      },
      discard: () => {
        if (!started) {
          trackedTurn.resolve({
            turnId,
            agentName,
            conversationId,
            status: "aborted",
            steps: [],
          });
        }
        cleanup();
      },
    };
  }

  private _scheduleDurableInboundItemInBackground(item: DurableInboundItem): void {
    void this._scheduleDurableInboundItem(item).catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this._runtimeEvents.emit("inbound.failed", {
        type: "inbound.failed",
        inboundItemId: item.id,
        attempt: item.attempt,
        retryable: true,
        reason: error.message,
      });
    });
  }

  private async _deadLetterInboundItem(input: DeadLetterInboundInput): Promise<DurableInboundItem> {
    if (!this._durableInboundStore) {
      throw new HarnessError("Durable inbound store is not configured.");
    }

    const item = await this._durableInboundStore.deadLetterInboundItem(input);
    this._runtimeEvents.emit("inbound.deadLettered", {
      type: "inbound.deadLettered",
      inboundItemId: item.id,
      reason: item.failure?.reason ?? input.reason,
    });
    return item;
  }

  async deliverInboundToActiveTurn(
    agentName: string,
    conversationId: string,
    envelope: InboundEnvelope,
    item: DurableInboundItem,
  ): Promise<{ turnId: string; item: DurableInboundItem; promise: Promise<TurnResult> } | null> {
    if (!this._durableInboundStore) {
      return null;
    }

    const conversationKey = this._conversationKey(agentName, conversationId);
    const activeTurn = this._activeTurnByConversation.get(conversationKey);
    if (!activeTurn) {
      return null;
    }

    const delivered = await this._durableInboundStore.markDelivered({
      id: item.id,
      turnId: activeTurn.turnId,
    });
    const commitRef = inboundUserMessageCommitRef(delivered.id);
    const enqueued = activeTurn.steeringInbox.enqueue({
      envelope,
      inboundItem: delivered,
      commitRef,
    });
    if (!enqueued) {
      await this._durableInboundStore.retryInboundItem({ id: delivered.id });
      return null;
    }

    this._runtimeEvents.emit("inbound.delivered", {
      type: "inbound.delivered",
      inboundItemId: delivered.id,
      turnId: activeTurn.turnId,
      sequence: delivered.sequence,
    });
    const deliveredPromise = activeTurn.promise.then((result) => {
      this._turnResultByInboundItem.set(delivered.id, result);
      return result;
    });
    void deliveredPromise.catch(() => undefined);
    return { turnId: activeTurn.turnId, item: delivered, promise: deliveredPromise };
  }

  private async _scheduleDurableInboundItem(item: DurableInboundItem): Promise<void> {
    if (!this._durableInboundStore) {
      return;
    }

    const blocker = await this._humanApprovalStore?.getConversationBlocker({
      agentName: item.agentName,
      conversationId: item.conversationId,
    });
    if (blocker) {
      const blocked = await this._durableInboundStore.markBlocked({
        id: item.id,
        blockedBy: blocker,
      });
      this._runtimeEvents.emit("inbound.blocked", {
        type: "inbound.blocked",
        inboundItemId: blocked.id,
        blockedBy: blocker,
      });
      return;
    }

    const delivered = await this.deliverInboundToActiveTurn(
      item.agentName,
      item.conversationId,
      item.envelope,
      item,
    );
    if (delivered) {
      return;
    }

    const turnId = `turn-${randomUUID()}`;
    this.dispatchTurn(item.agentName, item.envelope, { conversationId: item.conversationId, turnId }, {
      item,
      commitRef: inboundUserMessageCommitRef(item.id),
    })
      .then((result) => {
        this._turnResultByInboundItem.set(item.id, result);
      })
      .catch((err) => {
        this._runtimeEvents.emit("turn.error", {
          type: "turn.error",
          turnId,
          agentName: item.agentName,
          conversationId: item.conversationId,
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
  }

  // -----------------------------------------------------------------------
  // processTurn
  // -----------------------------------------------------------------------

  async processTurn(
    agentName: string,
    input: string | InboundEnvelope,
    options?: ProcessTurnOptions,
  ): Promise<TurnResult> {
    if (this._durableInboundStore) {
      const conversationId =
        options?.conversationId ??
        (typeof input !== "string" && input.conversationId ? input.conversationId : randomUUID());
      const envelope = typeof input === "string"
        ? {
            name: "text",
            content: [{ type: "text" as const, text: input }],
            properties: {},
            conversationId,
            source: {
              connector: "programmatic",
              connectionName: "programmatic",
              receivedAt: options?.receivedAt ?? new Date().toISOString(),
            },
            metadata: options?.metadata,
          }
        : { ...input, conversationId };
        const appended = await this._durableInboundStore.append({
        agentName,
        conversationId,
        envelope,
        source: {
          kind: "direct",
          receivedAt: options?.receivedAt ?? new Date().toISOString(),
          metadata: options?.metadata,
        },
        idempotencyKey:
          options?.idempotencyKey ??
          `direct:${agentName}:${conversationId}:${stableHash({
            receivedAt: envelope.source.receivedAt,
            content: envelope.content,
          })}`,
      });
      if (appended.duplicate) {
        this._runtimeEvents.emit("inbound.duplicate", {
          type: "inbound.duplicate",
          inboundItemId: appended.item.id,
          agentName,
          conversationId,
          idempotencyKey: appended.item.idempotencyKey,
          status: appended.item.status,
        });
        if (appended.item.turnId) {
          const active = this._inFlightTurns.get(appended.item.turnId);
          if (active) {
            return active.promise;
          }
        }
        return turnResultForDurableDuplicate(
          appended.item,
          agentName,
          conversationId,
          this._turnResultByInboundItem.get(appended.item.id),
        );
      }
      this._runtimeEvents.emit("inbound.appended", {
        type: "inbound.appended",
        inboundItemId: appended.item.id,
        agentName,
        conversationId,
        sequence: appended.item.sequence,
        idempotencyKey: appended.item.idempotencyKey,
      });
      const blocker = await this._humanApprovalStore?.getConversationBlocker({ agentName, conversationId });
      if (blocker) {
        const blocked = await this._durableInboundStore.markBlocked({
          id: appended.item.id,
          blockedBy: blocker,
        });
        this._runtimeEvents.emit("inbound.blocked", {
          type: "inbound.blocked",
          inboundItemId: blocked.id,
          blockedBy: blocker,
        });
        return {
          turnId: `turn-${randomUUID()}`,
          agentName,
          conversationId,
          status: "waitingForHuman",
          steps: [],
        };
      }
      const conversationKey = this._conversationKey(agentName, conversationId);
      const activeTurn = this._activeTurnByConversation.get(conversationKey);
      if (activeTurn) {
        const delivered = await this.deliverInboundToActiveTurn(agentName, conversationId, envelope, appended.item);
        if (delivered) {
          return delivered.promise;
        }
      }
      const result = await this._processTurnInternal(agentName, envelope, { ...options, conversationId }, {
        item: appended.item,
        commitRef: inboundUserMessageCommitRef(appended.item.id),
      });
      this._turnResultByInboundItem.set(appended.item.id, result);
      return result;
    }
    return this._processTurnInternal(agentName, input, options);
  }

  async dispatchTurn(
    agentName: string,
    input: InboundEnvelope,
    options: { conversationId: string; turnId: string },
    durable?: {
      item: DurableInboundItem;
      commitRef: string;
    },
  ): Promise<TurnResult> {
    return this._processTurnInternal(agentName, input, options, durable);
  }

  steerTurn(
    agentName: string,
    input: InboundEnvelope | TurnSteeredInput,
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

  getActiveTurn(agentName: string, conversationId: string): { turnId: string } | null {
    const conversationKey = this._conversationKey(agentName, conversationId);
    const activeTurn = this._activeTurnByConversation.get(conversationKey);
    return activeTurn ? { turnId: activeTurn.turnId } : null;
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
      listInboundItems: this._durableInboundStore
        ? async (filter = {}) => this._durableInboundStore!.listInboundItems(filter)
        : undefined,
      retryInboundItem: this._durableInboundStore
        ? async (input: string | RetryInboundInput) => {
            const retryInput: RetryInboundInput = typeof input === "string" ? { id: input } : input;
            if (typeof retryInput.id !== "string" || retryInput.id.length === 0) {
              throw new HarnessError("retryInboundItem input requires `id`.");
            }
            const item = await this._durableInboundStore!.retryInboundItem(retryInput);
            this._scheduleDurableInboundItemInBackground(item);
            return item;
          }
        : undefined,
      releaseInboundItem: this._durableInboundStore?.releaseInboundItem
        ? async (input: string | ReleaseInboundItemInput) => {
            const item = await this._durableInboundStore!.releaseInboundItem!(
              typeof input === "string" ? { id: input } : input,
            );
            this._scheduleDurableInboundItemInBackground(item);
            return item;
          }
        : undefined,
      deadLetterInboundItem: this._durableInboundStore
        ? async (input: string | DeadLetterInboundInput) => this._deadLetterInboundItem(
            typeof input === "string" ? { id: input, reason: "dead-lettered by operator" } : input,
          )
        : undefined,
      listHumanTasks: this._humanApprovalStore
        ? async (filter = {}) => {
            const tasks = await this._humanApprovalStore!.listTasks(filter);
            return tasks.map((task) => toPublicHumanTaskView(task));
          }
        : undefined,
      submitHumanResult: this._humanApprovalStore
        ? async (input: SubmitHumanResultInput) => {
            const result = await this._humanApprovalStore!.submitResult(input);
            if (result.status !== "accepted" && result.status !== "duplicate") {
              const reason = "reason" in result ? result.reason : undefined;
              throw new HarnessError(reason ?? "Human result submission was rejected.");
            }
            const duplicate = result.status === "duplicate" || result.duplicate === true;
            if (!duplicate) {
              const task = result.task;
              const gate = result.approval;
              const status = task.status;
              if (status === "rejected") {
                this._runtimeEvents.emit("humanTask.rejected", {
                  type: "humanTask.rejected",
                  humanTaskId: task.id,
                  humanApprovalId: task.humanApprovalId,
                  idempotencyKey: input.idempotencyKey,
                });
              } else {
                this._runtimeEvents.emit("humanTask.resolved", {
                  type: "humanTask.resolved",
                  humanTaskId: task.id,
                  humanApprovalId: task.humanApprovalId,
                  idempotencyKey: input.idempotencyKey,
                });
              }
              if (result.approvalReady || gate.status === "ready") {
                this._runtimeEvents.emit("humanApproval.ready", {
                  type: "humanApproval.ready",
                  humanApprovalId: gate.id,
                  taskIds: gate.taskIds,
                });
              }
            }
            const publicApproval = await toPublicHumanApprovalRecord(result.approval, this._humanApprovalStore);
            return {
              status: result.status,
              accepted: true,
              duplicate,
              task: toPublicHumanTaskView(result.task),
              approval: publicApproval,
            };
          }
        : undefined,
      resumeHumanApproval: this._humanApprovalStore
        ? async (input: string | ResumeHumanApprovalInput) => {
            const resumeInput: ResumeHumanApprovalInput | undefined =
              typeof input === "string"
                ? { id: input }
                : input && typeof input === "object"
                  ? input
                  : undefined;
            if (!resumeInput || typeof resumeInput.id !== "string" || resumeInput.id.length === 0) {
              throw new HarnessError(
                "resumeHumanApproval input requires `id` (was previously a positional id parameter). " +
                  "Update the call site to pass a string or `{ id }`.",
              );
            }
            const id = resumeInput.id;
            const leaseOwner = resumeInput.leaseOwner ?? "runtime";
            const leaseTtlMs = resumeInput.leaseTtlMs ?? this._humanApprovalResumeLeaseMs;
            const leaseExpiresAt = new Date(
              Date.parse(resumeInput.now ?? new Date().toISOString()) + leaseTtlMs,
            ).toISOString();
            const gate = await this._humanApprovalStore!.acquireApprovalForResume({
              id,
              leaseOwner,
              leaseExpiresAt,
              leaseTtlMs,
              now: resumeInput.now,
            });
            if (!gate) {
              const existing = await this._humanApprovalStore!.getApproval(id);
              if (!existing) {
                throw new HarnessError(`Unknown human approval: "${id}"`);
              }
              return {
                id,
                status: humanApprovalResumeStatus(existing),
                approval: await toPublicHumanApprovalRecord(existing, this._humanApprovalStore),
              };
            }
            this._runtimeEvents.emit("humanApproval.resuming", {
              type: "humanApproval.resuming",
              humanApprovalId: id,
              leaseOwner,
              turnId: gate.toolCall.turnId,
            });
            let completedGate: HumanApprovalRecord | undefined;
            let continuationTurn: PreparedContinuationTurn | undefined;
            let resumeTurnId: string | undefined;
            let resumeSteeringInbox: SteeringInbox | undefined;
            let resumeTracked: ReturnType<typeof createDeferred<TurnResult>> | undefined;
            let resumeToolCall: typeof gate.toolCall | undefined;
            try {
              const toolCall = gate.toolCall;
              resumeToolCall = toolCall;
              const agentDeps = this._agents.get(toolCall.agentName);
              if (!agentDeps) {
                throw new ConfigError(`Unknown agent: "${toolCall.agentName}"`);
              }
              resumeTurnId = `${toolCall.turnId}:humanApproval:${id}:resume`;
              const resumeAbortController = new AbortController();
              resumeSteeringInbox = this._createSteeringInbox(resumeTurnId);
              resumeTracked = createDeferred<TurnResult>();
              const resumeInFlight: InFlightTurn = {
                turnId: resumeTurnId,
                agentName: toolCall.agentName,
                conversationId: toolCall.conversationId,
                abortController: resumeAbortController,
                promise: resumeTracked.promise,
                steeringInbox: resumeSteeringInbox,
              };
              const throwIfResumeAborted = (): void => {
                if (resumeAbortController.signal.aborted) {
                  const reason = resumeAbortController.signal.reason ?? "Human approval resume aborted.";
                  throw new Error(String(reason));
                }
              };
              this._inFlightTurns.set(resumeTurnId, resumeInFlight);

              const conversationKey = this._conversationKey(toolCall.agentName, toolCall.conversationId);
              let conversationState = this._conversations.get(conversationKey);
              if (!conversationState) {
                conversationState = createConversationState();
                this._conversations.set(conversationKey, conversationState);
              }

              const taskIds: string[] = gate.taskIds ?? [];
              const tasks = await Promise.all(
                taskIds.map((taskId) => this._humanApprovalStore!.getTask(taskId)),
              );
              const rejectedTask = tasks.find(
                (task): task is HumanTaskRecord =>
                  Boolean(task) && (task!.status === "rejected" || task!.result?.type === "rejection"),
              );
              const tool = agentDeps.toolRegistry.get(toolCall.toolName);
              let toolResult: import("@goondan/openharness-types").ToolResult;

              if (rejectedTask) {
                const rejectionReason =
                  rejectedTask.result?.type === "rejection" ? rejectedTask.result.reason : undefined;
                toolResult = {
                  type: "error",
                  error: rejectionReason ?? "Human rejected tool call",
                };
              } else {
                if (!tool) {
                  toolResult = { type: "error", error: `Tool "${toolCall.toolName}" not found` };
                } else {
                  const approvalResult = tasks
                    .map((task) => task?.result)
                    .find((result): result is Extract<HumanResult, { type: "approval" }> => result?.type === "approval");
                  const formResult = tasks
                    .map((task) => task?.result)
                    .find((result): result is Extract<HumanResult, { type: "form" }> => result?.type === "form");
                  const argsPatch = approvalResult?.argsPatch;
                  const formData = formResult?.data;
                  const finalArgs = {
                    ...toolCall.toolArgs,
                    ...(argsPatch ?? {}),
                    ...(formData ?? {}),
                  };
                  const validation = agentDeps.toolRegistry.validate(toolCall.toolName, finalArgs);
                  if (!validation.valid) {
                    toolResult = { type: "error", error: `Invalid arguments: ${validation.errors}` };
                  } else {
                    throwIfResumeAborted();
                    await this._humanApprovalStore!.markApprovalHandlerStarted({
                      id,
                      leaseOwner,
                    });
                    throwIfResumeAborted();
                    toolResult = await executeToolCall(toolCall.toolCallId, {
                      turnId: toolCall.turnId,
                      agentName: toolCall.agentName,
                      conversationId: toolCall.conversationId,
                      conversation: conversationState,
                      input: {
                        name: "humanApproval.resume",
                        content: [],
                        properties: {
                          humanApprovalId: id,
                          toolCallId: toolCall.toolCallId,
                        },
                        conversationId: toolCall.conversationId,
                        source: {
                          connector: "humanApproval",
                          connectionName: "humanApproval",
                          receivedAt: new Date().toISOString(),
                        },
                      },
                      llm: agentDeps.llmClient,
                      stepNumber: toolCall.stepNumber,
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      toolArgs: finalArgs,
                      abortSignal: resumeAbortController.signal,
                    }, {
                      toolRegistry: agentDeps.toolRegistry,
                      middlewareRegistry: agentDeps.middlewareRegistry,
                      eventBus: agentDeps.eventBus,
                      humanApprovalStore: this._humanApprovalStore,
                      skipHumanApproval: true,
                    });
                    throwIfResumeAborted();
                  }
                }
              }
              throwIfResumeAborted();

              const blockedInboundItemIds: string[] = [];
              const blockerSelector = { type: gate.blocker.type, id: gate.blocker.id };
              const drainBlockedInboundItemsForApproval = async (): Promise<void> => {
                const blockedItems = this._durableInboundStore
                  ? await this._durableInboundStore.listInboundItems({
                      agentName: toolCall.agentName,
                      conversationId: toolCall.conversationId,
                      status: ["blocked"],
                      blockedBy: blockerSelector,
                    })
                  : [];

                for (const item of blockedItems.sort((a, b) => a.sequence - b.sequence)) {
                  const commitRef = inboundUserMessageCommitRef(item.id);
                  const exists = conversationState.messages.some(
                    (message) => message.metadata?.__inboundCommitRef === commitRef,
                  );
                  if (!exists) {
                    const text = item.envelope.content
                      .filter((part): part is { type: "text"; text: string } => part.type === "text")
                      .map((part) => part.text)
                      .join("\n");
                    conversationState.emit({
                      type: "appendMessage",
                      message: {
                        id: `msg-${item.id}`,
                        data: { role: "user", content: text },
                        metadata: {
                          __createdBy: "core",
                          __inboundItemId: item.id,
                          __inboundCommitRef: commitRef,
                          __blockedBy: gate.blocker,
                        },
                      },
                    });
                  }
                  await this._durableInboundStore?.markConsumed({
                    id: item.id,
                    turnId: toolCall.turnId,
                    commitRef,
                  });
                  if (!blockedInboundItemIds.includes(item.id)) {
                    blockedInboundItemIds.push(item.id);
                  }
                  this._runtimeEvents.emit("inbound.consumed", {
                    type: "inbound.consumed",
                    inboundItemId: item.id,
                    turnId: toolCall.turnId,
                    commitRef,
                  });
                }
              };
              conversationState._turnActive = true;
              try {
                conversationState.emit({
                  type: "appendMessage",
                  message: {
                    id: `tool-result-${toolCall.toolCallId}`,
                    data: {
                      role: "tool",
                      content: [
                        {
                          type: "tool-result",
                          toolCallId: toolCall.toolCallId,
                          toolName: toolCall.toolName,
                          output: toolResult.type === "text"
                            ? { type: "text", value: toolResult.text }
                            : toolResult.type === "json"
                              ? { type: "json", value: toolResult.data }
                              : { type: "error-text", value: toolResult.error },
                        },
                      ],
                    },
                    metadata: {
                      __createdBy: "core",
                      __humanApprovalId: id,
                    },
                  },
                });

                await drainBlockedInboundItemsForApproval();
                continuationTurn = this._prepareContinuationTurn(toolCall.agentName, toolCall.conversationId);
                completedGate = await this._humanApprovalStore!.markApprovalCompleted({
                  id,
                  leaseOwner,
                  turnId: toolCall.turnId,
                  blockedInboundItemIds,
                });
                await drainBlockedInboundItemsForApproval();
              } finally {
                conversationState._turnActive = false;
              }
              this._runtimeEvents.emit("humanApproval.completed", {
                type: "humanApproval.completed",
                humanApprovalId: id,
                turnId: toolCall.turnId,
                blockedInboundItemIds: completedGate.blockedInboundItemIds ?? blockedInboundItemIds,
              });
              const continuation = await continuationTurn!.start();
              return {
                id,
                status: "completed",
                approval: await toPublicHumanApprovalRecord(completedGate, this._humanApprovalStore),
                continuation,
              };
            } catch (err) {
              const error = err instanceof Error ? err : new Error(String(err));
              if (continuationTurn) {
                continuationTurn.discard();
              }
              if (completedGate) {
                const completedToolCall = completedGate.toolCall;
                return {
                  id,
                  status: "completed",
                  approval: await toPublicHumanApprovalRecord(completedGate, this._humanApprovalStore),
                  continuation: {
                    turnId: `turn-${randomUUID()}`,
                    agentName: completedToolCall.agentName,
                    conversationId: completedToolCall.conversationId,
                    status: "error",
                    steps: [],
                    error,
                  },
                };
              }
              try {
                const failed = await this._humanApprovalStore!.markApprovalFailed({
                  id,
                  reason: error.message,
                  retryable: true,
                  leaseOwner,
                });
                this._runtimeEvents.emit("humanApproval.failed", {
                  type: "humanApproval.failed",
                  humanApprovalId: id,
                  retryable: true,
                  reason: error.message,
                });
                return {
                  id,
                  status: "failed",
                  approval: await toPublicHumanApprovalRecord(failed, this._humanApprovalStore),
                };
              } catch (markError) {
                const existing = await this._humanApprovalStore!.getApproval(id);
                const leaseMoved = existing &&
                  (existing.status !== "resuming" || existing.lease?.owner !== leaseOwner);
                if (!leaseMoved) {
                  throw markError;
                }
                return {
                  id,
                  status: humanApprovalResumeStatus(existing),
                  approval: await toPublicHumanApprovalRecord(existing, this._humanApprovalStore),
                };
              }
            } finally {
              if (resumeTurnId && resumeSteeringInbox && resumeTracked && resumeToolCall) {
                resumeSteeringInbox.close();
                this._inFlightTurns.delete(resumeTurnId);
                resumeTracked.resolve({
                  turnId: resumeTurnId,
                  agentName: resumeToolCall.agentName,
                  conversationId: resumeToolCall.conversationId,
                  status: "completed",
                  steps: [],
                });
              }
            }
          }
        : undefined,
      cancelHumanApproval: this._humanApprovalStore
        ? async (input: string | CancelHumanApprovalInput) => {
            const cancelInput: CancelHumanApprovalInput = typeof input === "string"
              ? { id: input }
              : input;
            if (typeof cancelInput.id !== "string" || cancelInput.id.length === 0) {
              throw new HarnessError(
                "cancelHumanApproval input requires `id` (was previously named humanApprovalId). " +
                  "Update the call site to pass `id`.",
              );
            }
            const existingApproval = await this._humanApprovalStore!.getApproval(cancelInput.id);
            const gate = await this._humanApprovalStore!.cancelApproval(cancelInput);
            const isTerminal = gate.status === "canceled" || gate.status === "expired";
            const transitioned = existingApproval
              ? existingApproval.status !== gate.status && isTerminal
              : isTerminal;
            if (transitioned) {
              this._runtimeEvents.emit("humanApproval.canceled", {
                type: "humanApproval.canceled",
                humanApprovalId: gate.id,
                reason: cancelInput.reason,
              });
            }
            if (transitioned && this._durableInboundStore) {
              const blockerSelector = { type: gate.blocker.type, id: gate.blocker.id };
              if (gate.status === "expired") {
                const blockedItems = await this._durableInboundStore.listInboundItems({
                  agentName: gate.toolCall.agentName,
                  conversationId: gate.toolCall.conversationId,
                  status: ["blocked"],
                  blockedBy: blockerSelector,
                });
                await Promise.all(blockedItems.map((item) => this._deadLetterInboundItem({
                  id: item.id,
                  reason: cancelInput.reason ?? `Human approval "${gate.id}" expired.`,
                })));
              } else {
                let releasedItems: DurableInboundItem[] = [];
                if (this._durableInboundStore.releaseBlockedInboundItems) {
                  releasedItems = await this._durableInboundStore.releaseBlockedInboundItems({
                    agentName: gate.toolCall.agentName,
                    conversationId: gate.toolCall.conversationId,
                    blockedBy: blockerSelector,
                  });
                } else {
                  const blockedItems = await this._durableInboundStore.listInboundItems({
                    agentName: gate.toolCall.agentName,
                    conversationId: gate.toolCall.conversationId,
                    status: ["blocked"],
                    blockedBy: blockerSelector,
                  });
                  releasedItems = await Promise.all(blockedItems.map((item) =>
                    this._durableInboundStore!.releaseInboundItem
                      ? this._durableInboundStore!.releaseInboundItem({ id: item.id })
                      : this._durableInboundStore!.retryInboundItem({ id: item.id }),
                  ));
                }
                await Promise.all(releasedItems.map((item) => this._scheduleDurableInboundItem(item)));
              }
            }
            return await toPublicHumanApprovalRecord(gate, this._humanApprovalStore);
          }
        : undefined,
    };
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

    // Wait for turns to settle (with timeout)
    if (promises.length > 0) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS));
      await Promise.race([Promise.allSettled(promises), timeout]);
    }

    // Clean up
    this._inFlightTurns.clear();
    this._activeTurnByConversation.clear();
    this._conversations.clear();
  }
}

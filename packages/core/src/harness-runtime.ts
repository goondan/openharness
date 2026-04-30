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
  DurableInboundStore,
  DurableInboundItem,
  HumanGateStore,
} from "@goondan/openharness-types";
import type { ConversationStateImpl } from "./conversation-state.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { MiddlewareRegistry } from "./middleware-chain.js";
import type { EventBus } from "./event-bus.js";
import type { IngressPipeline } from "./ingress/pipeline.js";
import { createConversationState } from "./conversation-state.js";
import { executeTurn, type TurnSteeredInput, type TurnSteeringController } from "./execution/turn.js";
import { HarnessError, ConfigError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { inboundUserMessageCommitRef } from "./inbound/scheduler.js";

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
  private readonly _durableInboundStore?: DurableInboundStore;
  private readonly _humanGateStore?: HumanGateStore;
  private _closed = false;

  constructor(
    agents: Map<string, AgentDeps>,
    ingressPipeline: IngressPipeline,
    runtimeEvents: EventBus,
    durableInboundStore?: DurableInboundStore,
    humanGateStore?: HumanGateStore,
  ) {
    this._agents = agents;
    this._ingressPipeline = ingressPipeline;
    this._runtimeEvents = runtimeEvents;
    this._durableInboundStore = durableInboundStore;
    this._humanGateStore = humanGateStore;
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
      } as any);
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
      item: any;
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
      const turnPromise = executeTurn(agentName, input, { ...options, conversationId, turnId }, {
        llmClient: agentDeps.llmClient,
        toolRegistry: agentDeps.toolRegistry,
        middlewareRegistry: agentDeps.middlewareRegistry,
        eventBus: agentDeps.eventBus,
        conversationState,
        maxSteps: agentDeps.maxSteps,
        abortController,
        steering: steeringInbox,
        humanGateStore: this._humanGateStore as any,
        inboundItem: durable?.item,
        inboundCommitRef: durable?.commitRef,
        consumeInboundItem: async ({ item, turnId: consumedTurnId, commitRef }) => {
          if (!this._durableInboundStore) {
            return;
          }
          await this._durableInboundStore.markConsumed({
            id: item.id,
            turnId: consumedTurnId,
            commitRef,
          } as any);
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
          } as any);
          this._runtimeEvents.emit("inbound.blocked", {
            type: "inbound.blocked",
            inboundItemId: blocked.id,
            blockedBy: blocker,
          } as any);
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
        humanGateStore: this._humanGateStore as any,
        skipInputAppend: true,
        consumeInboundItem: async ({ item, turnId: consumedTurnId, commitRef }) => {
          if (!this._durableInboundStore) {
            return;
          }
          await this._durableInboundStore.markConsumed({
            id: item.id,
            turnId: consumedTurnId,
            commitRef,
          } as any);
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
          } as any);
          this._runtimeEvents.emit("inbound.blocked", {
            type: "inbound.blocked",
            inboundItemId: blocked.id,
            blockedBy: blocker,
          } as any);
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
    } as any);
    const commitRef = inboundUserMessageCommitRef(delivered.id);
    const enqueued = activeTurn.steeringInbox.enqueue({
      envelope,
      inboundItem: delivered as any,
      commitRef,
    });
    if (!enqueued) {
      await this._durableInboundStore.retryInboundItem(delivered.id);
      return null;
    }

    this._runtimeEvents.emit("inbound.delivered", {
      type: "inbound.delivered",
      inboundItemId: delivered.id,
      turnId: activeTurn.turnId,
      sequence: delivered.sequence,
    });
    return { turnId: activeTurn.turnId, item: delivered, promise: activeTurn.promise };
  }

  private async _scheduleDurableInboundItem(item: DurableInboundItem): Promise<void> {
    if (!this._durableInboundStore) {
      return;
    }

    const blocker = await (this._humanGateStore as any)?.getConversationBlocker?.({
      agentName: item.agentName,
      conversationId: item.conversationId,
    });
    if (blocker) {
      const blocked = await this._durableInboundStore.markBlocked({
        id: item.id,
        blockedBy: blocker,
      } as any);
      this._runtimeEvents.emit("inbound.blocked", {
        type: "inbound.blocked",
        inboundItemId: blocked.id,
        blockedBy: blocker,
      } as any);
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
    } as any)
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
          `direct:${agentName}:${conversationId}:${JSON.stringify(envelope.content)}:${envelope.source.receivedAt}`,
      });
      this._runtimeEvents.emit(appended.duplicate ? "inbound.duplicate" : "inbound.appended", {
        type: appended.duplicate ? "inbound.duplicate" : "inbound.appended",
        inboundItemId: appended.item.id,
        agentName,
        conversationId,
        sequence: appended.item.sequence,
        idempotencyKey: appended.item.idempotencyKey,
          status: appended.item.status,
      } as any);
      if (appended.duplicate) {
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
      const blocker = await (this._humanGateStore as any)?.getConversationBlocker?.({ agentName, conversationId });
      if (blocker) {
        const blocked = await this._durableInboundStore.markBlocked({
          id: appended.item.id,
          blockedBy: blocker,
        } as any);
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
        const delivered = await this.deliverInboundToActiveTurn(agentName, conversationId, envelope, appended.item as any);
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
      item: any;
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
        ? async (id: string) => {
            const item = await this._durableInboundStore!.retryInboundItem(id);
            void this._scheduleDurableInboundItem(item as any);
            return item;
          }
        : undefined,
      releaseInboundItem: this._durableInboundStore
        ? async (input: any) => {
            let item: DurableInboundItem;
            if (this._durableInboundStore!.releaseInboundItem) {
              item = await this._durableInboundStore!.releaseInboundItem(
                typeof input === "string" ? { id: input } : input,
              );
            } else {
              item = await this._durableInboundStore!.retryInboundItem(typeof input === "string" ? input : input.id);
            }
            void this._scheduleDurableInboundItem(item as any);
            return item;
          }
        : undefined,
      deadLetterInboundItem: this._durableInboundStore
        ? async (input: any) => this._durableInboundStore!.deadLetterInboundItem(
            typeof input === "string" ? { id: input, reason: "dead-lettered by operator" } : input,
          )
        : undefined,
      listHumanTasks: this._humanGateStore
        ? async (filter = {}) => this._humanGateStore!.listTasks(filter as any) as any
        : undefined,
      submitHumanResult: this._humanGateStore
        ? async (input: any) => {
            const result = await this._humanGateStore!.submitResult(input);
            const status = (result as any).task?.status;
            if ((result as any).status === "accepted" || (result as any).accepted) {
              const task = (result as any).task;
              const gate = (result as any).gate;
              this._runtimeEvents.emit(status === "rejected" ? "humanTask.rejected" : "humanTask.resolved", {
                type: status === "rejected" ? "humanTask.rejected" : "humanTask.resolved",
                humanTaskId: task.id,
                humanGateId: task.humanGateId,
                idempotencyKey: input.idempotencyKey,
              } as any);
              if ((result as any).gateReady || gate?.status === "ready") {
                this._runtimeEvents.emit("humanGate.ready", {
                  type: "humanGate.ready",
                  humanGateId: gate.id,
                  taskIds: gate.taskIds,
                } as any);
              }
            }
            return result as any;
          }
        : undefined,
      resumeHumanGate: this._humanGateStore
        ? async (id: string) => {
            const gate = await this._humanGateStore!.acquireGateForResume({
              humanGateId: id,
              leaseOwner: "runtime",
              leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
            } as any);
            if (!gate) {
              const existing = await (this._humanGateStore as any).getGate?.(id);
              if (!existing) {
                throw new HarnessError(`Unknown human gate: "${id}"`);
              }
              const existingStatus = (existing as any).status;
              return {
                humanGateId: id,
                status: existingStatus === "completed"
                  ? "completed"
                  : ["failed", "canceled", "expired"].includes(existingStatus)
                    ? "failed"
                    : "blocked",
                gate: existing,
              } as any;
            }
            let completedGate: any;
            try {
              const toolCall = (gate as any).toolCall;
              const agentDeps = this._agents.get(toolCall.agentName);
              if (!agentDeps) {
                throw new ConfigError(`Unknown agent: "${toolCall.agentName}"`);
              }
              const conversationKey = this._conversationKey(toolCall.agentName, toolCall.conversationId);
              let conversationState = this._conversations.get(conversationKey);
              if (!conversationState) {
                conversationState = createConversationState();
                this._conversations.set(conversationKey, conversationState);
              }

              const taskIds: string[] = (gate as any).taskIds ?? [];
              const tasks = await Promise.all(
                taskIds.map((taskId) => (this._humanGateStore as any).getTask?.(taskId)),
              );
              const rejectedTask = tasks.find((task) => task?.status === "rejected" || task?.result?.type === "rejection");
              const tool = agentDeps.toolRegistry.get(toolCall.toolName);
              let toolResult: any;

              if (rejectedTask) {
                toolResult = {
                  type: "error",
                  error: rejectedTask.result?.reason ?? "Human rejected tool call",
                };
              } else {
                if (!tool) {
                  toolResult = { type: "error", error: `Tool "${toolCall.toolName}" not found` };
                } else {
                  const argsPatch = tasks.find((task) => task?.result?.type === "approval")?.result?.argsPatch;
                  const formData = tasks.find((task) => task?.result?.type === "form")?.result?.data;
                  const finalArgs = {
                    ...toolCall.toolArgs,
                    ...(argsPatch ?? {}),
                    ...(formData ?? {}),
                  };
                  const validation = agentDeps.toolRegistry.validate(toolCall.toolName, finalArgs);
                  if (!validation.valid) {
                    toolResult = { type: "error", error: `Invalid arguments: ${validation.errors}` };
                  } else {
                    await this._humanGateStore!.markGateHandlerStarted({
                      humanGateId: id,
                      leaseOwner: "runtime",
                    } as any);
                    this._runtimeEvents.emit("tool.start", {
                      type: "tool.start",
                      turnId: toolCall.turnId,
                      agentName: toolCall.agentName,
                      conversationId: toolCall.conversationId,
                      stepNumber: toolCall.stepNumber,
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      args: finalArgs,
                    });
                    toolResult = await tool.handler(finalArgs, {
                      agentName: toolCall.agentName,
                      conversationId: toolCall.conversationId,
                      abortSignal: new AbortController().signal,
                    });
                    this._runtimeEvents.emit("tool.done", {
                      type: "tool.done",
                      turnId: toolCall.turnId,
                      agentName: toolCall.agentName,
                      conversationId: toolCall.conversationId,
                      stepNumber: toolCall.stepNumber,
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      args: finalArgs,
                      result: toolResult,
                    });
                  }
                }
              }

              const blockedInboundItemIds: string[] = [];
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
                      __humanGateId: id,
                    },
                  },
                });

                const blockedItems = this._durableInboundStore
                  ? await this._durableInboundStore.listInboundItems({
                      agentName: toolCall.agentName,
                      conversationId: toolCall.conversationId,
                      status: ["blocked"],
                      statuses: ["blocked"],
                      blockedBy: (gate as any).blocker,
                    } as any)
                  : [];

                for (const item of blockedItems.sort((a: any, b: any) => a.sequence - b.sequence)) {
                  const commitRef = inboundUserMessageCommitRef(item.id);
                  const exists = conversationState.messages.some(
                    (message) => message.metadata?.__inboundCommitRef === commitRef,
                  );
                  if (!exists) {
                    const text = item.envelope.content
                      .filter((part: any) => part.type === "text")
                      .map((part: any) => part.text)
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
                          __blockedBy: (gate as any).blocker,
                        },
                      },
                    });
                  }
                  await this._durableInboundStore?.markConsumed({
                    id: item.id,
                    turnId: toolCall.turnId,
                    commitRef,
                  } as any);
                  blockedInboundItemIds.push(item.id);
                  this._runtimeEvents.emit("inbound.consumed", {
                    type: "inbound.consumed",
                    inboundItemId: item.id,
                    turnId: toolCall.turnId,
                    commitRef,
                  });
                }

                completedGate = await this._humanGateStore!.markGateCompleted({
                  humanGateId: id,
                  turnId: toolCall.turnId,
                  blockedInboundItemIds,
                } as any);
              } finally {
                conversationState._turnActive = false;
              }
              this._runtimeEvents.emit("humanGate.completed", {
                type: "humanGate.completed",
                humanGateId: id,
                turnId: toolCall.turnId,
                blockedInboundItemIds: (completedGate as any).blockedInboundItemIds ?? blockedInboundItemIds,
              } as any);
              const continuation = await this._continueTurnInternal(toolCall.agentName, toolCall.conversationId);
              return { humanGateId: id, status: "completed", gate: completedGate, continuation } as any;
            } catch (err) {
              const error = err instanceof Error ? err : new Error(String(err));
              if (completedGate) {
                const toolCall = (completedGate as any).toolCall;
                return {
                  humanGateId: id,
                  status: "completed",
                  gate: completedGate,
                  continuation: {
                    turnId: `turn-${randomUUID()}`,
                    agentName: toolCall.agentName,
                    conversationId: toolCall.conversationId,
                    status: "error",
                    steps: [],
                    error,
                  },
                } as any;
              }
              const failed = await this._humanGateStore!.markGateFailed({
                humanGateId: id,
                reason: error.message,
                retryable: false,
              } as any);
              this._runtimeEvents.emit("humanGate.failed", {
                type: "humanGate.failed",
                humanGateId: id,
                retryable: false,
                reason: error.message,
              } as any);
              return { humanGateId: id, status: "failed", gate: failed } as any;
            }
          }
        : undefined,
      cancelHumanGate: this._humanGateStore
        ? async (input: any) => {
            const cancelInput = typeof input === "string" ? { humanGateId: input } : input;
            const gate = await this._humanGateStore!.cancelGate(cancelInput) as any;
            if (this._durableInboundStore) {
              if (gate.status === "expired") {
                const blockedItems = await this._durableInboundStore.listInboundItems({
                  agentName: gate.toolCall.agentName,
                  conversationId: gate.toolCall.conversationId,
                  status: ["blocked"],
                  statuses: ["blocked"],
                  blockedBy: gate.blocker,
                } as any);
                await Promise.all(blockedItems.map((item: any) => this._durableInboundStore!.deadLetterInboundItem({
                  id: item.id,
                  reason: cancelInput.reason ?? `Human gate "${gate.id}" expired.`,
                })));
              } else {
                await (this._durableInboundStore as any).releaseBlockedInboundItems?.({
                  agentName: gate.toolCall.agentName,
                  conversationId: gate.toolCall.conversationId,
                  blockedBy: gate.blocker,
                });
              }
            }
            return gate;
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

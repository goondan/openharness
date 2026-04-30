import type {
  ConversationBlockerRef,
  DurableInboundItem,
  DurableInboundStore,
  FailInboundInput,
  InboundItemFilter,
  InboundAcceptedHandle,
  InboundScheduleDecision,
} from "./types.js";

export interface DurableInboundSchedulerOptions {
  store: DurableInboundStore & {
    markFailed?: (input: FailInboundInput) => Promise<DurableInboundItem>;
  };
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: () => string;
  getConversationBlocker?: (input: InboundConversationRef) => Promise<ConversationBlockerRef | null> | ConversationBlockerRef | null;
  getActiveTurn?: (input: InboundConversationRef) => Promise<ActiveInboundTurn | null> | ActiveInboundTurn | null;
  startTurn?: (input: StartInboundTurnInput) => Promise<StartedInboundTurn> | StartedInboundTurn;
  notifyActiveTurn?: (input: NotifyActiveInboundTurnInput) => Promise<void> | void;
}

export interface InboundConversationRef {
  agentName: string;
  conversationId: string;
}

export interface ActiveInboundTurn {
  turnId: string;
  steerable?: boolean;
}

export interface StartInboundTurnInput {
  item: DurableInboundItem;
  commitRef: string;
}

export interface StartedInboundTurn {
  turnId: string;
}

export interface NotifyActiveInboundTurnInput {
  item: DurableInboundItem;
  turnId: string;
  commitRef: string;
}

export class DurableInboundScheduler {
  private readonly _options: DurableInboundSchedulerOptions;

  constructor(options: DurableInboundSchedulerOptions) {
    this._options = options;
  }

  async scheduleConversation(input: InboundConversationRef): Promise<InboundScheduleDecision> {
    const now = this._options.now?.() ?? new Date().toISOString();
    const leased = await this._options.store.acquireNext({
      ...input,
      leaseOwner: this._options.leaseOwner,
      leaseTtlMs: this._options.leaseTtlMs,
      now,
    });

    if (!leased) {
      return { disposition: "noop", reason: "empty" };
    }

    const blocker = await this._options.getConversationBlocker?.(input);
    if (blocker) {
      const blocked = await this._options.store.markBlocked({
        id: leased.id,
        blockedBy: blocker,
        leaseOwner: this._options.leaseOwner,
        now,
      });
      return {
        disposition: "blocked",
        inboundItemId: blocked.id,
        blocker,
        item: blocked,
      };
    }

    const activeTurn = await this._options.getActiveTurn?.(input);
    if (activeTurn?.steerable !== false && activeTurn) {
      const delivered = await this._options.store.markDelivered({
        id: leased.id,
        turnId: activeTurn.turnId,
        leaseOwner: this._options.leaseOwner,
        now,
      });
      await this._options.notifyActiveTurn?.({
        item: delivered,
        turnId: activeTurn.turnId,
        commitRef: inboundUserMessageCommitRef(delivered.id),
      });
      return {
        disposition: "delivered",
        inboundItemId: delivered.id,
        turnId: activeTurn.turnId,
        item: delivered,
      };
    }

    if (!this._options.startTurn) {
      await this._options.store.markFailed?.({
        id: leased.id,
        reason: "No startTurn callback is configured for durable inbound scheduling.",
        retryable: true,
        leaseOwner: this._options.leaseOwner,
        now,
      });
      return { disposition: "noop", reason: "noStartTurn" };
    }

    const started = await this._options.startTurn({
      item: leased,
      commitRef: inboundUserMessageCommitRef(leased.id),
    });
    const delivered = await this._options.store.markDelivered({
      id: leased.id,
      turnId: started.turnId,
      leaseOwner: this._options.leaseOwner,
      now,
    });

    return {
      disposition: "started",
      inboundItemId: delivered.id,
      turnId: started.turnId,
      item: delivered,
    };
  }
}

export function createDurableInboundScheduler(
  options: DurableInboundSchedulerOptions,
): DurableInboundScheduler {
  return new DurableInboundScheduler(options);
}

export function inboundUserMessageCommitRef(inboundItemId: string): string {
  return `inbound:${inboundItemId}:user-message`;
}

export function inboundItemToAcceptedHandle(
  item: DurableInboundItem,
  disposition: InboundAcceptedHandle["disposition"],
): InboundAcceptedHandle {
  return {
    inboundItemId: item.id,
    agentName: item.agentName,
    conversationId: item.conversationId,
    sequence: item.sequence,
    disposition,
    turnId: item.turnId,
    blocker: item.blockedBy,
  };
}

export interface DrainBlockedInboundItemsInput {
  store: DurableInboundStore;
  agentName: string;
  conversationId: string;
  blockedBy?: InboundItemFilter["blockedBy"];
  turnId: string;
  appendInboundUserMessage: (
    input: DrainBlockedInboundMessageInput,
  ) => Promise<DrainBlockedInboundMessageResult | void> | DrainBlockedInboundMessageResult | void;
}

export interface DrainBlockedInboundMessageInput {
  item: DurableInboundItem;
  commitRef: string;
}

export interface DrainBlockedInboundMessageResult {
  commitRef?: string;
}

export interface DrainBlockedInboundItemsResult {
  consumedItems: DurableInboundItem[];
  consumedIds: string[];
}

export async function drainBlockedInboundItems(
  input: DrainBlockedInboundItemsInput,
): Promise<DrainBlockedInboundItemsResult> {
  const blockedItems = await input.store.listInboundItems({
    agentName: input.agentName,
    conversationId: input.conversationId,
    statuses: ["blocked"],
    blockedBy: input.blockedBy,
  });
  const consumedItems: DurableInboundItem[] = [];

  for (const item of blockedItems.sort((a, b) => a.sequence - b.sequence)) {
    const commitRef = inboundUserMessageCommitRef(item.id);
    const appendResult = await input.appendInboundUserMessage({ item, commitRef });
    const consumed = await input.store.markConsumed({
      id: item.id,
      turnId: input.turnId,
      commitRef: appendResult?.commitRef ?? commitRef,
    });
    consumedItems.push(consumed);
  }

  return {
    consumedItems,
    consumedIds: consumedItems.map((item) => item.id),
  };
}

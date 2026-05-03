import type {
  AcquireInboundInput,
  AppendInboundInput,
  AppendInboundResult,
  DeadLetterInboundInput,
  DurableInboundItem,
  DurableInboundReferenceStore,
  InboundItemStatus,
  FailInboundInput,
  InboundItemFilter,
  MarkInboundBlockedInput,
  MarkInboundConsumedInput,
  MarkInboundDeliveredInput,
  ReleaseBlockedInboundInput,
  ReleaseInboundItemInput,
} from "@goondan/openharness-types";

export interface InMemoryDurableInboundStoreOptions {
  idPrefix?: string;
  defaultLeaseTtlMs?: number;
  maxAttempts?: number;
  now?: () => string;
}

export class InMemoryDurableInboundStore implements DurableInboundReferenceStore {
  private readonly _items = new Map<string, DurableInboundItem>();
  private readonly _idempotencyIndex = new Map<string, string>();
  private readonly _nextSequenceByConversation = new Map<string, number>();
  private readonly _idPrefix: string;
  private readonly _defaultLeaseTtlMs: number;
  private readonly _maxAttempts: number;
  private readonly _now: () => string;
  private _nextId = 1;

  constructor(options: InMemoryDurableInboundStoreOptions = {}) {
    this._idPrefix = options.idPrefix ?? "inbound";
    this._defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;
    this._maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    this._now = options.now ?? (() => new Date().toISOString());
  }

  async append(input: AppendInboundInput): Promise<AppendInboundResult> {
    const now = input.now ?? this._now();
    const idempotencyKey = input.idempotencyKey ?? defaultInboundIdempotencyKey(input);
    const existingId = this._idempotencyIndex.get(idempotencyKey);

    if (existingId) {
      const existing = this._mustGet(existingId);
      return {
        item: cloneInboundItem(existing),
        duplicate: true,
        disposition: "duplicate",
      };
    }

    const sequenceKey = conversationKey(input.agentName, input.conversationId);
    const sequence = this._nextSequenceByConversation.get(sequenceKey) ?? 1;
    this._nextSequenceByConversation.set(sequenceKey, sequence + 1);

    const item: DurableInboundItem = {
      id: `${this._idPrefix}-${this._nextId++}`,
      agentName: input.agentName,
      conversationId: input.conversationId,
      sequence,
      envelope: cloneValue(input.envelope),
      source: { ...input.source },
      idempotencyKey,
      status: "pending",
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };

    this._items.set(item.id, item);
    this._idempotencyIndex.set(idempotencyKey, item.id);

    return {
      item: cloneInboundItem(item),
      duplicate: false,
      disposition: "pending",
    };
  }

  async acquireNext(input: AcquireInboundInput): Promise<DurableInboundItem | null> {
    const now = input.now ?? this._now();
    const nowMs = Date.parse(now);
    const item = this._orderedItems().find((candidate) => {
      if (candidate.agentName !== input.agentName) {
        return false;
      }
      if (candidate.conversationId !== input.conversationId) {
        return false;
      }
      if (candidate.status === "pending") {
        return true;
      }
      if (candidate.status !== "leased" || !candidate.lease) {
        return false;
      }
      return Date.parse(candidate.lease.expiresAt) <= nowMs;
    });

    if (!item) {
      return null;
    }

    item.status = "leased";
    item.lease = {
      owner: input.leaseOwner,
      acquiredAt: now,
      expiresAt: addMs(now, input.leaseTtlMs ?? this._defaultLeaseTtlMs),
    };
    item.attempt += 1;
    item.failure = undefined;
    item.updatedAt = now;

    return cloneInboundItem(item);
  }

  async markDelivered(input: MarkInboundDeliveredInput): Promise<DurableInboundItem> {
    const item = this._mustGet(input.id);
    this._assertLeaseOwner(item, input.leaseOwner);
    if (item.status === "consumed") {
      return cloneInboundItem(item);
    }
    if (item.status !== "leased" && item.status !== "delivered" && item.status !== "pending") {
      throw new Error(`Cannot mark inbound item "${item.id}" delivered from status "${item.status}".`);
    }

    item.status = "delivered";
    item.turnId = input.turnId;
    item.lease = undefined;
    item.updatedAt = input.now ?? this._now();
    return cloneInboundItem(item);
  }

  async markBlocked(input: MarkInboundBlockedInput): Promise<DurableInboundItem> {
    const item = this._mustGet(input.id);
    this._assertLeaseOwner(item, input.leaseOwner);
    if (item.status === "blocked" && sameBlocker(item.blockedBy, input.blockedBy)) {
      return cloneInboundItem(item);
    }
    if (item.status !== "leased" && item.status !== "pending" && item.status !== "blocked" && item.status !== "delivered") {
      throw new Error(`Cannot mark inbound item "${item.id}" blocked from status "${item.status}".`);
    }

    item.status = "blocked";
    item.blockedBy = cloneValue(input.blockedBy);
    item.lease = undefined;
    item.updatedAt = input.now ?? this._now();
    return cloneInboundItem(item);
  }

  async markConsumed(input: MarkInboundConsumedInput): Promise<DurableInboundItem> {
    const item = this._mustGet(input.id);
    this._assertLeaseOwner(item, input.leaseOwner);
    if (item.status === "consumed") {
      if (item.commitRef !== input.commitRef) {
        throw new Error(`Inbound item "${item.id}" is already consumed with a different commitRef.`);
      }
      return cloneInboundItem(item);
    }
    if (!["pending", "leased", "delivered", "blocked"].includes(item.status)) {
      throw new Error(`Cannot mark inbound item "${item.id}" consumed from status "${item.status}".`);
    }

    item.status = "consumed";
    item.turnId = input.turnId ?? item.turnId;
    item.commitRef = input.commitRef;
    item.lease = undefined;
    item.updatedAt = input.now ?? this._now();
    return cloneInboundItem(item);
  }

  async markFailed(input: FailInboundInput): Promise<DurableInboundItem> {
    const item = this._mustGet(input.id);
    this._assertLeaseOwner(item, input.leaseOwner);
    const now = input.now ?? this._now();

    item.status = input.retryable ? "failed" : "deadLetter";
    item.failure = {
      reason: input.reason,
      retryable: input.retryable,
      failedAt: now,
    };
    item.lease = undefined;
    item.updatedAt = now;
    return cloneInboundItem(item);
  }

  async releaseExpiredLeases(now: string): Promise<number> {
    const nowMs = Date.parse(now);
    let released = 0;

    for (const item of this._items.values()) {
      if (item.status !== "leased" || !item.lease) {
        continue;
      }
      if (Date.parse(item.lease.expiresAt) > nowMs) {
        continue;
      }

      item.lease = undefined;
      item.updatedAt = now;
      if (item.attempt >= this._maxAttempts) {
        item.status = "deadLetter";
        item.failure = {
          reason: "Lease expired after maximum attempts.",
          retryable: false,
          failedAt: now,
        };
      } else {
        item.status = "pending";
      }
      released += 1;
    }

    return released;
  }

  async listInboundItems(filter: InboundItemFilter = {}): Promise<DurableInboundItem[]> {
    const statusValues = filter.status
      ? (Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    const statuses = statusValues ? new Set<InboundItemStatus>(statusValues) : null;
    const items = this._orderedItems().filter((item) => {
      if (filter.agentName && item.agentName !== filter.agentName) {
        return false;
      }
      if (filter.conversationId && item.conversationId !== filter.conversationId) {
        return false;
      }
      if (statuses && !statuses.has(item.status)) {
        return false;
      }
      if (filter.blockedBy && !matchesBlocker(item.blockedBy, filter.blockedBy)) {
        return false;
      }
      return true;
    });

    const limited = typeof filter.limit === "number" ? items.slice(0, filter.limit) : items;
    return limited.map(cloneInboundItem);
  }

  async retryInboundItem(id: string): Promise<DurableInboundItem> {
    const item = this._mustGet(id);
    if (!["failed", "deadLetter", "blocked", "delivered"].includes(item.status)) {
      throw new Error(`Cannot retry inbound item "${id}" from status "${item.status}".`);
    }

    return this._releaseToPending(item, this._now());
  }

  async releaseInboundItem(input: ReleaseInboundItemInput): Promise<DurableInboundItem> {
    const item = this._mustGet(input.id);
    this._assertLeaseOwner(item, input.leaseOwner);
    if (!["leased", "delivered", "blocked"].includes(item.status)) {
      throw new Error(`Cannot release inbound item "${input.id}" from status "${item.status}".`);
    }

    return this._releaseToPending(item, input.now ?? this._now());
  }

  async deadLetterInboundItem(input: DeadLetterInboundInput): Promise<DurableInboundItem> {
    const item = this._mustGet(input.id);
    const now = input.now ?? this._now();

    item.status = "deadLetter";
    item.failure = {
      reason: input.reason,
      retryable: false,
      failedAt: now,
    };
    item.lease = undefined;
    item.updatedAt = now;
    return cloneInboundItem(item);
  }

  async releaseBlockedInboundItems(input: ReleaseBlockedInboundInput = {}): Promise<DurableInboundItem[]> {
    const now = input.now ?? this._now();
    const released: DurableInboundItem[] = [];

    for (const item of this._orderedItems()) {
      if (item.status !== "blocked") {
        continue;
      }
      if (input.agentName && item.agentName !== input.agentName) {
        continue;
      }
      if (input.conversationId && item.conversationId !== input.conversationId) {
        continue;
      }
      if (input.blockedBy && !matchesBlocker(item.blockedBy, input.blockedBy)) {
        continue;
      }

      released.push(this._releaseToPending(item, now));
    }

    return released;
  }

  async getInboundItem(id: string): Promise<DurableInboundItem | null> {
    const item = this._items.get(id);
    return item ? cloneInboundItem(item) : null;
  }

  private _mustGet(id: string): DurableInboundItem {
    const item = this._items.get(id);
    if (!item) {
      throw new Error(`Unknown inbound item: "${id}".`);
    }
    return item;
  }

  private _assertLeaseOwner(item: DurableInboundItem, expectedOwner: string | undefined): void {
    if (!expectedOwner) {
      return;
    }
    if (!item.lease || item.lease.owner !== expectedOwner) {
      throw new Error(`Inbound item "${item.id}" is not leased by "${expectedOwner}".`);
    }
  }

  private _orderedItems(): DurableInboundItem[] {
    return [...this._items.values()].sort((a, b) => {
      const conversationOrder = conversationKey(a.agentName, a.conversationId).localeCompare(
        conversationKey(b.agentName, b.conversationId),
      );
      if (conversationOrder !== 0) {
        return conversationOrder;
      }
      return a.sequence - b.sequence;
    });
  }

  private _releaseToPending(item: DurableInboundItem, now: string): DurableInboundItem {
    item.status = "pending";
    item.turnId = undefined;
    item.blockedBy = undefined;
    item.commitRef = undefined;
    item.lease = undefined;
    item.failure = undefined;
    item.updatedAt = now;
    return cloneInboundItem(item);
  }
}

export function createInMemoryDurableInboundStore(
  options?: InMemoryDurableInboundStoreOptions,
): InMemoryDurableInboundStore {
  return new InMemoryDurableInboundStore(options);
}

export function defaultInboundIdempotencyKey(input: AppendInboundInput): string {
  const externalPart = input.source.externalId ?? stableStringify(input.envelope);
  return [
    input.source.kind,
    input.source.connectionName ?? "direct",
    input.agentName,
    input.conversationId,
    input.envelope.name,
    externalPart,
  ].join(":");
}

function conversationKey(agentName: string, conversationId: string): string {
  return `${agentName}\u0000${conversationId}`;
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function sameBlocker(
  left: DurableInboundItem["blockedBy"],
  right: DurableInboundItem["blockedBy"],
): boolean {
  return !!left && !!right && left.type === right.type && left.id === right.id;
}

function matchesBlocker(
  actual: DurableInboundItem["blockedBy"],
  expected: NonNullable<InboundItemFilter["blockedBy"]>,
): boolean {
  if (!actual) {
    return false;
  }
  if (expected.type && actual.type !== expected.type) {
    return false;
  }
  if (expected.id && actual.id !== expected.id) {
    return false;
  }
  return true;
}

function cloneInboundItem(item: DurableInboundItem): DurableInboundItem {
  return cloneValue(item);
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeys(record[key]);
  }
  return sorted;
}

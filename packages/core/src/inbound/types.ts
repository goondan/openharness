import type { InboundEnvelope } from "@goondan/openharness-types";

export type DurableInboundItemStatus =
  | "pending"
  | "leased"
  | "delivered"
  | "blocked"
  | "consumed"
  | "failed"
  | "deadLetter";

export type DurableIngressDisposition =
  | "started"
  | "delivered"
  | "blocked"
  | "duplicate"
  | "steered";

export interface ConversationBlockerRef {
  type: "humanGate" | "operatorHold" | (string & {});
  id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface LeaseInfo {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface DurableInboundSource {
  kind: "ingress" | "direct";
  connectionName?: string;
  externalId?: string;
  receivedAt: string;
}

export interface DurableInboundItem {
  id: string;
  agentName: string;
  conversationId: string;
  sequence: number;
  envelope: InboundEnvelope;
  source: DurableInboundSource;
  idempotencyKey: string;
  status: DurableInboundItemStatus;
  turnId?: string;
  blockedBy?: ConversationBlockerRef;
  commitRef?: string;
  lease?: LeaseInfo;
  attempt: number;
  failure?: InboundFailureInfo;
  createdAt: string;
  updatedAt: string;
}

export interface InboundFailureInfo {
  reason: string;
  retryable: boolean;
  failedAt: string;
}

export interface AppendInboundInput {
  agentName: string;
  conversationId: string;
  envelope: InboundEnvelope;
  source: DurableInboundSource;
  idempotencyKey?: string;
  now?: string;
}

export interface AppendInboundResult {
  item: DurableInboundItem;
  appended: boolean;
  duplicate: boolean;
  disposition: "pending" | "duplicate";
}

export interface AcquireInboundInput {
  agentName: string;
  conversationId: string;
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: string;
}

export interface MarkInboundDeliveredInput {
  id: string;
  turnId: string;
  leaseOwner?: string;
  now?: string;
}

export interface MarkInboundBlockedInput {
  id: string;
  blockedBy: ConversationBlockerRef;
  leaseOwner?: string;
  now?: string;
}

export interface MarkInboundConsumedInput {
  id: string;
  turnId?: string;
  commitRef: string;
  leaseOwner?: string;
  now?: string;
}

export interface FailInboundInput {
  id: string;
  reason: string;
  retryable: boolean;
  leaseOwner?: string;
  now?: string;
}

export interface DeadLetterInboundInput {
  id: string;
  reason: string;
  now?: string;
}

export interface ReleaseBlockedInboundInput {
  agentName?: string;
  conversationId?: string;
  blockedBy?: Partial<ConversationBlockerRef>;
  now?: string;
}

export interface ReleaseInboundItemInput {
  id: string;
  leaseOwner?: string;
  now?: string;
}

export interface InboundItemFilter {
  agentName?: string;
  conversationId?: string;
  status?: DurableInboundItemStatus | DurableInboundItemStatus[];
  statuses?: DurableInboundItemStatus[];
  blockedBy?: Partial<ConversationBlockerRef>;
  limit?: number;
}

export interface DurableInboundStore {
  append(input: AppendInboundInput): Promise<AppendInboundResult>;
  acquireNext(input: AcquireInboundInput): Promise<DurableInboundItem | null>;
  markDelivered(input: MarkInboundDeliveredInput): Promise<DurableInboundItem>;
  markBlocked(input: MarkInboundBlockedInput): Promise<DurableInboundItem>;
  markConsumed(input: MarkInboundConsumedInput): Promise<DurableInboundItem>;
  releaseExpiredLeases(now: string): Promise<number>;
  listInboundItems(filter: InboundItemFilter): Promise<DurableInboundItem[]>;
  retryInboundItem(id: string): Promise<DurableInboundItem>;
  releaseInboundItem?(input: ReleaseInboundItemInput): Promise<DurableInboundItem>;
  deadLetterInboundItem(input: DeadLetterInboundInput): Promise<DurableInboundItem>;
}

export interface DurableInboundReferenceStore extends DurableInboundStore {
  markFailed(input: FailInboundInput): Promise<DurableInboundItem>;
  releaseBlockedInboundItems(input: ReleaseBlockedInboundInput): Promise<DurableInboundItem[]>;
  getInboundItem(id: string): Promise<DurableInboundItem | null>;
}

export type InboundScheduleDecision =
  | {
      disposition: "started";
      inboundItemId: string;
      turnId: string;
      item: DurableInboundItem;
    }
  | {
      disposition: "delivered";
      inboundItemId: string;
      turnId: string;
      item: DurableInboundItem;
    }
  | {
      disposition: "blocked";
      inboundItemId: string;
      blocker: ConversationBlockerRef;
      item: DurableInboundItem;
    }
  | {
      disposition: "noop";
      reason: "empty" | "leaseConflict" | "noStartTurn";
    };

export interface InboundAcceptedHandle {
  inboundItemId: string;
  agentName: string;
  conversationId: string;
  sequence: number;
  disposition: DurableIngressDisposition;
  turnId?: string;
  blocker?: ConversationBlockerRef;
}

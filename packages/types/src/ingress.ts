// InboundContentPart
export type InboundContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string }
  | { type: "file"; url: string; name: string; mimeType?: string };

// EventSource
export interface EventSource {
  connector: string;
  connectionName: string;
  receivedAt: string;
}

// InboundEnvelope
export interface InboundEnvelope {
  name: string;
  content: InboundContentPart[];
  properties: Record<string, string | number | boolean>;
  conversationId?: string;
  source: EventSource;
  metadata?: Record<string, unknown>;
}

// ConnectorContext
export interface ConnectorContext {
  connectionName: string;
  payload: unknown;
  receivedAt: string;
}

// Connector
export interface Connector {
  name: string;
  verify?(ctx: ConnectorContext): Promise<void> | void;
  normalize(ctx: ConnectorContext): Promise<InboundEnvelope | InboundEnvelope[]>;
}

// RoutingMatch / RoutingRule
export interface RoutingMatch {
  event?: string;
  [key: string]: unknown;
}

export interface RoutingRule {
  match: RoutingMatch;
  agent: string;
  conversationId?: string;
  conversationIdProperty?: string;
  conversationIdPrefix?: string;
}

// Durable inbound / blocker types
export type InboundItemStatus =
  | "pending"
  | "leased"
  | "delivered"
  | "blocked"
  | "consumed"
  | "failed"
  | "deadLetter";

export type DurableInboundItemStatus = InboundItemStatus;

export type IngressDisposition =
  | "started"
  | "delivered"
  | "blocked"
  | "duplicate"
  | "steered";

export type DurableIngressDisposition = IngressDisposition;

export type ConversationBlockerType = "humanApproval" | "operatorHold";

export interface ConversationBlockerRef {
  type: ConversationBlockerType | (string & {});
  id: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface LeaseInfo {
  owner: string;
  expiresAt: string;
  acquiredAt?: string;
  token?: string;
}

export interface InboundSource {
  kind: "ingress" | "direct";
  connectionName?: string;
  externalId?: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
}

export type DurableInboundSource = InboundSource;

export interface InboundFailureInfo {
  reason: string;
  retryable: boolean;
  failedAt: string;
}

export interface DurableInboundItem {
  id: string;
  agentName: string;
  conversationId: string;
  sequence: number;
  envelope: InboundEnvelope;
  source: InboundSource;
  idempotencyKey: string;
  status: InboundItemStatus;
  turnId?: string;
  blockedBy?: ConversationBlockerRef;
  commitRef?: string;
  lease?: LeaseInfo;
  attempt: number;
  lastError?: string;
  failure?: InboundFailureInfo;
  createdAt: string;
  updatedAt: string;
}

export interface AppendInboundInput {
  agentName: string;
  conversationId: string;
  envelope: InboundEnvelope;
  source: InboundSource;
  idempotencyKey?: string;
  receivedAt?: string;
  now?: string;
  turnId?: string;
}

export interface AppendInboundResult {
  item: DurableInboundItem;
  appended?: boolean;
  duplicate: boolean;
  disposition?: "pending" | "duplicate";
}

export interface AcquireInboundInput {
  agentName: string;
  conversationId: string;
  leaseOwner: string;
  leaseExpiresAt?: string;
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

export interface InboundItemFilter {
  agentName?: string;
  conversationId?: string;
  status?: InboundItemStatus | InboundItemStatus[];
  statuses?: InboundItemStatus[];
  blockedBy?: ConversationBlockerRef | Partial<ConversationBlockerRef>;
  limit?: number;
}

export interface DeadLetterInboundInput {
  id: string;
  reason: string;
  now?: string;
}

export interface ReleaseInboundItemInput {
  id: string;
  leaseOwner?: string;
  now?: string;
}

export interface ReleaseBlockedInboundInput {
  agentName?: string;
  conversationId?: string;
  blockedBy?: Partial<ConversationBlockerRef>;
  now?: string;
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

export interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId?: string;
  disposition: IngressDisposition;
  inboundItemId?: string;
  blocker?: ConversationBlockerRef;
}

// ConnectionInfo — also used by extension RuntimeInfo
export interface ConnectionInfo {
  name: string;
  connectorName: string;
  ruleCount: number;
}

// IngressApi
export interface IngressApi {
  receive(input: {
    connectionName: string;
    payload: unknown;
    receivedAt?: string;
  }): Promise<IngressAcceptResult[]>;

  dispatch(input: {
    connectionName: string;
    envelope: InboundEnvelope;
    receivedAt?: string;
  }): Promise<IngressAcceptResult>;

  listConnections(): ConnectionInfo[];
}

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

export type IngressDisposition =
  | "started"
  | "delivered"
  | "blocked"
  | "duplicate"
  | "steered";

export type ConversationBlockerType = "humanGate" | "operatorHold";

export interface ConversationBlockerRef {
  type: ConversationBlockerType;
  id: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface AppendInboundInput {
  agentName: string;
  conversationId: string;
  envelope: InboundEnvelope;
  source: InboundSource;
  idempotencyKey: string;
  receivedAt?: string;
  turnId?: string;
}

export interface AppendInboundResult {
  item: DurableInboundItem;
  duplicate: boolean;
}

export interface AcquireInboundInput {
  agentName: string;
  conversationId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
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
  now?: string;
}

export interface MarkInboundConsumedInput {
  id: string;
  turnId: string;
  commitRef: string;
  now?: string;
}

export interface FailInboundInput {
  id: string;
  reason: string;
  retryable: boolean;
  now?: string;
}

export interface InboundItemFilter {
  agentName?: string;
  conversationId?: string;
  status?: InboundItemStatus | InboundItemStatus[];
  blockedBy?: ConversationBlockerRef;
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

export interface DurableInboundStore {
  append(input: AppendInboundInput): Promise<AppendInboundResult>;
  acquireNext(input: AcquireInboundInput): Promise<DurableInboundItem | null>;
  markDelivered(input: MarkInboundDeliveredInput): Promise<DurableInboundItem>;
  markBlocked(input: MarkInboundBlockedInput): Promise<DurableInboundItem>;
  markConsumed(input: MarkInboundConsumedInput): Promise<DurableInboundItem>;
  markFailed?(input: FailInboundInput): Promise<DurableInboundItem>;
  releaseExpiredLeases(now: string): Promise<number>;
  listInboundItems(filter: InboundItemFilter): Promise<DurableInboundItem[]>;
  retryInboundItem(id: string): Promise<DurableInboundItem>;
  releaseInboundItem?(input: ReleaseInboundItemInput): Promise<DurableInboundItem>;
  deadLetterInboundItem(input: DeadLetterInboundInput): Promise<DurableInboundItem>;
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

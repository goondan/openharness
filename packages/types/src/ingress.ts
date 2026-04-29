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

// IngressAcceptResult
export type IngressDisposition = "started" | "steered" | "queuedForHitl";

export interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId?: string;
  batchId?: string;
  pendingRequestIds?: string[];
  disposition: IngressDisposition;
}

export interface IngressStartedResult extends IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId: string;
  batchId?: never;
  pendingRequestIds?: never;
  disposition: "started";
}

export interface IngressSteeredResult extends IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId: string;
  batchId?: never;
  pendingRequestIds?: never;
  disposition: "steered";
}

export interface IngressQueuedForHitlResult extends IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId?: string;
  batchId: string;
  pendingRequestIds: string[];
  disposition: "queuedForHitl";
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

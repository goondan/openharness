/**
 * 에이전트 통신 API 타입 (단일 계약)
 * 원형: docs/specs/shared-types.md 섹션 8
 */

import type { JsonObject, JsonValue } from "./json.js";
import type { AgentEvent } from "./events.js";

export interface AgentRuntimeRequestOptions {
  timeoutMs?: number;
  async?: boolean;
}

export interface AgentRuntimeRequestResult {
  eventId: string;
  target: string;
  response?: JsonValue;
  correlationId: string;
  accepted?: boolean;
  async?: boolean;
}

export interface AgentRuntimeSendResult {
  eventId: string;
  target: string;
  accepted: boolean;
}

export interface AgentRuntimeSpawnOptions {
  instanceKey?: string;
  cwd?: string;
}

export interface AgentRuntimeSpawnResult {
  target: string;
  instanceKey: string;
  spawned: boolean;
  cwd?: string;
}

export interface AgentRuntimeListOptions {
  includeAll?: boolean;
}

export interface SpawnedAgentInfo {
  target: string;
  instanceKey: string;
  ownerAgent: string;
  ownerInstanceKey: string;
  createdAt: string;
  cwd?: string;
}

export interface AgentRuntimeListResult {
  agents: SpawnedAgentInfo[];
}

export interface AgentRuntimeCatalogResult {
  swarmName: string;
  entryAgent: string;
  selfAgent: string;
  availableAgents: string[];
  callableAgents: string[];
}

export type InterAgentResponseStatus = "ok" | "error" | "timeout";

export interface InterAgentResponseMetadata {
  kind: "inter_agent_response";
  version: 1;
  requestId: string;
  requestEventId: string;
  responseEventId?: string;
  fromAgentId: string;
  toAgentId: string;
  async: true;
  status: InterAgentResponseStatus;
  receivedAt: string;
  traceId?: string;
  requestEventType?: string;
  requestMetadata?: JsonObject;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentToolRuntime {
  request(target: string, event: AgentEvent, options?: AgentRuntimeRequestOptions): Promise<AgentRuntimeRequestResult>;
  send(target: string, event: AgentEvent): Promise<AgentRuntimeSendResult>;
  spawn(target: string, options?: AgentRuntimeSpawnOptions): Promise<AgentRuntimeSpawnResult>;
  list(options?: AgentRuntimeListOptions): Promise<AgentRuntimeListResult>;
  catalog(): Promise<AgentRuntimeCatalogResult>;
}

export interface MiddlewareAgentsApi {
  request(params: {
    target: string;
    input?: string;
    instanceKey?: string;
    timeoutMs?: number;
    async?: boolean;
    metadata?: JsonObject;
  }): Promise<{
    target: string;
    response: string;
    correlationId?: string;
    accepted?: boolean;
    async?: boolean;
  }>;

  send(params: {
    target: string;
    input?: string;
    instanceKey?: string;
    metadata?: JsonObject;
  }): Promise<{
    accepted: boolean;
  }>;
}


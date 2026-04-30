import type { Extension } from "./extension.js";
import type { HumanApprovalStore, ToolDefinition } from "./tool.js";
import type { Connector, DurableInboundStore, RoutingRule } from "./ingress.js";

// -----------------------------------------------------------------------
// EnvRef — branded type for deferred environment variable resolution
// -----------------------------------------------------------------------

declare const ENV_REF_BRAND: unique symbol;

export interface EnvRef {
  readonly [ENV_REF_BRAND]: true;
  readonly name: string;
}

export type EnvResolvable<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends string
      ? T | EnvRef
      : T extends Array<infer U>
        ? Array<EnvResolvable<U>>
        : T extends object
          ? { [K in keyof T]: EnvResolvable<T[K]> }
          : T;

// -----------------------------------------------------------------------
// Model / agent / connection config
// -----------------------------------------------------------------------

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string | EnvRef;
  baseUrl?: string | EnvRef;
  providerOptions?: Record<string, unknown>;
}

export interface AgentConfig {
  model: ModelConfig;
  extensions?: Extension[];
  tools?: ToolDefinition[];
  maxSteps?: number;
}

export interface ConnectionConfig {
  connector: Connector;
  extensions?: Extension[];
  rules: RoutingRule[];
}

export interface DurableInboundConfig {
  enabled?: boolean;
  store: DurableInboundStore;
  leaseMs?: number;
  maxAttempts?: number;
}

export interface HumanApprovalConfig {
  store: HumanApprovalStore;
  resumeLeaseMs?: number;
}

// -----------------------------------------------------------------------
// Top-level harness config
// -----------------------------------------------------------------------

export interface HarnessConfig {
  agents: Record<string, AgentConfig>;
  connections?: Record<string, ConnectionConfig>;
  durableInbound?: DurableInboundConfig;
  humanApproval?: HumanApprovalConfig;
}

// -----------------------------------------------------------------------
// ProcessTurnOptions
// -----------------------------------------------------------------------

export interface ProcessTurnOptions {
  conversationId?: string;
  idempotencyKey?: string;
  receivedAt?: string;
  metadata?: Record<string, unknown>;
}

// -----------------------------------------------------------------------
// defineHarness — identity function (pure declaration, no side effects)
// -----------------------------------------------------------------------

export function defineHarness(config: HarnessConfig): HarnessConfig {
  return config;
}

// -----------------------------------------------------------------------
// env() — creates a deferred environment variable reference
// -----------------------------------------------------------------------

export function env(name: string): EnvRef {
  return { name } as EnvRef;
}

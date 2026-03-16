import type { Extension } from "./extension.js";
import type { ToolDefinition } from "./tool.js";
import type { Connector, RoutingRule } from "./ingress.js";

// -----------------------------------------------------------------------
// EnvRef — branded type for deferred environment variable resolution
// -----------------------------------------------------------------------

declare const ENV_REF_BRAND: unique symbol;

export interface EnvRef {
  readonly [ENV_REF_BRAND]: true;
  readonly name: string;
}

// -----------------------------------------------------------------------
// Model / agent / connection config
// -----------------------------------------------------------------------

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
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

// -----------------------------------------------------------------------
// Top-level harness config
// -----------------------------------------------------------------------

export interface HarnessConfig {
  agents: Record<string, AgentConfig>;
  connections?: Record<string, ConnectionConfig>;
}

// -----------------------------------------------------------------------
// ProcessTurnOptions
// -----------------------------------------------------------------------

export interface ProcessTurnOptions {
  conversationId?: string;
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

import type {
  TurnMiddleware,
  StepMiddleware,
  ToolCallMiddleware,
  VerifyMiddleware,
  NormalizeMiddleware,
  RouteMiddleware,
  DispatchMiddleware,
  MiddlewareOptions,
} from "./middleware.js";
import type { ToolDefinition, ToolInfo } from "./tool.js";
import type { ConversationState } from "./conversation.js";
import type { ConnectionInfo } from "./ingress.js";
import type { EventPayload } from "./events.js";

// -----------------------------------------------------------------------
// Runtime info types
// -----------------------------------------------------------------------

export interface ModelInfo {
  provider: string;
  model: string;
}

export interface ExtensionInfo {
  name: string;
}

export interface AgentInfo {
  name: string;
  model: ModelInfo;
  extensionCount: number;
  toolCount: number;
}

// Re-export ConnectionInfo so consumers can import it from this module too
export type { ConnectionInfo };

export interface RuntimeInfo {
  agent: {
    name: string;
    model: ModelInfo;
    extensions: readonly ExtensionInfo[];
    tools: readonly ToolInfo[];
    maxSteps?: number;
  };
  agents: Readonly<Record<string, AgentInfo>>;
  connections: Readonly<Record<string, ConnectionInfo>>;
}

// -----------------------------------------------------------------------
// ExtensionApi
// -----------------------------------------------------------------------

export interface ExtensionApi {
  pipeline: {
    register(level: "turn", handler: TurnMiddleware, options?: MiddlewareOptions): void;
    register(level: "step", handler: StepMiddleware, options?: MiddlewareOptions): void;
    register(level: "toolCall", handler: ToolCallMiddleware, options?: MiddlewareOptions): void;
    register(level: "verify", handler: VerifyMiddleware, options?: MiddlewareOptions): void;
    register(level: "normalize", handler: NormalizeMiddleware, options?: MiddlewareOptions): void;
    register(level: "route", handler: RouteMiddleware, options?: MiddlewareOptions): void;
    register(level: "dispatch", handler: DispatchMiddleware, options?: MiddlewareOptions): void;
  };
  tools: {
    register(tool: ToolDefinition): void;
    remove(name: string): void;
    list(): readonly ToolDefinition[];
  };
  on(event: string, listener: (payload: EventPayload) => void): void;
  conversation: ConversationState;
  runtime: RuntimeInfo;
}

// -----------------------------------------------------------------------
// Extension
// -----------------------------------------------------------------------

export interface Extension {
  name: string;
  register(api: ExtensionApi): void;
}

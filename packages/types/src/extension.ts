import type {
  TurnMiddleware,
  StepMiddleware,
  ToolCallMiddleware,
  IngressMiddleware,
  RouteMiddleware,
  MiddlewareOptions,
} from "./middleware.js";
import type { ToolDefinition, ToolInfo } from "./tool.js";
import type { ConversationState } from "./conversation.js";
import type { ConnectionInfo } from "./ingress.js";
import type {
  AgentScopeEventType,
  ConnectionScopeEventType,
  CustomHarnessEvents,
  HarnessEvents,
} from "./events.js";
import type { RecoveryApi } from "./recovery.js";
import type { PromptApi } from "./prompt.js";

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
// events.emit surface (F5)
//
// When no `CustomHarnessEvents` are declared, `keyof CustomHarnessEvents` is
// `never` and `emit` collapses to a single-arg signature whose parameter type
// is a guidance string — so the TS error itself tells you to augment the
// interface, rather than emitting an opaque "expected 0 arguments".
// -----------------------------------------------------------------------

export type EventsApi = [keyof CustomHarnessEvents] extends [never]
  ? {
      /**
       * Emit a custom event. Declare one first:
       * ```ts
       * declare module "@goondan/openharness-types" {
       *   interface CustomHarnessEvents {
       *     "myext.done": { type: "myext.done"; count: number };
       *   }
       * }
       * ```
       */
      emit(
        _hint: "ⓘ augment CustomHarnessEvents via `declare module` to emit custom events",
      ): never;
    }
  : {
      emit<T extends keyof CustomHarnessEvents>(
        event: T,
        payload: CustomHarnessEvents[T],
      ): void;
    };

// -----------------------------------------------------------------------
// ExtensionApi — agent and connection flavors (F5)
// -----------------------------------------------------------------------

/**
 * Surface passed to an agent-scoped extension's `register`. Agent extensions
 * register turn/step/toolCall middleware, claim errors, project the prompt,
 * and observe agent-scoped events. Listening to `ingress.*` here is a compile
 * error — split a dual-scope observer into two extensions.
 */
export interface AgentExtensionApi {
  pipeline: {
    register(level: "turn", handler: TurnMiddleware, options?: MiddlewareOptions): void;
    register(level: "step", handler: StepMiddleware, options?: MiddlewareOptions): void;
    register(level: "toolCall", handler: ToolCallMiddleware, options?: MiddlewareOptions): void;
  };
  tools: {
    register(tool: ToolDefinition): void;
    remove(name: string): void;
    list(): readonly ToolDefinition[];
  };
  /** Subscribe to an agent-scoped (or custom) event. */
  on<T extends AgentScopeEventType | keyof CustomHarnessEvents>(
    event: T,
    listener: (payload: HarnessEvents[T]) => void,
  ): void;
  /** Claim a class of error and declare how the dispatcher recovers (F4). */
  recovery: RecoveryApi;
  /** Register prompt-view projections (F2). */
  prompt: PromptApi;
  /** Emit custom events on the agent bus (F5). */
  events: EventsApi;
  conversation: ConversationState;
  runtime: RuntimeInfo;
}

/**
 * Surface passed to a connection-scoped extension's `register`. Connection
 * extensions register ingress/route middleware and observe connection-scoped
 * events. There is no LLM/tool loop here, so `recovery`/`prompt`/`conversation`
 * are intentionally absent and `recovery.claim` at this scope is an error.
 */
export interface ConnectionExtensionApi {
  pipeline: {
    register(level: "ingress", handler: IngressMiddleware, options?: MiddlewareOptions): void;
    register(level: "route", handler: RouteMiddleware, options?: MiddlewareOptions): void;
  };
  /** Subscribe to a connection-scoped (or custom) event. */
  on<T extends ConnectionScopeEventType | keyof CustomHarnessEvents>(
    event: T,
    listener: (payload: HarnessEvents[T]) => void,
  ): void;
  /** Emit custom events on the connection bus (F5). */
  events: EventsApi;
  runtime: RuntimeInfo;
}

// -----------------------------------------------------------------------
// Extension — agent and connection flavors
// -----------------------------------------------------------------------

export interface AgentExtension {
  name: string;
  register(api: AgentExtensionApi): void;
}

export interface ConnectionExtension {
  name: string;
  register(api: ConnectionExtensionApi): void;
}

/**
 * @deprecated Prefer {@link AgentExtension} / {@link ConnectionExtension}. Kept
 * as an alias for the agent flavor, the common case.
 */
export type Extension = AgentExtension;

/**
 * @deprecated Prefer {@link AgentExtensionApi} / {@link ConnectionExtensionApi}.
 * Alias for the agent flavor.
 */
export type ExtensionApi = AgentExtensionApi;

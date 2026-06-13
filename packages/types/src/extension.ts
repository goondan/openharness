import type {
  TurnMiddleware,
  StepMiddleware,
  ToolCallMiddleware,
  IngressMiddleware,
  ModelInputMiddleware,
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
// events.emit surface
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
// ExtensionApi — agent and connection flavors
//
// Method-separated registration (no string-level dispatch): the flavor exposes
// exactly the methods that make sense for it, so the connection/agent split is
// enforced by which methods exist. `store` is intentionally absent from both
// surfaces — it is conversation-scoped and reached only via `ctx.store`, never
// captured at register time.
// -----------------------------------------------------------------------

/**
 * Surface passed to an agent-scoped extension's `register`. Agent extensions
 * register turn/step/toolCall middleware, assemble the model input, manage
 * tools, and observe agent-scoped events. Listening to `ingress.*` here is a
 * compile error — split a dual-scope observer into two extensions.
 */
export interface AgentExtensionApi {
  useTurn(mw: TurnMiddleware, options?: MiddlewareOptions): void;
  useStep(mw: StepMiddleware, options?: MiddlewareOptions): void;
  useToolCall(mw: ToolCallMiddleware, options?: MiddlewareOptions): void;
  /**
   * Assemble the model input — runs once per step, immediately before the model
   * call. A single throwaway pipe with no before/after options; order is
   * registration order. Pure and non-persisting.
   */
  useModelInput(mw: ModelInputMiddleware): void;
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
  /** Emit custom events on the agent bus. */
  events: EventsApi;
  conversation: ConversationState;
  runtime: RuntimeInfo;
}

/**
 * Surface passed to a connection-scoped extension's `register`. Connection
 * extensions register ingress middleware and observe connection-scoped events.
 * There is no LLM/tool loop here, so `tools`/`conversation`/`useModelInput` are
 * intentionally absent.
 */
export interface ConnectionExtensionApi {
  useIngress(mw: IngressMiddleware, options?: MiddlewareOptions): void;
  /** Subscribe to a connection-scoped (or custom) event. */
  on<T extends ConnectionScopeEventType | keyof CustomHarnessEvents>(
    event: T,
    listener: (payload: HarnessEvents[T]) => void,
  ): void;
  /** Emit custom events on the connection bus. */
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

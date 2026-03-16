import type {
  Extension,
  ExtensionApi,
  RuntimeInfo,
  ToolDefinition,
  EventPayload,
  MiddlewareOptions,
  TurnMiddleware,
  StepMiddleware,
  ToolCallMiddleware,
  VerifyMiddleware,
  NormalizeMiddleware,
  RouteMiddleware,
  DispatchMiddleware,
  ConversationState,
} from "@goondan/openharness-types";
import type { EventBus } from "./event-bus.js";
import type { MiddlewareRegistry } from "./middleware-chain.js";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

/**
 * The set of infrastructure dependencies required to build an ExtensionApi
 * and register extensions.
 */
export interface ExtensionRegistryDeps {
  /** Registry for tool definitions */
  toolRegistry: {
    register(tool: ToolDefinition): void;
    remove(name: string): void;
    list(): readonly ToolDefinition[];
  };
  /** Event bus for pub/sub communication */
  eventBus: EventBus;
  /** Middleware registry for pipeline hooks */
  middlewareRegistry: MiddlewareRegistry;
  /** Snapshot of runtime info for this agent */
  runtimeInfo: RuntimeInfo;
  /** Current conversation state proxy/reference */
  conversationState: ConversationState;
}

// ---------------------------------------------------------------------------
// createExtensionApi
// ---------------------------------------------------------------------------

/**
 * Build a fully-formed ExtensionApi object from the given infrastructure deps.
 * The `runtime` surface is a frozen (deep-readonly) snapshot.
 */
export function createExtensionApi(deps: ExtensionRegistryDeps): ExtensionApi {
  const { toolRegistry, eventBus, middlewareRegistry, runtimeInfo, conversationState } = deps;

  // Freeze a deep snapshot of runtimeInfo so extensions cannot mutate shared state
  const runtimeSnapshot: RuntimeInfo = deepFreeze(structuredClone(runtimeInfo));

  const api: ExtensionApi = {
    pipeline: {
      register(
        level: "turn" | "step" | "toolCall" | "verify" | "normalize" | "route" | "dispatch",
        handler:
          | TurnMiddleware
          | StepMiddleware
          | ToolCallMiddleware
          | VerifyMiddleware
          | NormalizeMiddleware
          | RouteMiddleware
          | DispatchMiddleware,
        options?: MiddlewareOptions
      ): void {
        middlewareRegistry.register(
          level,
          handler as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
          options
        );
      },
    },

    tools: {
      register(tool: ToolDefinition): void {
        toolRegistry.register(tool);
      },
      remove(name: string): void {
        toolRegistry.remove(name);
      },
      list(): readonly ToolDefinition[] {
        return toolRegistry.list();
      },
    },

    on(event: string, listener: (payload: EventPayload) => void): void {
      // EventBus.on is typed with generic EventType, but we need to accept
      // any string as per the ExtensionApi interface contract.
      (eventBus as { on(event: string, listener: (payload: EventPayload) => void): void }).on(
        event,
        listener
      );
    },

    conversation: conversationState,

    runtime: runtimeSnapshot,
  };

  return api;
}

// ---------------------------------------------------------------------------
// Recorded operation types
// ---------------------------------------------------------------------------

type PipelineRegisterOp = {
  kind: "pipeline.register";
  level: string;
  handler: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  options?: MiddlewareOptions;
};

type ToolsRegisterOp = {
  kind: "tools.register";
  tool: ToolDefinition;
};

type ToolsRemoveOp = {
  kind: "tools.remove";
  name: string;
};

type EventOnOp = {
  kind: "on";
  event: string;
  listener: (payload: EventPayload) => void;
};

type RecordedOp = PipelineRegisterOp | ToolsRegisterOp | ToolsRemoveOp | EventOnOp;

// ---------------------------------------------------------------------------
// registerExtensions
// ---------------------------------------------------------------------------

/**
 * Register a list of extensions against the provided infrastructure deps.
 *
 * Guarantees:
 * - Duplicate extension names → throws BEFORE calling any register()
 * - If any extension.register() throws, the error propagates and NO partial
 *   state is left in the real deps (two-phase commit: record all operations
 *   against recording wrappers first, then replay atomically only on full
 *   success)
 * - Declaration order is preserved
 */
export function registerExtensions(
  extensions: readonly Extension[],
  deps: ExtensionRegistryDeps
): void {
  // --- Step 1: Validate no duplicate names (before touching any mutable state) ---
  const seen = new Set<string>();
  for (const ext of extensions) {
    if (seen.has(ext.name)) {
      throw new Error(
        `Duplicate extension name: "${ext.name}". Each extension must have a unique name.`
      );
    }
    seen.add(ext.name);
  }

  // --- Step 2: Run all extension.register() calls against recording wrappers ---
  // All operations are captured into `pendingOps`. If any extension throws,
  // the array is discarded and the real deps remain untouched.
  const pendingOps: RecordedOp[] = [];

  // Build a simulated tool list so api.tools.list() returns consistent results
  // during the dry-run phase (reflects tools registered so far in staging).
  const stagingTools: ToolDefinition[] = [];

  const recordingDeps: ExtensionRegistryDeps = {
    ...deps,
    toolRegistry: {
      register(tool: ToolDefinition): void {
        pendingOps.push({ kind: "tools.register", tool });
        stagingTools.push(tool);
      },
      remove(name: string): void {
        pendingOps.push({ kind: "tools.remove", name });
        const idx = stagingTools.findIndex((t) => t.name === name);
        if (idx !== -1) stagingTools.splice(idx, 1);
      },
      list(): readonly ToolDefinition[] {
        // Combine already-committed tools with staged additions
        return [...deps.toolRegistry.list(), ...stagingTools];
      },
    },
    middlewareRegistry: {
      register(
        level: string,
        handler: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
        options?: MiddlewareOptions
      ): void {
        pendingOps.push({ kind: "pipeline.register", level, handler, options });
      },
      buildChain: deps.middlewareRegistry.buildChain.bind(deps.middlewareRegistry),
    } as MiddlewareRegistry,
    eventBus: {
      on(event: string, listener: (payload: EventPayload) => void): () => void {
        pendingOps.push({ kind: "on", event, listener });
        return () => {
          // no-op unsubscribe during staging
        };
      },
      emit: deps.eventBus.emit.bind(deps.eventBus),
    } as EventBus,
  };

  for (const ext of extensions) {
    const api = createExtensionApi(recordingDeps);
    ext.register(api);
  }

  // --- Step 3: All extensions succeeded — replay recorded ops on real deps ---
  for (const op of pendingOps) {
    switch (op.kind) {
      case "pipeline.register":
        deps.middlewareRegistry.register(op.level, op.handler, op.options);
        break;
      case "tools.register":
        deps.toolRegistry.register(op.tool);
        break;
      case "tools.remove":
        deps.toolRegistry.remove(op.name);
        break;
      case "on":
        (deps.eventBus as { on(event: string, listener: (payload: EventPayload) => void): void }).on(
          op.event,
          op.listener
        );
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: deep freeze
// ---------------------------------------------------------------------------

/**
 * Recursively freeze an object so that all nested properties are immutable.
 * Returns the same object (mutated in place to be frozen).
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;

  Object.freeze(obj);

  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return obj;
}

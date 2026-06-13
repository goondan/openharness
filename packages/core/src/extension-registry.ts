/**
 * Extension registration with two-phase commit + staged validation.
 *
 * Two flavors: an *agent* extension gets {@link AgentExtensionApi}
 * (turn/step/toolCall middleware, model-input assembly, tools, agent-scoped
 * events, conversation); a *connection* extension gets
 * {@link ConnectionExtensionApi} (ingress middleware, connection-scoped events)
 * and nothing else. The `scope` on {@link ExtensionRegistryDeps} selects the
 * flavor and is the boot backstop behind the compile-time method split.
 *
 * Registration is transactional. `register()` calls run against *recording*
 * deps first, so a throwing extension leaves the real registries untouched.
 * The recorded ops are then replayed into throwaway temp registries and
 * validated — this is where the boot-failure modes surface (cycle, unknown
 * ref, duplicate name, scope violation) before any real state changes. Only on
 * a clean validation are the ops committed to the real registries.
 *
 * `store` is intentionally absent from both API surfaces: it is
 * conversation-scoped and reached only via `ctx.store`, never captured at
 * register time. The core injects the per-layer scoped store at execution time
 * (see middleware-chain `wrapCtxFor`).
 */
import type {
  AgentExtension,
  AgentExtensionApi,
  ConnectionExtension,
  ConnectionExtensionApi,
  ConversationState,
  EventsApi,
  HarnessEvents,
  MiddlewareOptions,
  ModelInputMiddleware,
  RuntimeInfo,
  ToolDefinition,
} from "@goondan/openharness-types";
import { MiddlewareRegistry } from "./middleware-chain.js";
import { ModelInputRegistry } from "./model-input.js";

// ---------------------------------------------------------------------------
// Structural registry shapes
//
// Deps are described structurally so the real registry classes AND the
// recording stubs in `registerExtensions` both satisfy them.
// ---------------------------------------------------------------------------

type Handler = (
  ctx: unknown,
  next: (override?: Record<string, unknown>) => Promise<unknown>,
) => Promise<unknown>;

interface ToolRegistryLike {
  register(tool: ToolDefinition): void;
  remove(name: string): void;
  list(): readonly ToolDefinition[];
}

interface MiddlewareRegistryLike {
  register(
    level: string,
    handler: Handler,
    options?: MiddlewareOptions,
    extensionName?: string,
  ): void;
}

interface ModelInputRegistryLike {
  register(fn: ModelInputMiddleware): void;
}

interface EventBusLike {
  on(event: string, listener: (payload: unknown) => void): unknown;
  emit(event: keyof HarnessEvents, payload: never): void;
}

// ---------------------------------------------------------------------------
// Deps — discriminated union on scope
// ---------------------------------------------------------------------------

/** Infrastructure for an agent-scoped extension batch. */
export interface AgentRegistryDeps {
  scope: "agent";
  toolRegistry: ToolRegistryLike;
  eventBus: EventBusLike;
  middlewareRegistry: MiddlewareRegistryLike;
  modelInputRegistry: ModelInputRegistryLike;
  runtimeInfo: RuntimeInfo;
  conversationState: ConversationState;
}

/**
 * Infrastructure for a connection-scoped extension batch. No LLM/tool loop, so
 * no tools / model-input / conversation.
 */
export interface ConnectionRegistryDeps {
  scope: "connection";
  eventBus: EventBusLike;
  middlewareRegistry: MiddlewareRegistryLike;
  runtimeInfo: RuntimeInfo;
}

export type ExtensionRegistryDeps = AgentRegistryDeps | ConnectionRegistryDeps;

// ---------------------------------------------------------------------------
// createExtensionApi
// ---------------------------------------------------------------------------

/**
 * Build the extension-facing API for one extension from the given deps. The
 * returned surface is the {@link AgentExtensionApi} or
 * {@link ConnectionExtensionApi} flavor implied by `deps.scope`. `extensionName`
 * is the default identity for middleware diagnostics.
 */
export function createExtensionApi(
  deps: ExtensionRegistryDeps,
  extensionName: string,
): AgentExtensionApi | ConnectionExtensionApi {
  const runtimeSnapshot: RuntimeInfo = deepFreeze(
    structuredClone(deps.runtimeInfo),
  );

  // Registration-phase emits go straight to the live bus (an anti-pattern, but
  // preserved): they are not part of the transactional replay.
  const emit = (event: string, payload: unknown): void => {
    deps.eventBus.emit(event as keyof HarnessEvents, payload as never);
  };
  const events = { emit } as unknown as EventsApi;

  const on = (event: string, listener: (payload: unknown) => void): void => {
    deps.eventBus.on(event, listener);
  };

  const register = (
    level: string,
    handler: Handler,
    options?: MiddlewareOptions,
  ): void => {
    deps.middlewareRegistry.register(level, handler, options, extensionName);
  };

  if (deps.scope === "connection") {
    const api: ConnectionExtensionApi = {
      useIngress: ((mw, options) =>
        register(
          "ingress",
          mw as unknown as Handler,
          options,
        )) as ConnectionExtensionApi["useIngress"],
      on: on as ConnectionExtensionApi["on"],
      events,
      runtime: runtimeSnapshot,
    };
    return api;
  }

  const api: AgentExtensionApi = {
    useTurn: ((mw, options) =>
      register(
        "turn",
        mw as unknown as Handler,
        options,
      )) as AgentExtensionApi["useTurn"],
    useStep: ((mw, options) =>
      register(
        "step",
        mw as unknown as Handler,
        options,
      )) as AgentExtensionApi["useStep"],
    useToolCall: ((mw, options) =>
      register(
        "toolCall",
        mw as unknown as Handler,
        options,
      )) as AgentExtensionApi["useToolCall"],
    useModelInput: (mw: ModelInputMiddleware): void => {
      deps.modelInputRegistry.register(mw);
    },
    tools: {
      register(tool: ToolDefinition): void {
        deps.toolRegistry.register(tool);
      },
      remove(name: string): void {
        deps.toolRegistry.remove(name);
      },
      list(): readonly ToolDefinition[] {
        return deps.toolRegistry.list();
      },
    },
    on: on as AgentExtensionApi["on"],
    events,
    conversation: deps.conversationState,
    runtime: runtimeSnapshot,
  };
  return api;
}

// ---------------------------------------------------------------------------
// Recorded operation types
// ---------------------------------------------------------------------------

type RecordedOp =
  | {
      kind: "use";
      level: string;
      handler: Handler;
      options?: MiddlewareOptions;
      extensionName: string;
    }
  | { kind: "tools.register"; tool: ToolDefinition }
  | { kind: "tools.remove"; name: string }
  | { kind: "on"; event: string; listener: (payload: unknown) => void }
  | { kind: "modelInput.register"; fn: ModelInputMiddleware };

// ---------------------------------------------------------------------------
// registerExtensions
// ---------------------------------------------------------------------------

/**
 * Register a batch of extensions against `deps`.
 *
 * Guarantees:
 * - Duplicate extension names → throws before any `register()` runs.
 * - A throwing `extension.register()` leaves the real registries untouched
 *   (ops are recorded against stubs first).
 * - Boot-failure modes (cycle, unknown ref, scope violation, duplicate name)
 *   are caught against temp registries before any real state changes — a clean
 *   2-phase rollback.
 * - Declaration / registration order is preserved on commit.
 */
export function registerExtensions(
  extensions: readonly AgentExtension[] | readonly ConnectionExtension[],
  deps: ExtensionRegistryDeps,
): void {
  // --- Step 1: reject duplicate extension names. ---
  const seen = new Set<string>();
  for (const ext of extensions) {
    if (seen.has(ext.name)) {
      throw new Error(
        `Duplicate extension name: "${ext.name}". Each extension must have a unique name.`,
      );
    }
    seen.add(ext.name);
  }

  // --- Step 2: record ops against recording deps. ---
  const pendingOps: RecordedOp[] = [];
  const stagingTools: ToolDefinition[] = [];
  const recordingDeps = makeRecordingDeps(deps, pendingOps, stagingTools);

  for (const ext of extensions) {
    const api = createExtensionApi(recordingDeps, ext.name);
    (ext.register as (a: AgentExtensionApi | ConnectionExtensionApi) => void)(
      api,
    );
  }

  // --- Step 3: replay into temp registries and validate (no real writes). ---
  validateOps(pendingOps, deps.scope);

  // --- Step 4: commit — replay onto the real deps. ---
  replayOps(pendingOps, deps);
}

/**
 * A deps object of the same scope as `deps`, but whose registries record ops
 * instead of mutating real state. `events.emit` still binds to the live bus
 * (registration-phase emits are not transactional).
 */
function makeRecordingDeps(
  deps: ExtensionRegistryDeps,
  pendingOps: RecordedOp[],
  stagingTools: ToolDefinition[],
): ExtensionRegistryDeps {
  const middlewareRegistry: MiddlewareRegistryLike = {
    register(level, handler, options, extensionName): void {
      pendingOps.push({
        kind: "use",
        level,
        handler,
        options,
        extensionName: extensionName ?? "",
      });
    },
  };

  const eventBus: EventBusLike = {
    on(event, listener): unknown {
      pendingOps.push({ kind: "on", event, listener });
      return () => {
        /* no-op unsubscribe during staging */
      };
    },
    emit: deps.eventBus.emit.bind(deps.eventBus),
  };

  if (deps.scope === "connection") {
    return {
      scope: "connection",
      middlewareRegistry,
      eventBus,
      runtimeInfo: deps.runtimeInfo,
    };
  }

  const toolRegistry: ToolRegistryLike = {
    register(tool): void {
      pendingOps.push({ kind: "tools.register", tool });
      stagingTools.push(tool);
    },
    remove(name): void {
      pendingOps.push({ kind: "tools.remove", name });
      const idx = stagingTools.findIndex((t) => t.name === name);
      if (idx !== -1) stagingTools.splice(idx, 1);
    },
    list(): readonly ToolDefinition[] {
      return [...deps.toolRegistry.list(), ...stagingTools];
    },
  };

  const modelInputRegistry: ModelInputRegistryLike = {
    register(fn): void {
      pendingOps.push({ kind: "modelInput.register", fn });
    },
  };

  return {
    scope: "agent",
    toolRegistry,
    eventBus,
    middlewareRegistry,
    modelInputRegistry,
    runtimeInfo: deps.runtimeInfo,
    conversationState: deps.conversationState,
  };
}

/**
 * Replay the ordering-relevant ops into throwaway registries and run their boot
 * validation. The temp middleware registry's `allowedLevels` enforces the scope
 * split; its `validate()` covers cycle / unknown ref / duplicate name. The
 * model-input pipe has no ordering topology, so there is nothing to validate
 * beyond exercising registration.
 */
function validateOps(
  ops: readonly RecordedOp[],
  scope: ExtensionRegistryDeps["scope"],
): void {
  const tempMw = new MiddlewareRegistry(
    scope === "agent" ? ["turn", "step", "toolCall"] : ["ingress", "route"],
  );
  const tempModelInput = new ModelInputRegistry();

  for (const op of ops) {
    switch (op.kind) {
      case "use":
        tempMw.register(
          op.level,
          op.handler,
          op.options,
          op.extensionName || undefined,
        );
        break;
      case "modelInput.register":
        tempModelInput.register(op.fn);
        break;
      // tools.* / on are not ordering-relevant — nothing to validate.
    }
  }

  tempMw.validate();
}

/** Commit the recorded ops onto the real deps (only reached after a clean
 * {@link validateOps}). */
function replayOps(ops: readonly RecordedOp[], deps: ExtensionRegistryDeps): void {
  for (const op of ops) {
    switch (op.kind) {
      case "use":
        deps.middlewareRegistry.register(
          op.level,
          op.handler,
          op.options,
          op.extensionName || undefined,
        );
        break;
      case "on":
        deps.eventBus.on(op.event, op.listener);
        break;
      case "tools.register":
        if (deps.scope === "agent") deps.toolRegistry.register(op.tool);
        break;
      case "tools.remove":
        if (deps.scope === "agent") deps.toolRegistry.remove(op.name);
        break;
      case "modelInput.register":
        if (deps.scope === "agent") deps.modelInputRegistry.register(op.fn);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: deep freeze
// ---------------------------------------------------------------------------

/** Recursively freeze an object so all nested properties are immutable. */
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

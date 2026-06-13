/**
 * Extension registration with two-phase commit + staged validation.
 *
 * Two flavors (F5): an *agent* extension gets {@link AgentExtensionApi}
 * (turn/step/toolCall middleware, tools, recovery, prompt, agent-scoped events,
 * conversation); a *connection* extension gets {@link ConnectionExtensionApi}
 * (ingress/route middleware, connection-scoped events) and nothing else. The
 * `scope` on {@link ExtensionRegistryDeps} selects the flavor and is the boot
 * backstop behind the compile-time split.
 *
 * Registration is transactional. `register()` calls run against *recording*
 * deps first, so a throwing extension leaves the real registries untouched.
 * The recorded ops are then replayed into throwaway temp registries and
 * validated — this is where the five boot-failure modes surface (cycle,
 * unknown ref, slot miswiring, scope violation, duplicate name) before any
 * real state changes. Only on a clean validation are the ops committed to the
 * real registries.
 */
import type {
  AgentExtension,
  AgentExtensionApi,
  ConnectionExtension,
  ConnectionExtensionApi,
  ConversationState,
  EventsApi,
  HarnessEvents,
  Message,
  MiddlewareOptions,
  PromptProjection,
  PromptTransformOptions,
  PromptView,
  RecoveryApi,
  RecoveryClaimMeta,
  RecoveryClaimOptions,
  RecoveryMatcher,
  RuntimeInfo,
  StepContext,
  ToolDefinition,
} from "@goondan/openharness-types";
import { MiddlewareRegistry } from "./middleware-chain.js";
import { RecoveryRegistry } from "./recovery-registry.js";
import { PromptProjectionRegistry } from "./prompt-projection.js";

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

interface RecoveryRegistryLike {
  apiFor(extensionName: string): RecoveryApi;
}

interface PromptRegistryLike {
  transform(
    name: string,
    projection: PromptProjection,
    options?: PromptTransformOptions,
  ): void;
  apply(messages: readonly Message[], ctx: StepContext): Promise<PromptView>;
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
  recoveryRegistry: RecoveryRegistryLike;
  promptRegistry: PromptRegistryLike;
  runtimeInfo: RuntimeInfo;
  conversationState: ConversationState;
}

/** Infrastructure for a connection-scoped extension batch (no LLM/tool loop,
 * so no tools/recovery/prompt/conversation). */
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
 * is the default identity for middleware/recovery diagnostics.
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
      pipeline: {
        register: register as ConnectionExtensionApi["pipeline"]["register"],
      },
      on: on as ConnectionExtensionApi["on"],
      events,
      runtime: runtimeSnapshot,
    };
    return api;
  }

  const api: AgentExtensionApi = {
    pipeline: {
      register: register as AgentExtensionApi["pipeline"]["register"],
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
    recovery: deps.recoveryRegistry.apiFor(extensionName),
    prompt: {
      transform(
        name: string,
        projection: PromptProjection,
        options?: PromptTransformOptions,
      ): void {
        deps.promptRegistry.transform(name, projection, options);
      },
      apply(
        messages: readonly Message[],
        ctx: StepContext,
      ): Promise<PromptView> {
        return deps.promptRegistry.apply(messages, ctx);
      },
    },
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
      kind: "pipeline.register";
      level: string;
      handler: Handler;
      options?: MiddlewareOptions;
      extensionName: string;
    }
  | { kind: "tools.register"; tool: ToolDefinition }
  | { kind: "tools.remove"; name: string }
  | { kind: "on"; event: string; listener: (payload: unknown) => void }
  | {
      kind: "recovery.claim";
      matcher: RecoveryMatcher;
      options: RecoveryClaimOptions;
      meta?: RecoveryClaimMeta;
      extensionName: string;
    }
  | {
      kind: "prompt.transform";
      name: string;
      projection: PromptProjection;
      options?: PromptTransformOptions;
    };

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
 * - The five boot-failure modes (cycle, unknown ref, slot miswiring, scope
 *   violation, duplicate name) are caught against temp registries before any
 *   real state changes — a clean 2-phase rollback.
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
 * (registration-phase emits are not transactional); `prompt.apply` reads the
 * real registry so an extension can compute a view during registration.
 */
function makeRecordingDeps(
  deps: ExtensionRegistryDeps,
  pendingOps: RecordedOp[],
  stagingTools: ToolDefinition[],
): ExtensionRegistryDeps {
  const middlewareRegistry: MiddlewareRegistryLike = {
    register(level, handler, options, extensionName): void {
      pendingOps.push({
        kind: "pipeline.register",
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

  const recoveryRegistry: RecoveryRegistryLike = {
    apiFor(extensionName): RecoveryApi {
      return {
        claim(matcher, options, meta): void {
          pendingOps.push({
            kind: "recovery.claim",
            matcher,
            options,
            meta,
            extensionName,
          });
        },
      };
    },
  };

  const promptRegistry: PromptRegistryLike = {
    transform(name, projection, options): void {
      pendingOps.push({ kind: "prompt.transform", name, projection, options });
    },
    apply(messages, ctx): Promise<PromptView> {
      return deps.promptRegistry.apply(messages, ctx);
    },
  };

  return {
    scope: "agent",
    toolRegistry,
    eventBus,
    middlewareRegistry,
    recoveryRegistry,
    promptRegistry,
    runtimeInfo: deps.runtimeInfo,
    conversationState: deps.conversationState,
  };
}

/**
 * Replay the ordering-relevant ops into throwaway registries and run their boot
 * validation. The temp middleware registry's `allowedLevels` enforces the scope
 * split; its `validate()` covers cycle / unknown ref / slot miswiring /
 * duplicate name; recovery `claim` validates `attempts` on replay; prompt
 * `validate()` covers projection cycle / unknown ref.
 */
function validateOps(
  ops: readonly RecordedOp[],
  scope: ExtensionRegistryDeps["scope"],
): void {
  const tempMw = new MiddlewareRegistry(
    scope === "agent" ? ["turn", "step", "toolCall"] : ["ingress", "route"],
  );
  const tempRecovery = new RecoveryRegistry();
  const tempPrompt = new PromptProjectionRegistry();

  for (const op of ops) {
    switch (op.kind) {
      case "pipeline.register":
        tempMw.register(
          op.level,
          op.handler,
          op.options,
          op.extensionName || undefined,
        );
        break;
      case "recovery.claim":
        tempRecovery
          .apiFor(op.extensionName)
          .claim(op.matcher, op.options, op.meta);
        break;
      case "prompt.transform":
        tempPrompt.transform(op.name, op.projection, op.options);
        break;
      // tools.* / on are not ordering-relevant — nothing to validate.
    }
  }

  tempMw.validate();
  tempRecovery.validate();
  tempPrompt.validate();
}

/** Commit the recorded ops onto the real deps (only reached after a clean
 * {@link validateOps}). */
function replayOps(ops: readonly RecordedOp[], deps: ExtensionRegistryDeps): void {
  for (const op of ops) {
    switch (op.kind) {
      case "pipeline.register":
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
      case "recovery.claim":
        if (deps.scope === "agent")
          deps.recoveryRegistry
            .apiFor(op.extensionName)
            .claim(op.matcher, op.options, op.meta);
        break;
      case "prompt.transform":
        if (deps.scope === "agent")
          deps.promptRegistry.transform(op.name, op.projection, op.options);
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

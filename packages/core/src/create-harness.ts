import type {
  HarnessConfig,
  HarnessRuntime,
  Extension,
  Connector,
  RoutingRule,
  InboundEnvelope,
  RuntimeInfo,
  AgentInfo,
  ConnectionInfo,
  ToolInfo,
  ExtensionInfo,
  ModelConfig,
  EventPayload,
  DurableInboundStore,
  DurableInboundReferenceStore,
  HumanApprovalStore,
  HumanApprovalReferenceStore,
} from "@goondan/openharness-types";
import { resolveEnvDeep } from "./env.js";
import { ConfigError } from "./errors.js";
import { createLlmClient } from "./models/index.js";
import { ToolRegistry } from "./tool-registry.js";
import { EventBus } from "./event-bus.js";
import { MiddlewareRegistry } from "./middleware-chain.js";
import { registerExtensions, createExtensionApi } from "./extension-registry.js";
import { IngressPipeline } from "./ingress/pipeline.js";
import { HarnessRuntimeImpl, type AgentDeps } from "./harness-runtime.js";
import { createConversationState } from "./conversation-state.js";
import { inboundUserMessageCommitRef } from "./inbound/scheduler.js";
import { stableHash } from "./idempotency-key.js";

const DEFAULT_MAX_STEPS = 25;

function isHumanApprovalReferenceStore(
  store: HumanApprovalStore,
): store is HumanApprovalReferenceStore {
  const candidate = store as Partial<HumanApprovalReferenceStore>;
  return (
    typeof candidate.getApproval === "function" &&
    typeof candidate.getTask === "function" &&
    typeof candidate.getConversationBlocker === "function"
  );
}

function isDurableInboundReferenceStore(
  store: DurableInboundStore,
): store is DurableInboundReferenceStore {
  const candidate = store as Partial<DurableInboundReferenceStore>;
  return (
    typeof candidate.markFailed === "function" &&
    typeof candidate.releaseBlockedInboundItems === "function" &&
    typeof candidate.getInboundItem === "function"
  );
}

function requireHumanApprovalReferenceStore(
  store: HumanApprovalStore | undefined,
): HumanApprovalReferenceStore | undefined {
  if (!store) return undefined;
  if (!isHumanApprovalReferenceStore(store)) {
    throw new ConfigError(
      "humanApproval.store must implement HumanApprovalReferenceStore (getApproval, getTask, getConversationBlocker).",
    );
  }
  return store;
}

function requireDurableInboundReferenceStore(
  store: DurableInboundStore | undefined,
): DurableInboundReferenceStore | undefined {
  if (!store) return undefined;
  if (!isDurableInboundReferenceStore(store)) {
    throw new ConfigError(
      "durableInbound.store must implement DurableInboundReferenceStore (markFailed, releaseBlockedInboundItems, getInboundItem).",
    );
  }
  return store;
}

function normalizeIngressExternalId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(config: HarnessConfig): Promise<HarnessRuntime> {
  const agentDepsMap = new Map<string, AgentDeps>();
  const runtimeEventBus = new EventBus();
  const agentInfoMap: Record<string, AgentInfo> = {};
  const connectionInfoMap: Record<string, ConnectionInfo> = {};
  const agentExtensionInfoMap = new Map<string, ExtensionInfo[]>();
  const agentToolInfoMap = new Map<string, ToolInfo[]>();
  const agentMaxStepsMap = new Map<string, number>();

  // -----------------------------------------------------------------------
  // 1. Precompute runtime metadata snapshots
  // -----------------------------------------------------------------------

  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const maxSteps = agentConfig.maxSteps ?? DEFAULT_MAX_STEPS;
    const extensionInfos: ExtensionInfo[] = (agentConfig.extensions ?? []).map((e) => ({
      name: e.name,
    }));
    const toolInfos: ToolInfo[] = (agentConfig.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }));

    agentMaxStepsMap.set(agentName, maxSteps);
    agentExtensionInfoMap.set(agentName, extensionInfos);
    agentToolInfoMap.set(agentName, toolInfos);

    agentInfoMap[agentName] = {
      name: agentName,
      model: { provider: agentConfig.model.provider, model: agentConfig.model.model },
      extensionCount: extensionInfos.length,
      toolCount: toolInfos.length,
    };
  }

  if (config.connections) {
    for (const [connName, connConfig] of Object.entries(config.connections)) {
      connectionInfoMap[connName] = {
        name: connName,
        connectorName: connConfig.connector.name,
        ruleCount: connConfig.rules.length,
      };
    }
  }

  // -----------------------------------------------------------------------
  // 2. Process agents
  // -----------------------------------------------------------------------

  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    const resolvedModelConfig =
      resolveEnvDeep(agentConfig.model) as ModelConfig;

    // Create LLM client
    const llmClient = createLlmClient(
      resolvedModelConfig,
      typeof resolvedModelConfig.apiKey === "string"
        ? resolvedModelConfig.apiKey
        : undefined,
    );

    // Create per-agent infrastructure
    const toolRegistry = new ToolRegistry();
    const eventBus = new EventBus();
    eventBus.tap((payload: EventPayload) => {
      runtimeEventBus.emit(payload.type, payload);
    });
    const middlewareRegistry = new MiddlewareRegistry();
    const maxSteps = agentMaxStepsMap.get(agentName) ?? DEFAULT_MAX_STEPS;

    // Register extensions
    if (agentConfig.extensions && agentConfig.extensions.length > 0) {
      const runtimeInfo: RuntimeInfo = {
        agent: {
          name: agentName,
          model: { provider: agentConfig.model.provider, model: agentConfig.model.model },
          extensions: agentExtensionInfoMap.get(agentName) ?? [],
          tools: agentToolInfoMap.get(agentName) ?? [],
          maxSteps,
        },
        agents: agentInfoMap,
        connections: connectionInfoMap,
      };

      const conversationState = createConversationState();
      // Temporarily set _turnActive so extensions can read conversation if needed
      // (extensions only register, they don't emit events)

      registerExtensions(agentConfig.extensions, {
        toolRegistry,
        eventBus,
        middlewareRegistry,
        runtimeInfo,
        conversationState,
      });
    }

    // Register static tools from config
    if (agentConfig.tools) {
      for (const tool of agentConfig.tools) {
        toolRegistry.register(tool);
      }
    }

    agentDepsMap.set(agentName, {
      llmClient,
      toolRegistry,
      middlewareRegistry,
      eventBus,
      maxSteps,
    });
  }

  // -----------------------------------------------------------------------
  // 3. Create IngressPipeline
  // -----------------------------------------------------------------------

  const connectionsMap = new Map<
    string,
    { connector: Connector; rules: RoutingRule[]; connectionMiddleware: MiddlewareRegistry }
  >();
  const ingressEventBus = new EventBus();
  ingressEventBus.tap((payload: EventPayload) => {
    runtimeEventBus.emit(payload.type, payload);
  });

  if (config.connections) {
    for (const [connName, connConfig] of Object.entries(config.connections)) {
      const connectionMiddleware = new MiddlewareRegistry();

      // Register connection-level extensions
      if (connConfig.extensions && connConfig.extensions.length > 0) {
        const runtimeInfo: RuntimeInfo = {
          agent: {
            name: "__ingress__",
            model: { provider: "", model: "" },
            extensions: connConfig.extensions.map((e) => ({ name: e.name })),
            tools: [],
          },
          agents: agentInfoMap,
          connections: connectionInfoMap,
        };

        const conversationState = createConversationState();

        registerExtensions(connConfig.extensions, {
          toolRegistry: new ToolRegistry(),
          eventBus: ingressEventBus,
          middlewareRegistry: connectionMiddleware,
          runtimeInfo,
          conversationState,
        });
      }

      connectionsMap.set(connName, {
        connector: connConfig.connector,
        rules: connConfig.rules,
        connectionMiddleware,
      });
    }
  }

  const registeredAgents = new Set(Object.keys(config.agents));
  const durableInboundStore = requireDurableInboundReferenceStore(
    config.durableInbound?.enabled === false ? undefined : config.durableInbound?.store,
  );
  const humanApprovalStore = requireHumanApprovalReferenceStore(config.humanApproval?.store);
  if (humanApprovalStore && !durableInboundStore) {
    throw new ConfigError("humanApproval requires durableInbound.store.");
  }

  // Create the runtime first (we need a reference for dispatchTurn)
  // Build the runtime so dispatchTurn can call processTurn
  // We use a late-binding approach: create pipeline with a callback that
  // references the runtime (which is created after the pipeline).
  let runtimeRef: HarnessRuntimeImpl | null = null;

  const ingressPipeline = new IngressPipeline({
    connections: connectionsMap,
    agentMiddlewareByAgent: new Map(
      Array.from(agentDepsMap.entries()).map(([agentName, deps]) => [
        agentName,
        deps.middlewareRegistry,
      ]),
    ),
    registeredAgents,
    eventBus: ingressEventBus,
    dispatchTurn: async (turnId, agentName, envelope, conversationId) => {
      if (!runtimeRef) {
        throw new ConfigError("Runtime not yet initialized");
      }

      if (durableInboundStore) {
        const externalId = normalizeIngressExternalId(envelope.properties["id"]);
        const inboundEventIdempotencyKey = [
          "ingress",
          envelope.source.connectionName,
          agentName,
          conversationId,
          envelope.name,
          externalId ??
            stableHash({
              receivedAt: envelope.source.receivedAt,
              properties: envelope.properties ?? {},
              content: envelope.content,
            }),
        ].join(":");
        const appended = await durableInboundStore.append({
          agentName,
          conversationId,
          envelope,
          source: {
            kind: "ingress",
            connectionName: envelope.source.connectionName,
            receivedAt: envelope.source.receivedAt,
            externalId,
          },
          idempotencyKey: inboundEventIdempotencyKey,
        });
        if (appended.duplicate) {
          ingressEventBus.emit("inbound.duplicate", {
            type: "inbound.duplicate",
            inboundItemId: appended.item.id,
            agentName,
            conversationId,
            idempotencyKey: appended.item.idempotencyKey,
            status: appended.item.status,
          });
          return {
            turnId: appended.item.turnId,
            disposition: "duplicate" as const,
            inboundItemId: appended.item.id,
            blocker: appended.item.blockedBy,
          };
        }
        ingressEventBus.emit("inbound.appended", {
          type: "inbound.appended",
          inboundItemId: appended.item.id,
          agentName,
          conversationId,
          sequence: appended.item.sequence,
          idempotencyKey: appended.item.idempotencyKey,
        });

        const blocker = await humanApprovalStore?.getConversationBlocker({ agentName, conversationId });
        if (blocker) {
          const blocked = await durableInboundStore.markBlocked({
            id: appended.item.id,
            blockedBy: blocker,
          });
          ingressEventBus.emit("inbound.blocked", {
            type: "inbound.blocked",
            inboundItemId: blocked.id,
            blockedBy: blocker,
          });
          return {
            disposition: "blocked" as const,
            inboundItemId: blocked.id,
            blocker,
          };
        }

        const activeTurn = runtimeRef.getActiveTurn(agentName, conversationId);
        if (activeTurn) {
          const delivered = await runtimeRef.deliverInboundToActiveTurn(
            agentName,
            conversationId,
            envelope,
            appended.item,
          );
          if (delivered) {
            return {
              turnId: delivered.turnId,
              disposition: "delivered" as const,
              inboundItemId: delivered.item.id,
            };
          }
        }

        runtimeRef
          .dispatchTurn(agentName, envelope, { conversationId, turnId }, {
            item: appended.item,
            commitRef: inboundUserMessageCommitRef(appended.item.id),
          })
          .catch((err) => {
            ingressEventBus.emit("turn.error", {
              type: "turn.error",
              turnId,
              agentName,
              conversationId,
              status: "error",
              error: err instanceof Error ? err : new Error(String(err)),
            });
          });
        return { turnId, disposition: "started" as const, inboundItemId: appended.item.id };
      }

      const blocker = await humanApprovalStore?.getConversationBlocker({ agentName, conversationId });
      if (blocker) {
        throw new ConfigError(
          "Human Approval blocked ingress requires durableInbound.store so blocked envelopes are preserved.",
        );
      }

      const steered = runtimeRef.steerTurn(agentName, envelope, conversationId);
      if (steered) {
        return steered;
      }

      // Fire-and-forget: start turn asynchronously
      runtimeRef
        .dispatchTurn(agentName, envelope, { conversationId, turnId })
        .catch((err) => {
          ingressEventBus.emit("turn.error", {
            type: "turn.error",
            turnId,
            agentName,
            conversationId,
            status: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          });
        });
      return { turnId, disposition: "started" };
    },
  });

  const runtime = new HarnessRuntimeImpl(
    agentDepsMap,
    ingressPipeline,
    runtimeEventBus,
    durableInboundStore,
    humanApprovalStore,
    config.humanApproval?.resumeLeaseMs,
  );
  runtimeRef = runtime;

  return runtime;
}

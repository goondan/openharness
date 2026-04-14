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

const DEFAULT_MAX_STEPS = 25;

// ---------------------------------------------------------------------------
// createHarness
// ---------------------------------------------------------------------------

export async function createHarness(config: HarnessConfig): Promise<HarnessRuntime> {
  const agentDepsMap = new Map<string, AgentDeps>();
  const agentInfoMap: Record<string, AgentInfo> = {};
  const connectionInfoMap: Record<string, ConnectionInfo> = {};

  // -----------------------------------------------------------------------
  // 1. Process agents
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
    const middlewareRegistry = new MiddlewareRegistry();
    const maxSteps = agentConfig.maxSteps ?? DEFAULT_MAX_STEPS;

    // Build runtime info for extensions
    const extensionInfos: ExtensionInfo[] = (agentConfig.extensions ?? []).map((e) => ({
      name: e.name,
    }));
    const toolInfos: ToolInfo[] = (agentConfig.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }));

    // Build agent info for all agents (needed by RuntimeInfo)
    agentInfoMap[agentName] = {
      name: agentName,
      model: { provider: agentConfig.model.provider, model: agentConfig.model.model },
      extensionCount: (agentConfig.extensions ?? []).length,
      toolCount: (agentConfig.tools ?? []).length,
    };

    // Register extensions
    if (agentConfig.extensions && agentConfig.extensions.length > 0) {
      const runtimeInfo: RuntimeInfo = {
        agent: {
          name: agentName,
          model: { provider: agentConfig.model.provider, model: agentConfig.model.model },
          extensions: extensionInfos,
          tools: toolInfos,
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
  // 2. Build connection info
  // -----------------------------------------------------------------------

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
  // 3. Create IngressPipeline
  // -----------------------------------------------------------------------

  const connectionsMap = new Map<
    string,
    { connector: Connector; rules: RoutingRule[]; connectionMiddleware: MiddlewareRegistry }
  >();

  // Global agent-level middleware (shared across ingress pipeline)
  const agentMiddleware = new MiddlewareRegistry();

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
          eventBus: new EventBus(),
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

  // Create the runtime first (we need a reference for dispatchTurn)
  // Use a shared event bus for the ingress pipeline
  const ingressEventBus = new EventBus();

  // Build the runtime so dispatchTurn can call processTurn
  // We use a late-binding approach: create pipeline with a callback that
  // references the runtime (which is created after the pipeline).
  let runtimeRef: HarnessRuntimeImpl | null = null;

  const ingressPipeline = new IngressPipeline({
    connections: connectionsMap,
    agentMiddleware,
    registeredAgents,
    eventBus: ingressEventBus,
    dispatchTurn: (turnId, agentName, envelope, conversationId) => {
      if (!runtimeRef) {
        throw new ConfigError("Runtime not yet initialized");
      }
      // Fire-and-forget: start turn asynchronously
      runtimeRef
        .processTurn(agentName, envelope, { conversationId })
        .catch((err) => {
          ingressEventBus.emit("turn.error", {
            type: "turn.error",
            turnId,
            agentName,
            conversationId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        });
    },
  });

  const runtime = new HarnessRuntimeImpl(agentDepsMap, ingressPipeline);
  runtimeRef = runtime;

  return runtime;
}

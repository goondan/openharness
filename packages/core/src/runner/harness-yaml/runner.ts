import { Console } from "node:console";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import type { AgentSpec, RefOrSelector, ToolSpec } from "@goondan/openharness-types";

import { WorkspacePaths } from "../../workspace/paths.js";
import { FileWorkspaceStorage } from "../../workspace/storage.js";
import { PipelineRegistryImpl } from "../../pipeline/registry.js";
import { RUNTIME_EVENT_TYPES, RuntimeEventBusImpl } from "../../events/runtime-events.js";
import { ToolRegistryImpl, type ToolRegistry } from "../../tools/registry.js";
import { createMinimalToolContext, ToolExecutor, type ToolExecutionRequest } from "../../tools/executor.js";
import { buildToolName } from "../../tools/naming.js";
import { ExtensionApiImpl } from "../../extension/api-impl.js";
import { ExtensionStateManagerImpl } from "../../extension/state-manager.js";
import { loadExtensions, type ExtensionSpec as CoreExtensionSpec } from "../../extension/loader.js";
import { runTurn, type RunTurnModelConfig } from "../../engine/run-turn.js";

import type {
  AgentEvent,
  JsonObject,
  JsonValue,
  Message,
  MiddlewareAgentsApi,
  RuntimeContext,
  ToolCatalogItem,
  ToolHandler,
  TurnProcessor,
  TurnResult,
  RuntimeResource,
} from "../../types.js";
import { ConversationStateImpl } from "../../conversation/state.js";

import { loadHarnessYamlResources } from "./loader.js";
import {
  resolveAgentModelConfig,
  resolveRefOrSelectorList,
  selectEntryAgent,
  type AgentRuntimeResource,
  type ExtensionRuntimeResource,
  type ToolRuntimeResource,
} from "./resolve.js";

export interface CreateRunnerFromHarnessYamlOptions {
  workdir: string;
  entrypointFileName?: string;
  agentName?: string;
  instanceKey?: string;
  stateRoot?: string;
  maxSteps?: number;
  logger?: Console;
  env?: Readonly<Record<string, string | undefined>>;
  resolveSecretRef?: (secretRef: { ref: string; key: string }) => string | undefined;
}

export interface HarnessYamlRunnerTurnOutput {
  turnResult: TurnResult;
  finalResponseText: string;
  stepCount: number;
}

export interface HarnessYamlRunner {
  readonly agentName: string;
  readonly instanceKey: string;
  readonly workdir: string;
  readonly stateRoot: string;
  processTurn(text: string): Promise<HarnessYamlRunnerTurnOutput>;
  close(): Promise<void>;
}

class ManifestAwareToolExecutor extends ToolExecutor {
  constructor(
    registry: ToolRegistry,
    private readonly errorMessageLimitByToolName: Map<string, number>,
  ) {
    super(registry);
  }

  override execute(request: ToolExecutionRequest) {
    if (request.errorMessageLimit !== undefined) {
      return super.execute(request);
    }

    const limit = this.errorMessageLimitByToolName.get(request.toolName);
    if (limit === undefined) {
      return super.execute(request);
    }

    return super.execute({ ...request, errorMessageLimit: limit });
  }
}

const noopAgentsApi: MiddlewareAgentsApi = {
  async request(params) {
    return { target: params.target, response: "" };
  },
  async send() {
    return { accepted: true };
  },
};

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergeToolCatalog(primary: ToolCatalogItem[], secondary: ToolCatalogItem[]): ToolCatalogItem[] {
  const merged = [...primary];
  for (const item of secondary) {
    if (!merged.some((existing) => existing.name === item.name)) {
      merged.push(item);
    }
  }
  return merged;
}

function createSystemMessage(text: string): Message {
  return {
    id: createId("msg"),
    data: { role: "system", content: text },
    metadata: {
      pinned: true,
      "__openharness.runner.system": true,
    },
    createdAt: new Date(),
    source: { type: "system" },
  };
}

function createUserMessage(text: string): Message {
  return {
    id: createId("msg"),
    data: { role: "user", content: text },
    metadata: {},
    createdAt: new Date(),
    source: { type: "user" },
  };
}

function createToolContextMessage(content: string): Message {
  return {
    id: createId("msg"),
    data: { role: "user", content },
    metadata: {},
    createdAt: new Date(),
    source: { type: "user" },
  };
}

function isToolHandler(value: unknown): value is ToolHandler {
  return typeof value === "function";
}

function resolveToolHandler(moduleNamespace: Record<string, unknown>, exportName: string): ToolHandler | undefined {
  const direct = moduleNamespace[exportName];
  if (isToolHandler(direct)) {
    return direct;
  }

  const handlers = moduleNamespace.handlers;
  if (typeof handlers === "object" && handlers !== null) {
    const fromHandlers = (handlers as Record<string, unknown>)[exportName];
    if (isToolHandler(fromHandlers)) {
      return fromHandlers;
    }
  }

  return undefined;
}

async function ensureInstance(storage: FileWorkspaceStorage, instanceKey: string, agentName: string): Promise<void> {
  const existing = await storage.readMetadata(instanceKey);
  if (existing) {
    return;
  }
  await storage.initializeInstanceState(instanceKey, agentName);
}

function createRuntimeContext(input: {
  agentName: string;
  bundleRoot: string;
  systemPrompt: string;
  provider: string;
  modelName: string;
  inboundEvent: AgentEvent;
}): RuntimeContext {
  return {
    agent: {
      name: input.agentName,
      bundleRoot: input.bundleRoot,
      prompt: {
        system: input.systemPrompt,
      },
    },
    swarm: {
      swarmName: "default",
      entryAgent: input.agentName,
      selfAgent: input.agentName,
      availableAgents: [input.agentName],
      callableAgents: [],
    },
    inbound: {
      eventId: input.inboundEvent.id,
      eventType: input.inboundEvent.type,
      kind: "connector",
      sourceName: input.inboundEvent.source.name,
      createdAt: input.inboundEvent.createdAt.toISOString(),
      instanceKey: input.inboundEvent.instanceKey,
      properties: {},
    },
    model: {
      provider: input.provider,
      modelName: input.modelName,
    },
  };
}

function deriveWorkspaceName(workdir: string): string {
  const base = path.basename(workdir) || "default";
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value as Record<string, unknown>, key);
}

function buildDefaultToolRefs(): RefOrSelector[] {
  return [
    {
      selector: {
        kind: "Tool",
        matchLabels: {
          tier: "base",
        },
      },
    },
  ];
}

function buildDefaultExtensionRefs(resources: RuntimeResource[]): RefOrSelector[] {
  const hasContextMessage = resources.some((res) => res.kind === "Extension" && res.metadata.name === "context-message");
  return hasContextMessage ? ["Extension/context-message"] : [];
}

function selectTools(agent: AgentRuntimeResource, resources: RuntimeResource[]): ToolRuntimeResource[] {
  const toolsSpecified = hasOwnProperty(agent.spec, "tools");
  const refs = toolsSpecified ? (agent.spec.tools ?? []) : buildDefaultToolRefs();
  return resolveRefOrSelectorList(resources, refs, "Tool") as ToolRuntimeResource[];
}

function selectExtensions(agent: AgentRuntimeResource, resources: RuntimeResource[]): ExtensionRuntimeResource[] {
  const extensionsSpecified = hasOwnProperty(agent.spec, "extensions");
  const refs = extensionsSpecified ? (agent.spec.extensions ?? []) : buildDefaultExtensionRefs(resources);
  return resolveRefOrSelectorList(resources, refs, "Extension") as ExtensionRuntimeResource[];
}

async function resolveAgentSystemPrompt(agent: AgentRuntimeResource, workdir: string): Promise<string> {
  const prompt = (agent.spec as AgentSpec).prompt;
  if (!prompt) {
    return "";
  }

  if (typeof prompt.system === "string" && prompt.system.trim().length > 0) {
    return prompt.system;
  }

  if (typeof prompt.systemRef === "string" && prompt.systemRef.trim().length > 0) {
    const filePath = path.resolve(workdir, prompt.systemRef.trim());
    return await readFile(filePath, "utf8");
  }

  return "";
}

async function registerToolsFromResources(input: {
  toolResources: ToolRuntimeResource[];
  toolRegistry: ToolRegistryImpl;
}): Promise<{
  baseToolCatalog: ToolCatalogItem[];
  toolExecutor: ManifestAwareToolExecutor;
}> {
  const errorMessageLimitByToolName = new Map<string, number>();

  for (const manifest of input.toolResources) {
    const resourceName = manifest.metadata.name;
    const rootDir = manifest.__rootDir ?? path.dirname(manifest.__file);
    const entryRel = (manifest.spec as ToolSpec).entry;
    const entryAbs = path.resolve(rootDir, entryRel);
    const mod = (await import(pathToFileURL(entryAbs).href)) as Record<string, unknown>;

    const exports = (manifest.spec as ToolSpec).exports ?? [];
    for (const exp of exports) {
      const exportName = exp.name;
      const toolName = buildToolName(resourceName, exportName);

      const handler = resolveToolHandler(mod, exportName);
      if (!handler) {
        throw new Error(`tool handler export not found: ${toolName} (missing "${exportName}" in ${entryRel})`);
      }

      input.toolRegistry.register(
        {
          name: toolName,
          description: exp.description,
          parameters: exp.parameters as any,
          source: {
            type: "config",
            name: manifest.__package ?? manifest.__file,
          },
        },
        handler,
      );

      const errorMessageLimit = (manifest.spec as ToolSpec).errorMessageLimit;
      if (typeof errorMessageLimit === "number") {
        errorMessageLimitByToolName.set(toolName, errorMessageLimit);
      }
    }
  }

  const toolExecutor = new ManifestAwareToolExecutor(input.toolRegistry, errorMessageLimitByToolName);

  return {
    baseToolCatalog: input.toolRegistry.getCatalog(),
    toolExecutor,
  };
}

export async function createRunnerFromHarnessYaml(options: CreateRunnerFromHarnessYamlOptions): Promise<HarnessYamlRunner> {
  const logger = options.logger ?? new Console({ stdout: process.stdout, stderr: process.stderr });
  const workdir = path.resolve(options.workdir);

  const harnessResources = await loadHarnessYamlResources({
    workdir,
    entrypointFileName: options.entrypointFileName,
  });

  const agent = selectEntryAgent(harnessResources.resources, options.agentName);

  const systemPrompt = await resolveAgentSystemPrompt(agent, workdir);

  const modelResolved = resolveAgentModelConfig(agent, harnessResources.resources, {
    env: options.env,
    resolveSecretRef: options.resolveSecretRef,
  });

  const instanceKey = options.instanceKey ?? agent.metadata.name;
  const maxSteps = typeof options.maxSteps === "number" && Number.isFinite(options.maxSteps) ? Math.max(1, options.maxSteps) : 8;

  const workspaceName = deriveWorkspaceName(workdir);
  const paths = new WorkspacePaths({
    stateRoot: options.stateRoot,
    projectRoot: workdir,
    workspaceName,
  });

  const storage = new FileWorkspaceStorage(paths);
  await storage.initializeSystemRoot();
  await ensureInstance(storage, instanceKey, agent.metadata.name);

  const runtimeEventBus = new RuntimeEventBusImpl();
  for (const type of RUNTIME_EVENT_TYPES) {
    runtimeEventBus.on(type, async (event) => {
      await storage.appendRuntimeEvent(instanceKey, event);
    });
  }

  const pipelineRegistry = new PipelineRegistryImpl(runtimeEventBus);

  const toolRegistry = new ToolRegistryImpl();
  const toolResources = selectTools(agent, harnessResources.resources);
  const baseTools = await registerToolsFromResources({ toolResources, toolRegistry });

  const extensionToolRegistry = new ToolRegistryImpl();
  const extensionExecutor = new ToolExecutor(extensionToolRegistry);

  const extensionResources = selectExtensions(agent, harnessResources.resources);
  const hasContextMessage = extensionResources.some((ext) => ext.metadata.name === "context-message");

  const extensionNames = extensionResources.map((ext) => ext.metadata.name);
  const extensionState = new ExtensionStateManagerImpl(storage, instanceKey, extensionNames);
  await extensionState.loadAll();
  const extensionEventBus = new EventEmitter();
  let registeredTurnProcessor: TurnProcessor | undefined;
  let registeredTurnProcessorOwner: string | undefined;

  if (extensionResources.length > 0) {
    const apiFactory = (extensionName: string) => {
      return new ExtensionApiImpl(
        extensionName,
        pipelineRegistry,
        extensionToolRegistry,
        extensionState,
        extensionEventBus,
        logger,
        {
          registerTurnProcessor(ownerExtensionName, processor) {
            if (registeredTurnProcessor && registeredTurnProcessorOwner !== ownerExtensionName) {
              throw new Error(
                `turn processor already registered by extension '${registeredTurnProcessorOwner}', cannot register another from '${ownerExtensionName}'`,
              );
            }
            registeredTurnProcessor = processor;
            registeredTurnProcessorOwner = ownerExtensionName;
          },
        },
      );
    };

    await loadExtensions(
      extensionResources as unknown as Array<RuntimeResource<CoreExtensionSpec>>,
      apiFactory,
      workdir,
      logger,
    );
  }

  const conversationState = await storage.createConversationState(instanceKey);

  async function persistNewMessageEvents(startIndex: number): Promise<void> {
    const events = conversationState.events.slice(startIndex);
    for (const ev of events) {
      await storage.appendMessageEvent(instanceKey, ev);
    }
  }

  if (!hasContextMessage) {
    pipelineRegistry.register("turn", async (ctx) => {
      const hasSystem = ctx.conversationState.nextMessages.some(
        (msg) => msg.data.role === "system" && msg.metadata["__openharness.runner.system"] === true,
      );
      const runtimeSystemPrompt =
        typeof ctx.runtime.agent.prompt?.system === "string" ? ctx.runtime.agent.prompt.system : "";
      const effectiveSystemPrompt = runtimeSystemPrompt.trim().length > 0 ? runtimeSystemPrompt : systemPrompt;

      if (!hasSystem && effectiveSystemPrompt.trim().length > 0) {
        ctx.emitMessageEvent({ type: "append", message: createSystemMessage(effectiveSystemPrompt) });
      }

      const inboundInput = typeof ctx.inputEvent.input === "string" ? ctx.inputEvent.input : "";
      if (inboundInput.trim().length > 0) {
        ctx.emitMessageEvent({ type: "append", message: createUserMessage(inboundInput) });
      }

      return ctx.next();
    });
  }

  return {
    agentName: agent.metadata.name,
    instanceKey,
    workdir,
    stateRoot: paths.goondanHome,
    async processTurn(text: string): Promise<HarnessYamlRunnerTurnOutput> {
      const startedEventIndex = conversationState.events.length;

      const turnId = createId("turn");
      const traceId = createId("trace");
      const inputEvent: AgentEvent = {
        id: createId("evt"),
        type: "user.input",
        input: text,
        instanceKey,
        source: { kind: "connector", name: "cli" },
        createdAt: new Date(),
      };

      const runtime = createRuntimeContext({
        agentName: agent.metadata.name,
        bundleRoot: workdir,
        systemPrompt,
        provider: modelResolved.provider,
        modelName: modelResolved.modelName,
        inboundEvent: inputEvent,
      });

      const model: RunTurnModelConfig = {
        provider: modelResolved.provider,
        apiKey: modelResolved.apiKey,
        modelName: modelResolved.modelName,
        temperature: modelResolved.temperature,
        maxTokens: modelResolved.maxTokens,
      };

      try {
        const resolveToolCatalog = (): ToolCatalogItem[] => {
          const extensionCatalog = extensionToolRegistry.getCatalog();
          return mergeToolCatalog(baseTools.baseToolCatalog, extensionCatalog);
        };

        const runTurnWithPipeline = (core: Parameters<typeof pipelineRegistry.runTurn>[1]) => {
          return pipelineRegistry.runTurn(
            {
              agentName: agent.metadata.name,
              instanceKey,
              turnId,
              traceId,
              inputEvent,
              conversationState: conversationState as ConversationStateImpl,
              agents: noopAgentsApi,
              runtime,
              emitMessageEvent(ev) {
                conversationState.emitMessageEvent(ev);
              },
              metadata: {},
            },
            core,
          );
        };

        const runStepWithPipeline = (
          stepIndex: number,
          toolCatalog: ToolCatalogItem[],
          metadata: Record<string, JsonValue>,
          core: Parameters<typeof pipelineRegistry.runStep>[1],
        ) => {
          return pipelineRegistry.runStep(
            {
              agentName: agent.metadata.name,
              instanceKey,
              turnId,
              traceId,
              turn: {
                id: turnId,
                agentName: agent.metadata.name,
                inputEvent,
                messages: conversationState.nextMessages,
                steps: [],
                status: "running",
                metadata: {},
              },
              stepIndex,
              conversationState: conversationState as ConversationStateImpl,
              agents: noopAgentsApi,
              runtime,
              emitMessageEvent(ev) {
                conversationState.emitMessageEvent(ev);
              },
              toolCatalog,
              metadata,
            },
            core,
          );
        };

        const runToolCallWithPipeline = async (inputForToolCall: {
          stepIndex: number;
          toolCallId: string;
          toolName: string;
          args: JsonObject;
          metadata?: Record<string, JsonValue>;
          toolCatalog: ToolCatalogItem[];
        }) => {
          return pipelineRegistry.runToolCall(
            {
              agentName: agent.metadata.name,
              instanceKey,
              turnId,
              traceId,
              stepIndex: inputForToolCall.stepIndex,
              toolName: inputForToolCall.toolName,
              toolCallId: inputForToolCall.toolCallId,
              runtime,
              args: inputForToolCall.args,
              metadata: inputForToolCall.metadata ?? {},
            },
            async (toolCallCtx) => {
              const toolContext = createMinimalToolContext({
                agentName: agent.metadata.name,
                instanceKey,
                turnId,
                traceId,
                toolCallId: toolCallCtx.toolCallId,
                message: createToolContextMessage(text),
                workdir,
                logger,
                runtime: undefined,
              });

              const executor =
                extensionToolRegistry.has(toolCallCtx.toolName) === true ? extensionExecutor : baseTools.toolExecutor;

              return executor.execute({
                toolCallId: toolCallCtx.toolCallId,
                toolName: toolCallCtx.toolName,
                args: toolCallCtx.args,
                catalog: inputForToolCall.toolCatalog,
                context: toolContext,
              });
            },
          );
        };

        if (registeredTurnProcessor) {
          return await registeredTurnProcessor({
            agentName: agent.metadata.name,
            instanceKey,
            turnId,
            traceId,
            inputEvent,
            conversationState: conversationState as ConversationStateImpl,
            agents: noopAgentsApi,
            runtime,
            model,
            maxSteps,
            workdir,
            logger,
            resolveToolCatalog,
            runTurn: runTurnWithPipeline,
            runStep(inputForStep, core) {
              return runStepWithPipeline(
                inputForStep.stepIndex,
                inputForStep.toolCatalog ?? resolveToolCatalog(),
                inputForStep.metadata ?? {},
                core,
              );
            },
            runToolCall(inputForToolCall) {
              return runToolCallWithPipeline({
                ...inputForToolCall,
                toolCatalog: resolveToolCatalog(),
              });
            },
          });
        }

        const output = await runTurn({
          agentName: agent.metadata.name,
          instanceKey,
          turnId,
          traceId,
          inputEvent,
          conversationState: conversationState as ConversationStateImpl,
          pipelineRegistry,
          agents: noopAgentsApi,
          runtime,
          model,
          maxSteps,
          baseToolCatalog: baseTools.baseToolCatalog,
          extensionToolRegistry,
          extensionToolExecutor: extensionExecutor,
          toolExecutor: baseTools.toolExecutor,
          workdir,
          logger,
        });

        return {
          turnResult: output.turnResult,
          finalResponseText: output.finalResponseText,
          stepCount: output.stepCount,
        };
      } finally {
        await persistNewMessageEvents(startedEventIndex);
        await extensionState.saveAll();
      }
    },
    async close(): Promise<void> {
      await extensionState.saveAll();
    },
  };
}

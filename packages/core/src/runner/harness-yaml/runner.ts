import { Console } from "node:console";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import {
  formatObjectRef,
  parseObjectRef,
  resolveValueSource,
  type AgentSpec,
  type ConversationStore,
  type ConnectionSpec,
  type ConnectorAdapter,
  type ConnectorSpec,
  type InboundEnvelope,
  type RefOrSelector,
  type ToolSpec,
  type ValueSource,
  type WorkspacePersistence,
} from "@goondan/openharness-types";

import { normalizeWorkspaceId } from "../../workspace/paths.js";
import { FileWorkspacePersistence } from "../../workspace/persistence.js";
import { PipelineRegistryImpl } from "../../pipeline/registry.js";
import { RUNTIME_EVENT_TYPES, RuntimeEventBusImpl } from "../../events/runtime-events.js";
import { IngressRegistryImpl } from "../../ingress/registry.js";
import { ToolRegistryImpl, type ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor, type ToolExecutionRequest } from "../../tools/executor.js";
import { buildToolName } from "../../tools/naming.js";
import { ExtensionApiImpl } from "../../extension/api-impl.js";
import { ExtensionStateManagerImpl, InMemoryExtensionStateManager } from "../../extension/state-manager.js";
import { loadExtensions, type ExtensionSpec as CoreExtensionSpec } from "../../extension/loader.js";
import { runTurn, type RunTurnModelConfig } from "../../engine/run-turn.js";

import type {
  AgentEvent,
  AbortConversationInput,
  AbortConversationResult,
  IngressAcceptResult,
  IngressDispatchPlan,
  IngressRouteResolution,
  InboundContentPart,
  JsonValue,
  Message,
  RuntimeContext,
  RuntimeResource,
  ToolCatalogItem,
  ToolHandler,
  TurnResult,
} from "../../types.js";
import { ConversationStateImpl } from "../../conversation/state.js";
import { createAbortError, isAbortLikeError } from "../../utils/abort.js";

import { loadHarnessYamlResources } from "./loader.js";
import {
  resolveAgentModelConfig,
  resolveRefOrSelectorList,
  selectEntryAgent,
  type AgentRuntimeResource,
  type ConnectionRuntimeResource,
  type ConnectorRuntimeResource,
  type ExtensionRuntimeResource,
  type ToolRuntimeResource,
} from "./resolve.js";

export interface CreateHarnessRuntimeFromYamlOptions {
  workdir: string;
  entrypointFileName?: string;
  agentName?: string;
  conversationId?: string;
  stateRoot?: string;
  maxSteps?: number;
  logger?: Console;
  env?: Readonly<Record<string, string | undefined>>;
  resolveSecretRef?: (secretRef: { ref: string; key: string }) => string | undefined;
  persistence?: WorkspacePersistence;
}

export interface CreateRunnerFromHarnessYamlOptions extends CreateHarnessRuntimeFromYamlOptions {}

export interface HarnessYamlRunnerTurnOutput {
  turnResult: TurnResult;
  finalResponseText: string;
  stepCount: number;
}

export interface HarnessYamlIngressReceiveInput {
  connectionName: string;
  payload: unknown;
  receivedAt?: Date | string;
}

export interface HarnessYamlIngressDispatchInput {
  connectionName: string;
  event: InboundEnvelope;
  receivedAt?: Date | string;
}

export interface HarnessYamlIngressConnectionInfo {
  connectionName: string;
  connectorName: string;
  ruleCount: number;
}

export interface HarnessYamlIngressApi {
  receive(input: HarnessYamlIngressReceiveInput): Promise<IngressAcceptResult[]>;
  dispatch(input: HarnessYamlIngressDispatchInput): Promise<IngressAcceptResult>;
  listConnections(): HarnessYamlIngressConnectionInfo[];
}

export interface HarnessYamlRuntime {
  processTurn(text: string): Promise<HarnessYamlRunnerTurnOutput>;
  readonly ingress: HarnessYamlIngressApi;
  readonly control: {
    abortConversation(input: AbortConversationInput): Promise<AbortConversationResult>;
  };
  close(): Promise<void>;
}

export interface HarnessYamlRunner extends HarnessYamlRuntime {
  readonly conversationId: string;
}

interface LoadedConnection {
  readonly connection: ConnectionRuntimeResource;
  readonly connector: ConnectorRuntimeResource;
  readonly adapter: ConnectorAdapter;
  readonly config: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly ingressRegistry: IngressRegistryImpl;
}

interface AgentSession {
  readonly agent: AgentRuntimeResource;
  readonly conversationId: string;
  readonly systemPrompt: string;
  readonly model: RunTurnModelConfig;
  readonly pipelineRegistry: PipelineRegistryImpl;
  readonly ingressRegistry: IngressRegistryImpl;
  readonly conversationState: ConversationStateImpl;
  readonly baseToolCatalog: ToolCatalogItem[];
  readonly toolExecutor: ManifestAwareToolExecutor;
  readonly extensionToolRegistry: ToolRegistryImpl;
  readonly extensionToolExecutor: ToolExecutor;
  readonly extensionState: ExtensionStateManagerImpl;
  queue: Promise<void>;
  activeTurn:
    | {
        turnId: string;
        abortController: AbortController;
      }
    | null;
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

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSpanId(): string {
  return randomBytes(8).toString("hex");
}

function normalizeReceivedAt(value: Date | string | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function normalizeInboundContent(parts: InboundContentPart[] | undefined, fallbackText?: string): InboundContentPart[] {
  if (Array.isArray(parts) && parts.length > 0) {
    return parts;
  }

  const text = typeof fallbackText === "string" ? fallbackText.trim() : "";
  if (text.length === 0) {
    return [];
  }

  return [{ type: "text", text }];
}

function deriveInputAliasFromContent(parts: InboundContentPart[]): string | undefined {
  const texts = parts
    .filter((part): part is Extract<InboundContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0);

  if (texts.length === 0) {
    return undefined;
  }

  return texts.join("\n\n");
}

function renderInboundContent(parts: InboundContentPart[]): string {
  const textBlocks: string[] = [];
  const attachmentBlocks: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      const trimmed = part.text.trim();
      if (trimmed.length > 0) {
        textBlocks.push(trimmed);
      }
      continue;
    }

    if (part.type === "image") {
      const label = typeof part.alt === "string" && part.alt.trim().length > 0 ? ` ${part.alt.trim()}` : "";
      attachmentBlocks.push(`[image]${label} ${part.url}`.trim());
      continue;
    }

    const mimeLabel = typeof part.mimeType === "string" && part.mimeType.trim().length > 0 ? ` (${part.mimeType.trim()})` : "";
    attachmentBlocks.push(`[file] ${part.name}${mimeLabel}: ${part.url}`);
  }

  return [...textBlocks, ...attachmentBlocks].join("\n\n").trim();
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

function createUserMessage(text: string, metadata: Record<string, JsonValue> = {}): Message {
  return {
    id: createId("msg"),
    data: { role: "user", content: text },
    metadata,
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

function hasOwnProperty(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value as Record<string, unknown>, key);
}

function deriveWorkspaceName(workdir: string): string {
  const base = path.basename(workdir) || "default";
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
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

function selectConnectionIngressExtensions(
  connection: ConnectionRuntimeResource,
  resources: RuntimeResource[],
): ExtensionRuntimeResource[] {
  const refs = (connection.spec as ConnectionSpec).extensions ?? [];
  return resolveRefOrSelectorList(resources, refs, "Extension") as ExtensionRuntimeResource[];
}

function buildExtensionResourceKey(resource: ExtensionRuntimeResource): string {
  const packageName = resource.__package ?? "";
  const fileName = resource.__file ?? "";
  const configJson = JSON.stringify(resource.spec.config ?? {});
  return `${resource.metadata.name}::${packageName}::${fileName}::${configJson}`;
}

function findAgentByName(resources: RuntimeResource[], agentName: string): AgentRuntimeResource | undefined {
  return resources.find(
    (resource): resource is AgentRuntimeResource => resource.kind === "Agent" && resource.metadata.name === agentName,
  );
}

function resolveDefaultAgent(resources: RuntimeResource[], agentName: string | undefined): AgentRuntimeResource | undefined {
  if (typeof agentName === "string" && agentName.trim().length > 0) {
    return selectEntryAgent(resources, agentName);
  }

  const agents = resources.filter((resource): resource is AgentRuntimeResource => resource.kind === "Agent");
  if (agents.length === 1) {
    return agents[0];
  }

  return undefined;
}

function resolveResourceByRef<TKind extends RuntimeResource["kind"]>(
  resources: RuntimeResource[],
  ref: string | { kind: string; name: string; package?: string; apiVersion?: string },
  expectedKind: TKind,
): Extract<RuntimeResource, { kind: TKind }> | undefined {
  const parsed = parseObjectRef(ref);
  if (parsed.kind !== expectedKind) {
    throw new Error(`ref.kind 불일치: expected ${expectedKind}, got ${parsed.kind} (${formatObjectRef(ref)})`);
  }

  return resources.find((resource): resource is Extract<RuntimeResource, { kind: TKind }> => {
    if (resource.kind !== expectedKind) {
      return false;
    }
    if (resource.metadata.name !== parsed.name) {
      return false;
    }
    if (parsed.package !== undefined && resource.__package !== parsed.package) {
      return false;
    }
    if (parsed.apiVersion !== undefined && resource.apiVersion !== parsed.apiVersion) {
      return false;
    }
    return true;
  });
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

async function loadConnectionIngressExtensions(input: {
  connection: ConnectionRuntimeResource;
  resources: RuntimeResource[];
  logger: Console;
  workdir: string;
}): Promise<IngressRegistryImpl> {
  const ingressRegistry = new IngressRegistryImpl();
  const extensionResources = selectConnectionIngressExtensions(input.connection, input.resources);
  if (extensionResources.length === 0) {
    return ingressRegistry;
  }

  const pipelineRegistry = new PipelineRegistryImpl();
  const toolRegistry = new ToolRegistryImpl();
  const eventBus = new EventEmitter();
  const extensionState = new InMemoryExtensionStateManager();
  await extensionState.loadAll();

  const seen = new Set<string>();
  const dedupedResources = extensionResources.filter((resource) => {
    const key = buildExtensionResourceKey(resource);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const apiFactory = (extensionName: string) =>
    new ExtensionApiImpl(
      extensionName,
      pipelineRegistry,
      ingressRegistry,
      toolRegistry,
      extensionState,
      eventBus,
      input.logger,
    );

  await loadExtensions(
    dedupedResources as unknown as Array<RuntimeResource<CoreExtensionSpec>>,
    apiFactory,
    input.workdir,
    input.logger,
  );

  return ingressRegistry;
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

function resolveValueSourceRecord(
  valueSources: Record<string, ValueSource> | undefined,
  input: {
    env?: Readonly<Record<string, string | undefined>>;
    resolveSecretRef?: (secretRef: { ref: string; key: string }) => string | undefined;
  },
): Record<string, string> {
  if (!valueSources) {
    return {};
  }

  const resolved: Record<string, string> = {};
  for (const [key, valueSource] of Object.entries(valueSources)) {
    const value = resolveValueSource(valueSource, {
      env: input.env,
      resolveSecretRef: input.resolveSecretRef,
      required: true,
    });
    if (typeof value === "string") {
      resolved[key] = value;
    }
  }

  return resolved;
}

async function loadConnectorAdapter(connector: ConnectorRuntimeResource): Promise<ConnectorAdapter> {
  const rootDir = connector.__rootDir ?? path.dirname(connector.__file);
  const entryRel = (connector.spec as ConnectorSpec).entry;
  const entryAbs = path.resolve(rootDir, entryRel);
  const mod = (await import(pathToFileURL(entryAbs).href)) as Record<string, unknown>;

  const candidates = [
    mod.default,
    mod.adapter,
    mod.connector,
    typeof mod.normalize === "function" ? { verify: mod.verify, normalize: mod.normalize } : undefined,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as ConnectorAdapter).normalize === "function"
    ) {
      return candidate as ConnectorAdapter;
    }
  }

  throw new Error(`Connector adapter export를 찾을 수 없습니다: ${connector.metadata.name} (${entryRel})`);
}

function createDispatchIdentifiers(): {
  eventId: string;
  turnId: string;
  traceId: string;
} {
  return {
    eventId: createId("evt"),
    turnId: createId("turn"),
    traceId: createId("trace"),
  };
}

function createRuntimeContext(input: {
  agentName: string;
  bundleRoot: string;
  systemPrompt: string;
  provider: string;
  modelName: string;
  inputEvent: AgentEvent;
  connectionName?: string;
}): RuntimeContext {
  return {
    agent: {
      name: input.agentName,
      bundleRoot: input.bundleRoot,
      prompt: {
        system: input.systemPrompt,
      },
    },
    inbound: {
      eventId: input.inputEvent.id,
      eventType: input.inputEvent.type,
      kind: "connector",
      sourceName: input.inputEvent.source.name,
      connectionName: input.connectionName,
      createdAt: input.inputEvent.createdAt.toISOString(),
      conversationId: input.inputEvent.conversationId,
      properties: input.inputEvent.properties ?? {},
      content: normalizeInboundContent(input.inputEvent.content, input.inputEvent.input),
      rawPayload: input.inputEvent.rawPayload,
    },
    model: {
      provider: input.provider,
      modelName: input.modelName,
    },
  };
}

function createInputEventFromEnvelope(input: {
  eventId: string;
  traceId: string;
  envelope: InboundEnvelope;
  conversationId: string;
  receivedAt: string;
}): AgentEvent {
  const content = normalizeInboundContent(input.envelope.content);
  return {
    id: input.eventId,
    type: input.envelope.name,
    traceId: input.traceId,
    createdAt: new Date(input.receivedAt),
    metadata: input.envelope.metadata,
    input: deriveInputAliasFromContent(content),
    content,
    properties: input.envelope.properties,
    conversationId: input.conversationId,
    source: input.envelope.source,
    auth: input.envelope.auth,
    rawPayload: input.envelope.rawPayload,
  };
}

function createProcessTurnInputEvent(text: string, conversationId: string): AgentEvent {
  const trimmed = text.trim();
  const content = trimmed.length > 0 ? [{ type: "text", text: trimmed } satisfies InboundContentPart] : [];

  return {
    id: createId("evt"),
    type: "user.input",
    input: trimmed,
    content,
    properties: {},
    conversationId,
    source: { kind: "connector", name: "cli" },
    createdAt: new Date(),
  };
}

async function ensureConversation(store: ConversationStore, conversationId: string, agentName: string): Promise<void> {
  await store.ensureConversation({ conversationId, agentName });
}

function matchesIngressRule(
  event: InboundEnvelope,
  rule: NonNullable<NonNullable<ConnectionSpec["ingress"]>["rules"]>[number],
): boolean {
  if (!rule.match) {
    return true;
  }

  if (rule.match.event !== undefined && rule.match.event !== event.name) {
    return false;
  }

  const properties = rule.match.properties;
  if (!properties) {
    return true;
  }

  for (const [key, expected] of Object.entries(properties)) {
    if (event.properties[key] !== expected) {
      return false;
    }
  }

  return true;
}

function resolveConversationId(
  route: NonNullable<NonNullable<ConnectionSpec["ingress"]>["rules"]>[number]["route"],
  event: InboundEnvelope,
): string {
  if (typeof route.conversationId === "string" && route.conversationId.trim().length > 0) {
    return route.conversationId.trim();
  }

  if (typeof route.conversationIdProperty === "string" && route.conversationIdProperty.trim().length > 0) {
    const propertyValue = event.properties[route.conversationIdProperty];
    if (propertyValue === undefined) {
      throw new Error(`conversationIdProperty 값을 찾을 수 없습니다: ${route.conversationIdProperty}`);
    }

    const prefix =
      typeof route.conversationIdPrefix === "string" && route.conversationIdPrefix.length > 0 ? route.conversationIdPrefix : "";
    return `${prefix}${String(propertyValue)}`;
  }

  if (typeof event.conversationId === "string" && event.conversationId.trim().length > 0) {
    return event.conversationId.trim();
  }

  throw new Error("conversationId를 결정할 수 없습니다. route.conversationId / route.conversationIdProperty / event.conversationId 중 하나가 필요합니다.");
}

function createFallbackInboundMetadata(inputEvent: AgentEvent, runtime: RuntimeContext): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    sourceKind: runtime.inbound.kind,
    sourceName: runtime.inbound.sourceName,
    eventName: runtime.inbound.eventType,
  };

  if (typeof runtime.inbound.connectionName === "string" && runtime.inbound.connectionName.length > 0) {
    payload.connectionName = runtime.inbound.connectionName;
  }

  if (typeof runtime.inbound.conversationId === "string" && runtime.inbound.conversationId.length > 0) {
    payload.conversationId = runtime.inbound.conversationId;
  }

  if (runtime.inbound.kind === "connector") {
    if (Object.keys(runtime.inbound.properties).length > 0) {
      payload.properties = runtime.inbound.properties as unknown as JsonValue;
    }
    if (inputEvent.rawPayload !== undefined) {
      payload.rawPayload = inputEvent.rawPayload;
    }
  }

  return {
    "__openharness.runner.inbound": payload,
  };
}

function installFallbackTurnMiddleware(session: AgentSession): void {
  session.pipelineRegistry.register("turn", async (ctx) => {
    const runtimeSystemPrompt =
      typeof ctx.runtime.agent.prompt?.system === "string" ? ctx.runtime.agent.prompt.system : "";
    const effectiveSystemPrompt = runtimeSystemPrompt.trim().length > 0 ? runtimeSystemPrompt : session.systemPrompt;

    if (effectiveSystemPrompt.trim().length > 0) {
      const nextMessages = ctx.conversationState.nextMessages;
      const nonSystemMessages = nextMessages.filter((message) => message.data.role !== "system");
      const firstMessage = nextMessages[0];
      const hasTrailingSystemMessage = nextMessages.slice(1).some((message) => message.data.role === "system");
      const shouldNormalizeSystem =
        nextMessages.length !== nonSystemMessages.length + 1 ||
        firstMessage?.data.role !== "system" ||
        typeof firstMessage.data.content !== "string" ||
        firstMessage.data.content !== effectiveSystemPrompt ||
        hasTrailingSystemMessage ||
        firstMessage.metadata["__openharness.runner.system"] !== true;

      if (shouldNormalizeSystem) {
        session.conversationState.replaceBase([createSystemMessage(effectiveSystemPrompt), ...nonSystemMessages]);
      }
    }

    const content = normalizeInboundContent(ctx.inputEvent.content, ctx.inputEvent.input);
    const inboundText = renderInboundContent(content);
    if (inboundText.length > 0) {
      ctx.emitMessageEvent({
        type: "append",
        message: createUserMessage(inboundText, createFallbackInboundMetadata(ctx.inputEvent, ctx.runtime)),
      });
    }

    return ctx.next();
  });
}

export async function createHarnessRuntimeFromYaml(options: CreateHarnessRuntimeFromYamlOptions): Promise<HarnessYamlRuntime> {
  const logger = options.logger ?? new Console({ stdout: process.stdout, stderr: process.stderr });
  const workdir = path.resolve(options.workdir);

  const harnessResources = await loadHarnessYamlResources({
    workdir,
    entrypointFileName: options.entrypointFileName,
  });

  const defaultAgent = resolveDefaultAgent(harnessResources.resources, options.agentName);
  const defaultConversationId = options.conversationId ?? defaultAgent?.metadata.name ?? "default";
  const maxSteps = typeof options.maxSteps === "number" && Number.isFinite(options.maxSteps) ? Math.max(1, options.maxSteps) : 8;

  const workspaceName = deriveWorkspaceName(workdir);
  const workspaceId = normalizeWorkspaceId(workspaceName);
  const persistence =
    options.persistence ??
    new FileWorkspacePersistence({
      stateRoot: options.stateRoot,
      projectRoot: workdir,
      workspaceName,
    });
  if (persistence instanceof FileWorkspacePersistence) {
    await persistence.initialize();
  }
  const conversations = persistence.conversations;
  const runtimeEvents = persistence.runtimeEvents;

  const runtimeEventBus = new RuntimeEventBusImpl();
  for (const type of RUNTIME_EVENT_TYPES) {
    runtimeEventBus.on(type, async (event) => {
      await runtimeEvents.append({
        records: [
          {
            workspaceId,
            conversationId: typeof event.conversationId === "string" && event.conversationId.length > 0 ? event.conversationId : undefined,
            event,
          },
        ],
      });
    });
  }

  const sessionCache = new Map<string, Promise<AgentSession>>();
  const pendingTurns = new Set<Promise<unknown>>();

  async function createAgentSession(agent: AgentRuntimeResource, conversationId: string): Promise<AgentSession> {
    await ensureConversation(conversations, conversationId, agent.metadata.name);

    const systemPrompt = await resolveAgentSystemPrompt(agent, workdir);
    const modelResolved = resolveAgentModelConfig(agent, harnessResources.resources, {
      env: options.env,
      resolveSecretRef: options.resolveSecretRef,
    });

    const pipelineRegistry = new PipelineRegistryImpl(runtimeEventBus);
    const ingressRegistry = new IngressRegistryImpl();

    const toolRegistry = new ToolRegistryImpl();
    const toolResources = selectTools(agent, harnessResources.resources);
    const baseTools = await registerToolsFromResources({ toolResources, toolRegistry });

    const extensionToolRegistry = new ToolRegistryImpl();
    const extensionToolExecutor = new ToolExecutor(extensionToolRegistry);

    const extensionResources = selectExtensions(agent, harnessResources.resources);
    const hasContextMessage = extensionResources.some((ext) => ext.metadata.name === "context-message");

    const extensionNames = extensionResources.map((ext) => ext.metadata.name);
    const extensionState = new ExtensionStateManagerImpl(
      {
        readExtensionState: async (extensionConversationId, extensionName) =>
          (await conversations.readExtensionState({
            conversationId: extensionConversationId,
            extensionName,
          })) ?? undefined,
        writeExtensionState: async (extensionConversationId, extensionName, state) => {
          await conversations.writeExtensionState({
            conversationId: extensionConversationId,
            extensionName,
            value: state,
          });
        },
      },
      conversationId,
      extensionNames,
    );
    await extensionState.loadAll();

    const extensionEventBus = new EventEmitter();
    if (extensionResources.length > 0) {
      const apiFactory = (extensionName: string) =>
        new ExtensionApiImpl(
          extensionName,
          pipelineRegistry,
          ingressRegistry,
          extensionToolRegistry,
          extensionState,
          extensionEventBus,
          logger,
        );

      await loadExtensions(
        extensionResources as unknown as Array<RuntimeResource<CoreExtensionSpec>>,
        apiFactory,
        workdir,
        logger,
      );
    }

    const loadedConversation = await conversations.loadState({ conversationId });
    const conversationState = new ConversationStateImpl(loadedConversation.baseMessages, loadedConversation.events);

    const session: AgentSession = {
      agent,
      conversationId,
      systemPrompt,
      model: {
        provider: modelResolved.provider,
        apiKey: modelResolved.apiKey,
        modelName: modelResolved.modelName,
        temperature: modelResolved.temperature,
        maxTokens: modelResolved.maxTokens,
      },
      pipelineRegistry,
      ingressRegistry,
      conversationState,
      baseToolCatalog: baseTools.baseToolCatalog,
      toolExecutor: baseTools.toolExecutor,
      extensionToolRegistry,
      extensionToolExecutor,
      extensionState,
      queue: Promise.resolve(),
      activeTurn: null,
    };

    if (!hasContextMessage) {
      installFallbackTurnMiddleware(session);
    }

    return session;
  }

  async function getOrCreateSession(agentName: string, conversationId: string): Promise<AgentSession> {
    const cacheKey = `${agentName}::${conversationId}`;
    const existing = sessionCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const agent = findAgentByName(harnessResources.resources, agentName);
    if (!agent) {
      throw new Error(`Agent 리소스를 찾을 수 없습니다: ${agentName}`);
    }

    const created = createAgentSession(agent, conversationId);
    sessionCache.set(cacheKey, created);

    try {
      return await created;
    } catch (error) {
      sessionCache.delete(cacheKey);
      throw error;
    }
  }

  async function persistSessionMessageEvents(session: AgentSession, startIndex: number): Promise<void> {
    const events = session.conversationState.events.slice(startIndex);
    if (events.length === 0) {
      return;
    }
    await conversations.appendMessageEvents({
      conversationId: session.conversationId,
      events,
    });
  }

  async function executeTurn(session: AgentSession, inputEvent: AgentEvent, runtime: RuntimeContext, turnId: string, traceId: string): Promise<HarnessYamlRunnerTurnOutput> {
    const startedEventIndex = session.conversationState.events.length;
    const abortController = new AbortController();
    session.activeTurn = {
      turnId,
      abortController,
    };
    await conversations.updateStatus({
      conversationId: session.conversationId,
      status: "processing",
    });

    try {
      const output = await runTurn({
        agentName: session.agent.metadata.name,
        conversationId: session.conversationId,
        turnId,
        traceId,
        inputEvent,
        conversationState: session.conversationState,
        pipelineRegistry: session.pipelineRegistry,
        runtime,
        model: session.model,
        maxSteps,
        baseToolCatalog: session.baseToolCatalog,
        extensionToolRegistry: session.extensionToolRegistry,
        extensionToolExecutor: session.extensionToolExecutor,
        toolExecutor: session.toolExecutor,
        workdir,
        logger,
        abortSignal: abortController.signal,
      });

      return {
        turnResult: output.turnResult,
        finalResponseText: output.finalResponseText,
        stepCount: output.stepCount,
      };
    } finally {
      if (session.activeTurn?.turnId === turnId) {
        session.activeTurn = null;
      }
      await persistSessionMessageEvents(session, startedEventIndex);
      await session.extensionState.saveAll();
      await conversations.updateStatus({
        conversationId: session.conversationId,
        status: "idle",
      });
    }
  }

  function queueSessionTurn<T>(session: AgentSession, work: () => Promise<T>): Promise<T> {
    const scheduled = session.queue.catch(() => undefined).then(work);
    session.queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  function trackPendingTurn<T>(promise: Promise<T>): Promise<T> {
    pendingTurns.add(promise);
    promise.finally(() => {
      pendingTurns.delete(promise);
    }).catch(() => {
      // noop: caller 또는 background task가 별도로 처리한다.
    });
    return promise;
  }

  const loadedConnections = await (async (): Promise<Map<string, LoadedConnection>> => {
    const map = new Map<string, LoadedConnection>();
    const connections = harnessResources.resources.filter(
      (resource): resource is ConnectionRuntimeResource => resource.kind === "Connection",
    );

    for (const connection of connections) {
      const connector = resolveResourceByRef(
        harnessResources.resources,
        (connection.spec as ConnectionSpec).connectorRef,
        "Connector",
      );

      if (!connector) {
        throw new Error(
          `Connection.connectorRef가 가리키는 Connector 리소스를 찾을 수 없습니다: ${formatObjectRef(
            (connection.spec as ConnectionSpec).connectorRef,
          )}\n- Connection: ${connection.metadata.name}`,
        );
      }

      const adapter = await loadConnectorAdapter(connector);
      const config = resolveValueSourceRecord((connection.spec as ConnectionSpec).config as Record<string, ValueSource> | undefined, {
        env: options.env,
        resolveSecretRef: options.resolveSecretRef,
      });
      const secrets = resolveValueSourceRecord((connection.spec as ConnectionSpec).secrets as Record<string, ValueSource> | undefined, {
        env: options.env,
        resolveSecretRef: options.resolveSecretRef,
      });
      const ingressRegistry = await loadConnectionIngressExtensions({
        connection,
        resources: harnessResources.resources,
        logger,
        workdir,
      });

      map.set(connection.metadata.name, {
        connection,
        connector,
        adapter,
        config,
        secrets,
        ingressRegistry,
      });
    }

    return map;
  })();

  function getLoadedConnection(connectionName: string): LoadedConnection {
    const connection = loadedConnections.get(connectionName);
    if (!connection) {
      throw new Error(`Connection 리소스를 찾을 수 없습니다: ${connectionName}`);
    }
    return connection;
  }

  async function emitIngressReceived(input: {
    connectionName: string;
    connectorName: string;
    eventId: string;
    traceId: string;
  }): Promise<void> {
    await runtimeEventBus.emit({
      type: "ingress.received",
      connectionName: input.connectionName,
      connectorName: input.connectorName,
      eventId: input.eventId,
      traceId: input.traceId,
      spanId: createSpanId(),
      timestamp: new Date().toISOString(),
    });
  }

  async function emitIngressRejected(input: {
    connectionName: string;
    connectorName: string;
    eventId: string;
    traceId: string;
    error: unknown;
    eventName?: string;
    turnId?: string;
    agentName?: string;
    conversationId?: string;
  }): Promise<void> {
    const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
    const errorCode = input.error instanceof Error ? (input.error as { code?: string }).code : undefined;

    await runtimeEventBus.emit({
      type: "ingress.rejected",
      connectionName: input.connectionName,
      connectorName: input.connectorName,
      eventId: input.eventId,
      eventName: input.eventName,
      turnId: input.turnId,
      errorMessage,
      errorCode,
      agentName: input.agentName,
      conversationId: input.conversationId,
      traceId: input.traceId,
      spanId: createSpanId(),
      timestamp: new Date().toISOString(),
    });
  }

  async function resolveRoute(
    connection: LoadedConnection,
    event: InboundEnvelope,
  ): Promise<IngressRouteResolution> {
    const ingressRules = (connection.connection.spec as ConnectionSpec).ingress?.rules ?? [];
    if (ingressRules.length === 0) {
      throw new Error(`Connection.ingress.rules가 비어 있습니다: ${connection.connection.metadata.name}`);
    }

    for (let index = 0; index < ingressRules.length; index += 1) {
      const rule = ingressRules[index];
      if (!rule || !matchesIngressRule(event, rule)) {
        continue;
      }

      if (!rule.route.agentRef) {
        throw new Error(`Connection.ingress.rules[${index}]에 route.agentRef가 필요합니다.`);
      }

      const agentRef = parseObjectRef(rule.route.agentRef);
      if (agentRef.kind !== "Agent") {
        throw new Error(`Connection.ingress.rules[${index}].route.agentRef는 Agent를 가리켜야 합니다.`);
      }

      return {
        connectionName: connection.connection.metadata.name,
        connectorName: connection.connector.metadata.name,
        ruleIndex: index,
        agentName: agentRef.name,
        conversationId: resolveConversationId(rule.route, event),
        event,
      };
    }

    throw new Error(`Ingress rule과 매칭되는 경로를 찾을 수 없습니다: connection=${connection.connection.metadata.name}, event=${event.name}`);
  }

  async function dispatchPreparedPlan(plan: IngressDispatchPlan): Promise<IngressAcceptResult> {
    const session = await getOrCreateSession(plan.agentName, plan.conversationId);
    const queuedTurn = trackPendingTurn(
      queueSessionTurn(session, async () => {
        await executeTurn(session, plan.inputEvent, plan.runtime, plan.turnId, plan.traceId);
      }),
    );

    queuedTurn.catch(async (error) => {
      if (isAbortLikeError(error)) {
        return;
      }
      await emitIngressRejected({
        connectionName: plan.connectionName,
        connectorName: plan.connectorName,
        eventId: plan.eventId,
        traceId: plan.traceId,
        error,
        eventName: plan.event.name,
        turnId: plan.turnId,
        agentName: plan.agentName,
        conversationId: plan.conversationId,
      });
    });

    const accepted: IngressAcceptResult = {
      accepted: true,
      connectionName: plan.connectionName,
      connectorName: plan.connectorName,
      agentName: plan.agentName,
      conversationId: plan.conversationId,
      eventId: plan.eventId,
      eventName: plan.event.name,
      turnId: plan.turnId,
      traceId: plan.traceId,
    };

    await runtimeEventBus.emit({
      type: "ingress.accepted",
      connectionName: plan.connectionName,
      connectorName: plan.connectorName,
      eventId: plan.eventId,
      eventName: plan.event.name,
      turnId: plan.turnId,
      accepted: true,
      agentName: plan.agentName,
      conversationId: plan.conversationId,
      traceId: plan.traceId,
      spanId: createSpanId(),
      timestamp: new Date().toISOString(),
    });

    return accepted;
  }

  async function buildDispatchPlan(
    connection: LoadedConnection,
    route: IngressRouteResolution,
    receivedAt: string,
    ids: {
      eventId: string;
      turnId: string;
      traceId: string;
    },
  ): Promise<IngressDispatchPlan> {
    const inputEvent = createInputEventFromEnvelope({
      eventId: ids.eventId,
      traceId: ids.traceId,
      envelope: route.event,
      conversationId: route.conversationId,
      receivedAt,
    });

    const session = await getOrCreateSession(route.agentName, route.conversationId);
    return {
      connectionName: connection.connection.metadata.name,
      connectorName: connection.connector.metadata.name,
      agentName: route.agentName,
      conversationId: route.conversationId,
      event: route.event,
      eventId: ids.eventId,
      turnId: ids.turnId,
      traceId: ids.traceId,
      inputEvent,
      runtime: createRuntimeContext({
        agentName: route.agentName,
        bundleRoot: workdir,
        systemPrompt: session.systemPrompt,
        provider: session.model.provider,
        modelName: session.model.modelName,
        inputEvent,
        connectionName: connection.connection.metadata.name,
      }),
    };
  }

  async function runVerify(connection: LoadedConnection, payload: unknown, receivedAt: string): Promise<void> {
    await connection.ingressRegistry.runVerify(
      {
        connectionName: connection.connection.metadata.name,
        connectorName: connection.connector.metadata.name,
        payload,
        config: connection.config,
        secrets: connection.secrets,
        receivedAt,
        metadata: {},
      },
      async () => {
        if (typeof connection.adapter.verify === "function") {
          await connection.adapter.verify({
            payload,
            connectionName: connection.connection.metadata.name,
            config: connection.config,
            secrets: connection.secrets,
            logger,
            receivedAt,
          });
        }
      },
    );
  }

  async function runNormalize(connection: LoadedConnection, payload: unknown, receivedAt: string): Promise<InboundEnvelope[]> {
    return await connection.ingressRegistry.runNormalize(
      {
        connectionName: connection.connection.metadata.name,
        connectorName: connection.connector.metadata.name,
        payload,
        config: connection.config,
        secrets: connection.secrets,
        receivedAt,
        metadata: {},
      },
      async () => {
        const result = await connection.adapter.normalize({
          payload,
          connectionName: connection.connection.metadata.name,
          config: connection.config,
          secrets: connection.secrets,
          logger,
          receivedAt,
        });
        return Array.isArray(result) ? result : [result];
      },
    );
  }

  async function runRoute(connection: LoadedConnection, event: InboundEnvelope): Promise<IngressRouteResolution> {
    const initial = await resolveRoute(connection, event);
    const session = await getOrCreateSession(initial.agentName, initial.conversationId);

    return await session.ingressRegistry.runRoute(
      {
        connectionName: connection.connection.metadata.name,
        connectorName: connection.connector.metadata.name,
        event,
        metadata: {},
      },
      async () => initial,
    );
  }

  async function runDispatch(plan: IngressDispatchPlan): Promise<IngressAcceptResult> {
    const session = await getOrCreateSession(plan.agentName, plan.conversationId);
    return await session.ingressRegistry.runDispatch(
      {
        plan,
        metadata: {},
      },
      async (ctx) => dispatchPreparedPlan(ctx.plan),
    );
  }

  const ingress: HarnessYamlIngressApi = {
    async receive(input): Promise<IngressAcceptResult[]> {
      const connection = getLoadedConnection(input.connectionName);
      const receivedAt = normalizeReceivedAt(input.receivedAt);
      const requestEventId = createId("ingress");
      const requestTraceId = createId("trace");

      await emitIngressReceived({
        connectionName: connection.connection.metadata.name,
        connectorName: connection.connector.metadata.name,
        eventId: requestEventId,
        traceId: requestTraceId,
      });

      try {
        await runVerify(connection, input.payload, receivedAt);
        const normalized = await runNormalize(connection, input.payload, receivedAt);

        const accepted: IngressAcceptResult[] = [];
        for (const event of normalized) {
          const result = await ingress.dispatch({
            connectionName: input.connectionName,
            event,
            receivedAt,
          });
          accepted.push(result);
        }

        return accepted;
      } catch (error) {
        await emitIngressRejected({
          connectionName: connection.connection.metadata.name,
          connectorName: connection.connector.metadata.name,
          eventId: requestEventId,
          traceId: requestTraceId,
          error,
        });
        throw error;
      }
    },
    async dispatch(input): Promise<IngressAcceptResult> {
      const connection = getLoadedConnection(input.connectionName);
      const receivedAt = normalizeReceivedAt(input.receivedAt);
      const ids = createDispatchIdentifiers();
      let routeResolution: IngressRouteResolution | undefined;
      let plan: IngressDispatchPlan | undefined;

      await emitIngressReceived({
        connectionName: connection.connection.metadata.name,
        connectorName: connection.connector.metadata.name,
        eventId: ids.eventId,
        traceId: ids.traceId,
      });

      try {
        routeResolution = await runRoute(connection, input.event);
        plan = await buildDispatchPlan(connection, routeResolution, receivedAt, ids);
        return await runDispatch(plan);
      } catch (error) {
        await emitIngressRejected({
          connectionName: connection.connection.metadata.name,
          connectorName: connection.connector.metadata.name,
          eventId: ids.eventId,
          traceId: ids.traceId,
          error,
          eventName: input.event.name,
          turnId: plan?.turnId,
          agentName: routeResolution?.agentName ?? plan?.agentName,
          conversationId: routeResolution?.conversationId ?? plan?.conversationId,
        });
        throw error;
      }
    },
    listConnections(): HarnessYamlIngressConnectionInfo[] {
      return [...loadedConnections.values()].map((item) => ({
        connectionName: item.connection.metadata.name,
        connectorName: item.connector.metadata.name,
        ruleCount: (item.connection.spec as ConnectionSpec).ingress?.rules?.length ?? 0,
      }));
    },
  };

  const control = {
    async abortConversation(input: AbortConversationInput): Promise<AbortConversationResult> {
      const settled = await Promise.allSettled([...sessionCache.values()].map(async (sessionPromise) => await sessionPromise));
      const sessions = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      const matchedSessions = sessions.filter((session) => {
        if (session.conversationId !== input.conversationId) {
          return false;
        }
        if (typeof input.agentName === "string" && input.agentName.length > 0) {
          return session.agent.metadata.name === input.agentName;
        }
        return true;
      });

      let abortedTurns = 0;
      for (const session of matchedSessions) {
        const activeTurn = session.activeTurn;
        if (!activeTurn || activeTurn.abortController.signal.aborted) {
          continue;
        }

        activeTurn.abortController.abort(createAbortError(input.reason));
        abortedTurns += 1;
      }

      return {
        conversationId: input.conversationId,
        agentNames: [...new Set(matchedSessions.map((session) => session.agent.metadata.name))],
        matchedSessions: matchedSessions.length,
        abortedTurns,
        reason: input.reason,
      };
    },
  };

  return {
    async processTurn(text: string): Promise<HarnessYamlRunnerTurnOutput> {
      if (!defaultAgent) {
        throw new Error("기본 Agent를 결정할 수 없습니다. processTurn을 사용하려면 --agent 또는 단일 Agent 리소스가 필요합니다.");
      }

      const session = await getOrCreateSession(defaultAgent.metadata.name, defaultConversationId);
      const inputEvent = createProcessTurnInputEvent(text, defaultConversationId);
      const turnId = createId("turn");
      const traceId = createId("trace");
      const runtime = createRuntimeContext({
        agentName: defaultAgent.metadata.name,
        bundleRoot: workdir,
        systemPrompt: session.systemPrompt,
        provider: session.model.provider,
        modelName: session.model.modelName,
        inputEvent,
        connectionName: "cli",
      });

      return await trackPendingTurn(
        queueSessionTurn(session, async () => executeTurn(session, inputEvent, runtime, turnId, traceId)),
      );
    },
    ingress,
    control,
    async close(): Promise<void> {
      const settledSessions = await Promise.allSettled([...sessionCache.values()]);
      for (const settled of settledSessions) {
        if (settled.status !== "fulfilled") {
          continue;
        }
        const activeTurn = settled.value.activeTurn;
        if (activeTurn && !activeTurn.abortController.signal.aborted) {
          activeTurn.abortController.abort(createAbortError("Harness runtime closed"));
        }
      }

      await Promise.allSettled([...pendingTurns]);
      for (const settled of settledSessions) {
        if (settled.status === "fulfilled") {
          await settled.value.extensionState.saveAll();
        }
      }
    },
  };
}

export async function createRunnerFromHarnessYaml(options: CreateRunnerFromHarnessYamlOptions): Promise<HarnessYamlRunner> {
  const runtime = await createHarnessRuntimeFromYaml(options);
  const workdir = path.resolve(options.workdir);
  const harnessResources = await loadHarnessYamlResources({
    workdir,
    entrypointFileName: options.entrypointFileName,
  });
  const agent = selectEntryAgent(harnessResources.resources, options.agentName);
  const conversationId = options.conversationId ?? agent.metadata.name;

  return {
    conversationId,
    processTurn: runtime.processTurn,
    ingress: runtime.ingress,
    control: runtime.control,
    close: runtime.close,
  };
}

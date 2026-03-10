import { describe, it, expect, beforeEach } from "vitest";
import { loadExtensions, type ExtensionSpec } from "./loader.js";
import type {
  ExtensionApi,
  RuntimeContext,
  RuntimeResource,
  TurnResult,
  JsonValue,
} from "../types.js";
import { PipelineRegistryImpl } from "../pipeline/registry.js";
import { IngressRegistryImpl } from "../ingress/registry.js";
import { ToolRegistryImpl } from "../tools/registry.js";
import { ExtensionStateManagerImpl } from "./state-manager.js";
import { ExtensionApiImpl } from "./api-impl.js";
import { FileWorkspaceStorage } from "../workspace/storage.js";
import { WorkspacePaths } from "../workspace/paths.js";
import { RuntimeEventBusImpl } from "../events/runtime-events.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function createRuntimeContext(agentName: string): RuntimeContext {
  return {
    agent: {
      name: agentName,
      bundleRoot: "/tmp",
    },
    inbound: {
      eventId: "evt-1",
      eventType: "user.input",
      kind: "connector",
      sourceName: "cli",
      createdAt: new Date().toISOString(),
      properties: {},
      content: [],
    },
  };
}

describe("Extension Integration", () => {
  let tempDir: string;
  let storage: FileWorkspaceStorage;
  let pipelineRegistry: PipelineRegistryImpl;
  let ingressRegistry: IngressRegistryImpl;
  let toolRegistry: ToolRegistryImpl;
  let eventBus: EventEmitter;
  let runtimeEventBus: RuntimeEventBusImpl;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ext-integration-test-"));
    const paths = new WorkspacePaths({
      stateRoot: tempDir,
      projectRoot: tempDir,
    });
    storage = new FileWorkspaceStorage(paths);
    await storage.initializeSystemRoot();
    await storage.initializeInstanceState("test-instance", "test-agent");

    runtimeEventBus = new RuntimeEventBusImpl();
    pipelineRegistry = new PipelineRegistryImpl(runtimeEventBus);
    ingressRegistry = new IngressRegistryImpl();
    toolRegistry = new ToolRegistryImpl();
    eventBus = new EventEmitter();
  });

  it("should load logging extension from base package", async () => {
    const baseExtensionPath = path.resolve(
      path.dirname(import.meta.url.replace("file://", "")),
      "../../../base/src/extensions/logging.ts",
    );

    const extensionExists = await fs
      .access(baseExtensionPath)
      .then(() => true)
      .catch(() => false);

    if (!extensionExists) {
      console.warn("Skipping test: base logging extension not found");
      return;
    }

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "logging" },
        spec: {
          entry: baseExtensionPath,
          config: {
            level: "info",
            includeToolArgs: true,
          },
        },
        __file: "test.yaml",
        __docIndex: 0,
      },
    ];

    const apiFactory = (name: string): ExtensionApi => {
      const stateManager = new ExtensionStateManagerImpl(storage, "test-instance", [name]);
      return new ExtensionApiImpl(name, pipelineRegistry, ingressRegistry, toolRegistry, stateManager, eventBus, console);
    };

    await loadExtensions(resources, apiFactory, tempDir, console);
  });

  it("should run middleware registered by extension", async () => {
    const extDir = path.join(tempDir, "extensions");
    await fs.mkdir(extDir, { recursive: true });

    const extPath = path.join(extDir, "test-middleware.ts");
    await fs.writeFile(
      extPath,
      `
      export function register(api) {
        api.pipeline.register('turn', async (ctx) => {
          ctx.metadata.extensionRan = true;
          return ctx.next();
        });
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "test-middleware" },
        spec: { entry: "./test-middleware.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: extDir,
      },
    ];

    const apiFactory = (name: string): ExtensionApi => {
      const stateManager = new ExtensionStateManagerImpl(storage, "test-instance", [name]);
      return new ExtensionApiImpl(name, pipelineRegistry, ingressRegistry, toolRegistry, stateManager, eventBus, console);
    };

    await loadExtensions(resources, apiFactory, tempDir, console);

    const metadata: Record<string, JsonValue> = {};
    const conversationState = await storage.createConversationState("test-instance");

    await pipelineRegistry.runTurn(
      {
        agentName: "test-agent",
        conversationId: "test-instance",
        turnId: "turn-1",
        traceId: "trace-1",
        inputEvent: {
          id: "evt-1",
          type: "user.input",
          input: "hello",
          source: { kind: "connector", name: "cli" },
          createdAt: new Date(),
        },
        conversationState,
        runtime: createRuntimeContext("test-agent"),
        emitMessageEvent: () => {},
        metadata,
      },
      async () => {
        return {
          turnId: "turn-1",
          finishReason: "text_response",
        };
      },
    );

    expect(metadata.extensionRan).toBe(true);
  });

  it("should emit runtime events through pipeline", async () => {
    const events: string[] = [];

    runtimeEventBus.on("turn.started", (event) => {
      events.push(`turn.started:${event.turnId}`);
    });

    runtimeEventBus.on("turn.completed", (event) => {
      events.push(`turn.completed:${event.turnId}`);
    });

    const conversationState = await storage.createConversationState("test-instance");

    await pipelineRegistry.runTurn(
      {
        agentName: "test-agent",
        conversationId: "test-instance",
        turnId: "turn-1",
        traceId: "trace-1",
        inputEvent: {
          id: "evt-1",
          type: "user.input",
          input: "hello",
          source: { kind: "connector", name: "cli" },
          createdAt: new Date(),
        },
        conversationState,
        runtime: createRuntimeContext("test-agent"),
        emitMessageEvent: () => {},
        metadata: {},
      },
      async (): Promise<TurnResult> => {
        return {
          turnId: "turn-1",
          finishReason: "text_response",
        };
      },
    );

    expect(events).toEqual(["turn.started:turn-1", "turn.completed:turn-1"]);
  });

  it("should persist extension state across turns", async () => {
    const extDir = path.join(tempDir, "extensions");
    await fs.mkdir(extDir, { recursive: true });

    const extPath = path.join(extDir, "stateful-ext.ts");
    await fs.writeFile(
      extPath,
      `
      export function register(api) {
        api.pipeline.register('turn', async (ctx) => {
          const state = await api.state.get() ?? { count: 0 };
          const newCount = state.count + 1;
          await api.state.set({ count: newCount });
          ctx.metadata.turnCount = newCount;
          return ctx.next();
        });
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "stateful-ext" },
        spec: { entry: "./stateful-ext.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: extDir,
      },
    ];

    const stateManager = new ExtensionStateManagerImpl(storage, "test-instance", ["stateful-ext"]);
    await stateManager.loadAll();

    const apiFactory = (name: string): ExtensionApi => {
      return new ExtensionApiImpl(name, pipelineRegistry, ingressRegistry, toolRegistry, stateManager, eventBus, console);
    };

    await loadExtensions(resources, apiFactory, tempDir, console);

    const conversationState = await storage.createConversationState("test-instance");

    const metadata1: Record<string, JsonValue> = {};
    await pipelineRegistry.runTurn(
      {
        agentName: "test-agent",
        conversationId: "test-instance",
        turnId: "turn-1",
        traceId: "trace-1",
        inputEvent: {
          id: "evt-1",
          type: "user.input",
          input: "hello",
          source: { kind: "connector", name: "cli" },
          createdAt: new Date(),
        },
        conversationState,
        runtime: createRuntimeContext("test-agent"),
        emitMessageEvent: () => {},
        metadata: metadata1,
      },
      async () => ({ turnId: "turn-1", finishReason: "text_response" as const }),
    );

    await stateManager.saveAll();

    const metadata2: Record<string, JsonValue> = {};
    await pipelineRegistry.runTurn(
      {
        agentName: "test-agent",
        conversationId: "test-instance",
        turnId: "turn-2",
        traceId: "trace-2",
        inputEvent: {
          id: "evt-2",
          type: "user.input",
          input: "hello again",
          source: { kind: "connector", name: "cli" },
          createdAt: new Date(),
        },
        conversationState,
        runtime: createRuntimeContext("test-agent"),
        emitMessageEvent: () => {},
        metadata: metadata2,
      },
      async () => ({ turnId: "turn-2", finishReason: "text_response" as const }),
    );

    expect(metadata1.turnCount).toBe(1);
    expect(metadata2.turnCount).toBe(2);
  });
});

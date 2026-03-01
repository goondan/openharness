import { describe, it, expect, beforeEach } from "vitest";
import { ExtensionApiImpl } from "./api-impl.js";
import { PipelineRegistryImpl } from "../pipeline/registry.js";
import { ToolRegistryImpl } from "../tools/registry.js";
import { ExtensionStateManagerImpl } from "./state-manager.js";
import { EventEmitter } from "node:events";
import { FileWorkspaceStorage } from "../workspace/storage.js";
import { WorkspacePaths } from "../workspace/paths.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("ExtensionApiImpl", () => {
  let tempDir: string;
  let api: ExtensionApiImpl;
  let pipelineRegistry: PipelineRegistryImpl;
  let toolRegistry: ToolRegistryImpl;
  let stateManager: ExtensionStateManagerImpl;
  let eventBus: EventEmitter;
  let logger: Console;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ext-api-test-"));
    const paths = new WorkspacePaths({
      stateRoot: tempDir,
      projectRoot: tempDir,
    });
    const storage = new FileWorkspaceStorage(paths);
    await storage.initializeSystemRoot();
    await storage.initializeInstanceState("test-instance", "test-agent");

    pipelineRegistry = new PipelineRegistryImpl();
    toolRegistry = new ToolRegistryImpl();
    stateManager = new ExtensionStateManagerImpl(storage, "test-instance", ["test-ext"]);
    eventBus = new EventEmitter();
    logger = console;

    api = new ExtensionApiImpl("test-ext", pipelineRegistry, toolRegistry, stateManager, eventBus, logger);
  });

  it("should provide pipeline registry", () => {
    expect(api.pipeline).toBe(pipelineRegistry);
  });

  it("should register tools via tools API", () => {
    api.tools.register(
      {
        name: "test-ext__action",
        description: "Test action",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ ok: true }),
    );

    const catalog = toolRegistry.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe("test-ext__action");
  });

  it("should get and set extension state", async () => {
    await stateManager.loadAll();

    await api.state.set({ count: 42 });
    const state = await api.state.get();

    expect(state).toEqual({ count: 42 });
  });

  it("should return null for uninitialized state", async () => {
    await stateManager.loadAll();

    const state = await api.state.get();
    expect(state).toBeNull();
  });

  it("should subscribe to events", async () => {
    const events: string[] = [];
    const unsubscribe = api.events.on("test-event", (data) => {
      events.push(data as string);
    });

    await api.events.emit("test-event", "payload1");
    await api.events.emit("test-event", "payload2");

    expect(events).toEqual(["payload1", "payload2"]);

    unsubscribe();

    await api.events.emit("test-event", "payload3");
    expect(events).toEqual(["payload1", "payload2"]);
  });

  it("should provide logger API", () => {
    expect(api.logger.debug).toBeDefined();
    expect(api.logger.info).toBeDefined();
    expect(api.logger.warn).toBeDefined();
    expect(api.logger.error).toBeDefined();
  });

  it("should isolate state between extensions", async () => {
    const storage = new FileWorkspaceStorage(
      new WorkspacePaths({
        stateRoot: tempDir,
        projectRoot: tempDir,
      }),
    );

    const stateManager1 = new ExtensionStateManagerImpl(storage, "test-instance", ["ext1"]);
    const stateManager2 = new ExtensionStateManagerImpl(storage, "test-instance", ["ext2"]);

    await stateManager1.loadAll();
    await stateManager2.loadAll();

    const api1 = new ExtensionApiImpl("ext1", pipelineRegistry, toolRegistry, stateManager1, eventBus, logger);
    const api2 = new ExtensionApiImpl("ext2", pipelineRegistry, toolRegistry, stateManager2, eventBus, logger);

    await api1.state.set({ ext1Data: true });
    await api2.state.set({ ext2Data: true });

    const state1 = await api1.state.get();
    const state2 = await api2.state.get();

    expect(state1).toEqual({ ext1Data: true });
    expect(state2).toEqual({ ext2Data: true });
  });
});

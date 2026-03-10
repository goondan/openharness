import { describe, it, expect, beforeEach } from "vitest";
import { ExtensionStateManagerImpl } from "./state-manager.js";
import { FileWorkspaceStorage } from "../workspace/storage.js";
import { WorkspacePaths } from "../workspace/paths.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("ExtensionStateManager", () => {
  let tempDir: string;
  let storage: FileWorkspaceStorage;
  let paths: WorkspacePaths;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ext-state-test-"));
    paths = new WorkspacePaths({
      stateRoot: tempDir,
      projectRoot: tempDir,
    });
    storage = new FileWorkspaceStorage(paths);
    await storage.initializeSystemRoot();
  });

  it("should load all extension states from storage", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    await storage.writeExtensionState(conversationId, "ext1", { count: 1 });
    await storage.writeExtensionState(conversationId, "ext2", { value: "hello" });

    const manager = new ExtensionStateManagerImpl(storage, conversationId, ["ext1", "ext2"]);
    await manager.loadAll();

    const state1 = await manager.get("ext1");
    const state2 = await manager.get("ext2");

    expect(state1).toEqual({ count: 1 });
    expect(state2).toEqual({ value: "hello" });
  });

  it("should return null for non-existent extension state", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    const manager = new ExtensionStateManagerImpl(storage, conversationId, []);
    await manager.loadAll();

    const state = await manager.get("missing");
    expect(state).toBeNull();
  });

  it("should set and track dirty state", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    const manager = new ExtensionStateManagerImpl(storage, conversationId, ["ext1"]);
    await manager.loadAll();

    await manager.set("ext1", { updated: true });
    const state = await manager.get("ext1");

    expect(state).toEqual({ updated: true });
  });

  it("should save only dirty states", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    await storage.writeExtensionState(conversationId, "ext1", { original: 1 });
    await storage.writeExtensionState(conversationId, "ext2", { original: 2 });

    const manager = new ExtensionStateManagerImpl(storage, conversationId, ["ext1", "ext2"]);
    await manager.loadAll();

    await manager.set("ext1", { modified: true });
    await manager.saveAll();

    const saved1 = await storage.readExtensionState(conversationId, "ext1");
    const saved2 = await storage.readExtensionState(conversationId, "ext2");

    expect(saved1).toEqual({ modified: true });
    expect(saved2).toEqual({ original: 2 });
  });

  it("should clear dirty set after save", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    const manager = new ExtensionStateManagerImpl(storage, conversationId, ["ext1"]);
    await manager.loadAll();

    await manager.set("ext1", { count: 1 });
    await manager.saveAll();

    await manager.set("ext1", { count: 2 });
    await manager.saveAll();

    const saved = await storage.readExtensionState(conversationId, "ext1");
    expect(saved).toEqual({ count: 2 });
  });

  it("should throw error if state is not JsonObject", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    const manager = new ExtensionStateManagerImpl(storage, conversationId, ["ext1"]);
    await manager.loadAll();

    await manager.set("ext1", "invalid-string");

    await expect(manager.saveAll()).rejects.toThrow(/must be JsonObject/);
  });

  it("should handle multiple extensions independently", async () => {
    const conversationId = "test-instance";
    await storage.initializeInstanceState(conversationId, "test-agent");

    const manager = new ExtensionStateManagerImpl(storage, conversationId, ["ext1", "ext2", "ext3"]);
    await manager.loadAll();

    await manager.set("ext1", { a: 1 });
    await manager.set("ext2", { b: 2 });
    await manager.set("ext3", { c: 3 });

    const state1 = await manager.get("ext1");
    const state2 = await manager.get("ext2");
    const state3 = await manager.get("ext3");

    expect(state1).toEqual({ a: 1 });
    expect(state2).toEqual({ b: 2 });
    expect(state3).toEqual({ c: 3 });
  });
});

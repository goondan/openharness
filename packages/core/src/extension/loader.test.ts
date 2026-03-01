import { describe, it, expect, beforeEach } from "vitest";
import { loadExtensions, ExtensionLoadError, type ExtensionSpec } from "./loader.js";
import type { ExtensionApi, RuntimeResource } from "../types.js";
import { PipelineRegistryImpl } from "../pipeline/registry.js";
import { ToolRegistryImpl } from "../tools/registry.js";
import { ExtensionStateManagerImpl } from "./state-manager.js";
import { ExtensionApiImpl } from "./api-impl.js";
import { FileWorkspaceStorage } from "../workspace/storage.js";
import { WorkspacePaths } from "../workspace/paths.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

describe("loadExtensions", () => {
  let tempDir: string;
  let bundleDir: string;
  let apiFactory: (name: string) => ExtensionApi;
  let logger: Console;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ext-loader-test-"));
    bundleDir = path.join(tempDir, "bundle");
    await fs.mkdir(bundleDir, { recursive: true });

    const paths = new WorkspacePaths({
      stateRoot: tempDir,
      projectRoot: tempDir,
    });
    const storage = new FileWorkspaceStorage(paths);
    await storage.initializeSystemRoot();
    await storage.initializeInstanceState("test-instance", "test-agent");

    const pipelineRegistry = new PipelineRegistryImpl();
    const toolRegistry = new ToolRegistryImpl();
    const eventBus = new EventEmitter();

    apiFactory = (name: string) => {
      const stateManager = new ExtensionStateManagerImpl(storage, "test-instance", [name]);
      return new ExtensionApiImpl(name, pipelineRegistry, toolRegistry, stateManager, eventBus, console);
    };

    logger = console;
  });

  it("should load and register extension successfully", async () => {
    const extPath = path.join(bundleDir, "test-ext.ts");
    await fs.writeFile(
      extPath,
      `
      export function register(api) {
        api.tools.register(
          { name: 'test-ext__hello', description: 'Test', parameters: { type: 'object', properties: {} } },
          async () => ({ message: 'Hello' })
        );
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "test-ext" },
        spec: { entry: "./test-ext.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
    ];

    await loadExtensions(resources, apiFactory, bundleDir, logger);
  });

  it("should load multiple extensions in order", async () => {
    const ext1Path = path.join(bundleDir, "ext1.ts");
    const ext2Path = path.join(bundleDir, "ext2.ts");

    await fs.writeFile(
      ext1Path,
      `
      export function register(api) {
        api.logger.info('ext1 registered');
      }
    `,
      "utf8",
    );

    await fs.writeFile(
      ext2Path,
      `
      export function register(api) {
        api.logger.info('ext2 registered');
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "ext1" },
        spec: { entry: "./ext1.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "ext2" },
        spec: { entry: "./ext2.ts" },
        __file: "test.yaml",
        __docIndex: 1,
        __rootDir: bundleDir,
      },
    ];

    await loadExtensions(resources, apiFactory, bundleDir, logger);
  });

  it("passes resource spec.config as register second argument", async () => {
    const extPath = path.join(bundleDir, "config-ext.ts");
    await fs.writeFile(
      extPath,
      `
      export let receivedConfig;
      export function register(api, config) {
        receivedConfig = config;
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "config-ext" },
        spec: {
          entry: "./config-ext.ts",
          config: {
            requiredTools: ["slack__send"],
            errorMessage: "required",
          },
        },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
    ];

    await loadExtensions(resources, apiFactory, bundleDir, logger);

    const loadedModule = (await import(pathToFileURL(extPath).href)) as {
      receivedConfig: Record<string, unknown> | undefined;
    };
    expect(loadedModule.receivedConfig).toEqual({
      requiredTools: ["slack__send"],
      errorMessage: "required",
    });
  });

  it("should throw ExtensionLoadError if register function is missing", async () => {
    const extPath = path.join(bundleDir, "bad-ext.ts");
    await fs.writeFile(
      extPath,
      `
      export const notRegister = () => {};
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "bad-ext" },
        spec: { entry: "./bad-ext.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
    ];

    await expect(loadExtensions(resources, apiFactory, bundleDir, logger)).rejects.toThrow(ExtensionLoadError);
  });

  it("should throw ExtensionLoadError if register throws", async () => {
    const extPath = path.join(bundleDir, "error-ext.ts");
    await fs.writeFile(
      extPath,
      `
      export function register(api) {
        throw new Error('Extension init failed');
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "error-ext" },
        spec: { entry: "./error-ext.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
    ];

    await expect(loadExtensions(resources, apiFactory, bundleDir, logger)).rejects.toThrow(/Extension init failed/);
  });

  it("should support async register function", async () => {
    const extPath = path.join(bundleDir, "async-ext.ts");
    await fs.writeFile(
      extPath,
      `
      export async function register(api) {
        await new Promise(resolve => setTimeout(resolve, 10));
        api.logger.info('async registered');
      }
    `,
      "utf8",
    );

    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "async-ext" },
        spec: { entry: "./async-ext.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
    ];

    await loadExtensions(resources, apiFactory, bundleDir, logger);
  });

  it("should include error details in ExtensionLoadError", async () => {
    const resources: RuntimeResource<ExtensionSpec>[] = [
      {
        apiVersion: "goondan.ai/v1",
        kind: "Extension",
        metadata: { name: "missing-ext" },
        spec: { entry: "./missing-ext.ts" },
        __file: "test.yaml",
        __docIndex: 0,
        __rootDir: bundleDir,
      },
    ];

    try {
      await loadExtensions(resources, apiFactory, bundleDir, logger);
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionLoadError);
      if (error instanceof ExtensionLoadError) {
        expect(error.extensionName).toBe("missing-ext");
        expect(error.code).toBe("E_EXT_INIT");
      }
    }
  });
});

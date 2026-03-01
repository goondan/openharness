import * as path from "node:path";
import type { ExtensionApi, RuntimeResource } from "../types.js";

export interface ExtensionSpec {
  entry: string;
  config?: Record<string, unknown>;
}

export interface ExtensionModule {
  register(api: ExtensionApi, config?: Record<string, unknown>): void | Promise<void>;
}

function isExtensionModule(value: unknown): value is ExtensionModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.register === "function";
}

export class ExtensionLoadError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly extensionName: string,
    public readonly suggestion?: string,
    public readonly helpUrl?: string,
  ) {
    super(message);
    this.name = "ExtensionLoadError";
  }
}

export async function loadExtensions(
  extensionResources: RuntimeResource<ExtensionSpec>[],
  apiFactory: (extensionName: string) => ExtensionApi,
  bundleRootDir: string,
  logger: Console,
): Promise<void> {
  for (const resource of extensionResources) {
    const extensionName = resource.metadata.name;

    try {
      const entryPath = resolveEntryPath(resource, bundleRootDir);
      logger.debug(`[extension.loader] loading ${extensionName} from ${entryPath}`);

      const module: unknown = await import(entryPath);
      if (!isExtensionModule(module)) {
        throw new ExtensionLoadError(
          `extension module does not export register function: ${extensionName}`,
          "E_EXT_LOAD",
          extensionName,
          "Ensure your extension exports a named function: export function register(api: ExtensionApi) { ... }",
          "https://github.com/goondan/goondan/blob/main/docs/specs/extension.md#entrypoint",
        );
      }

      const api = apiFactory(extensionName);
      await module.register(api, resource.spec.config);

      logger.debug(`[extension.loader] registered ${extensionName}`);
    } catch (error) {
      if (error instanceof ExtensionLoadError) {
        throw error;
      }

      throw new ExtensionLoadError(
        `failed to initialize extension ${extensionName}: ${error instanceof Error ? error.message : String(error)}`,
        "E_EXT_INIT",
        extensionName,
        "Check extension register() function for errors",
        undefined,
      );
    }
  }
}

function resolveEntryPath(resource: RuntimeResource<ExtensionSpec>, bundleRootDir: string): string {
  const rootDir = resource.__rootDir ?? bundleRootDir;
  const entryRelative = resource.spec.entry;
  return path.resolve(rootDir, entryRelative);
}

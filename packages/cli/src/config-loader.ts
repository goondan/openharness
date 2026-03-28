import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "@goondan/openharness-types";

/**
 * Try loading a module via jiti (supports .ts files without tsx/ts-node).
 * Returns the module exports or throws if jiti is unavailable.
 */
async function loadWithJiti(configPath: string): Promise<unknown> {
  // jiti v2 exports createJiti as a named export
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  return jiti.import(configPath);
}

/**
 * Try loading a module via native dynamic import().
 * Works for .js files and .ts files when tsx / ts-node is registered.
 */
async function loadWithNativeImport(configPath: string): Promise<unknown> {
  const fileUrl = pathToFileURL(configPath).href;
  return import(fileUrl);
}

/**
 * Dynamically import a harness.config.ts (or specified config file).
 *
 * Loading strategy:
 *  1. Try jiti (bundled dependency) — handles .ts without extra tooling.
 *  2. Fall back to native dynamic import() — works when tsx/ts-node is present
 *     or the file is plain JS/JSON.
 *  3. If both fail for a .ts file, throw a clear actionable error.
 *
 * Validates that the default export is a HarnessConfig object.
 */
export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  let mod: unknown;

  // 1. Try jiti first (best .ts support out of the box)
  try {
    mod = await loadWithJiti(configPath);
  } catch {
    // 2. Fall back to native import()
    try {
      mod = await loadWithNativeImport(configPath);
    } catch (nativeError) {
      // 3. If this is a .ts file, provide a clear error message
      if (configPath.endsWith(".ts")) {
        throw new Error(
          `Failed to load TypeScript config "${configPath}". ` +
            `TypeScript config를 로드하려면 jiti, tsx, 또는 ts-node가 필요합니다. ` +
            `Cause: ${nativeError instanceof Error ? nativeError.message : String(nativeError)}`,
        );
      }
      throw nativeError;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const config = ((mod as Record<string, unknown>).default ?? mod) as unknown;

  if (
    config === null ||
    typeof config !== "object" ||
    !("agents" in config) ||
    typeof (config as Record<string, unknown>).agents !== "object"
  ) {
    throw new Error(
      `Config file "${configPath}" must export a default HarnessConfig with an "agents" property.`,
    );
  }

  return config as HarnessConfig;
}

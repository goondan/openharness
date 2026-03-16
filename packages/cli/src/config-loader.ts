import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "@goondan/openharness-types";

/**
 * Dynamically import a harness.config.ts (or specified config file).
 * Uses pathToFileURL for ESM compatibility across platforms.
 * Validates that the default export is a HarnessConfig object.
 */
export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const fileUrl = pathToFileURL(configPath).href;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import(fileUrl);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const config = (mod.default ?? mod) as unknown;

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

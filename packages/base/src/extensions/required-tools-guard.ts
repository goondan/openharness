import type { Extension, ExtensionApi } from "@goondan/openharness-types";

/**
 * RequiredToolsGuard extension — blocks a turn if any required tools are
 * not registered.
 */
export function RequiredToolsGuard(config: { tools: string[] }): Extension {
  return {
    name: "required-tools-guard",

    register(api: ExtensionApi): void {
      api.pipeline.register("turn", async (ctx, next) => {
        const registered = api.tools.list().map((t) => t.name);
        const missing = config.tools.filter((name) => !registered.includes(name));
        if (missing.length > 0) {
          throw new Error(
            `RequiredToolsGuard: missing required tools: ${missing.join(", ")}`,
          );
        }
        return next();
      });
    },
  };
}

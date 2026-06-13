import type { AgentExtension, AgentExtensionApi } from "@goondan/openharness-types";

/**
 * Registration name of {@link RequiredToolsGuard}. Exported as a marker so other
 * middleware can order around it with `before`/`after` (F1) without hardcoding
 * the string — e.g. `{ after: REQUIRED_TOOLS_GUARD }`.
 */
export const REQUIRED_TOOLS_GUARD = "required-tools-guard";

/**
 * RequiredToolsGuard extension — blocks a turn if any required tools are
 * not registered.
 *
 * Runs in the `guard` phase (F1): the last checks before the model, after
 * context has been assembled.
 */
export function RequiredToolsGuard(config: { tools: string[] }): AgentExtension {
  return {
    name: REQUIRED_TOOLS_GUARD,

    register(api: AgentExtensionApi): void {
      api.pipeline.register(
        "turn",
        async (ctx, next) => {
          const registered = api.tools.list().map((t) => t.name);
          const missing = config.tools.filter(
            (name) => !registered.includes(name),
          );
          if (missing.length > 0) {
            throw new Error(
              `RequiredToolsGuard: missing required tools: ${missing.join(", ")}`,
            );
          }
          return next();
        },
        { phase: "guard" },
      );
    },
  };
}

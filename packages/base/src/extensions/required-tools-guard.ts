import type { AgentExtension, AgentExtensionApi } from "@goondan/openharness-types";

/**
 * Registration name of {@link RequiredToolsGuard}. Exported as a marker so other
 * middleware can order around it with `before`/`after` without hardcoding the
 * string — e.g. `{ after: REQUIRED_TOOLS_GUARD }`.
 */
export const REQUIRED_TOOLS_GUARD = "required-tools-guard";

/**
 * RequiredToolsGuard extension — blocks a turn if any required tools are
 * not registered.
 *
 * Registered with `{ after: "*" }` so it sits at the innermost band — the last
 * check before the model call, after all other context-assembling middleware
 * has run.
 */
export function RequiredToolsGuard(config: { tools: string[] }): AgentExtension {
  return {
    name: REQUIRED_TOOLS_GUARD,

    register(api: AgentExtensionApi): void {
      api.useTurn(
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
        { after: "*" },
      );
    },
  };
}

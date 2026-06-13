import type {
  AgentExtension,
  AgentExtensionApi,
} from "@goondan/openharness-types";

/**
 * Logging extension — subscribes to core events and logs them.
 */
export function Logging(config?: {
  logger?: (msg: string) => void;
}): AgentExtension {
  const log = config?.logger ?? console.log;

  return {
    name: "logging",

    register(api: AgentExtensionApi): void {
      api.on("turn.start", (payload) => {
        log(`[turn.start] ${JSON.stringify(payload)}`);
      });

      api.on("turn.done", (payload) => {
        log(`[turn.done] ${JSON.stringify(payload)}`);
      });

      api.on("turn.error", (payload) => {
        log(`[turn.error] ${JSON.stringify(payload)}`);
      });

      api.on("step.start", (payload) => {
        log(`[step.start] ${JSON.stringify(payload)}`);
      });

      api.on("step.done", (payload) => {
        log(`[step.done] ${JSON.stringify(payload)}`);
      });

      api.on("tool.start", (payload) => {
        log(`[tool.start] ${JSON.stringify(payload)}`);
      });

      api.on("tool.done", (payload) => {
        log(`[tool.done] ${JSON.stringify(payload)}`);
      });
    },
  };
}

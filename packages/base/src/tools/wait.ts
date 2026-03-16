import type { ToolDefinition, JsonObject, ToolContext } from "@goondan/openharness-types";

export interface WaitToolConfig {
  maxMs?: number;
}

export function WaitTool(config: WaitToolConfig = {}): ToolDefinition {
  const { maxMs = 60_000 } = config;

  return {
    name: "wait",
    description: "Wait for a specified number of milliseconds before continuing.",
    parameters: {
      type: "object",
      properties: {
        ms: {
          type: "number",
          description: "Number of milliseconds to wait.",
          minimum: 0,
        },
      },
      required: ["ms"],
    },
    async handler(args: JsonObject, ctx: ToolContext) {
      const requestedMs = args["ms"] as number;
      const ms = Math.min(requestedMs, maxMs);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);

        if (ctx.abortSignal.aborted) {
          clearTimeout(timer);
          reject(new Error("Aborted"));
          return;
        }

        ctx.abortSignal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        });
      });

      return { type: "text", text: `Waited ${ms}ms` };
    },
  };
}

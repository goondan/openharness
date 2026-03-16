import { exec } from "node:child_process";
import type { ToolDefinition, JsonObject, ToolContext } from "@goondan/openharness-types";

export interface BashToolConfig {
  timeout?: number;
  maxBuffer?: number;
}

export function BashTool(config: BashToolConfig = {}): ToolDefinition {
  const { timeout = 30_000, maxBuffer = 1024 * 1024 } = config;

  return {
    name: "bash",
    description: "Execute a shell command and return its output.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        cwd: { type: "string", description: "Optional working directory for the command." },
      },
      required: ["command"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const command = args["command"] as string;
      const cwd = args["cwd"] as string | undefined;

      return new Promise((resolve) => {
        exec(command, { timeout, maxBuffer, cwd }, (error, stdout, stderr) => {
          if (error) {
            resolve({ type: "error", error: stderr || error.message });
          } else {
            resolve({ type: "text", text: stdout });
          }
        });
      });
    },
  };
}

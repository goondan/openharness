import * as path from "node:path";
import { createHarness } from "@goondan/openharness";
import { loadEnv } from "../env-loader.js";
import { loadConfig } from "../config-loader.js";

export interface RunOptions {
  workdir?: string;
  config?: string;
  agent?: string;
  conversation?: string;
  maxSteps?: number;
}

/**
 * Run a single turn with the given text input.
 * Exit codes:
 *   0 - success
 *   1 - runtime error
 *   2 - usage error (e.g., ambiguous agent selection)
 */
export async function runCommand(text: string, options: RunOptions): Promise<void> {
  const workdir = options.workdir ?? process.cwd();
  const configPath = options.config
    ? path.resolve(workdir, options.config)
    : path.resolve(workdir, "harness.config.ts");

  // Load environment variables
  loadEnv(workdir);

  // Load harness config
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Select agent
  const agentNames = Object.keys(config.agents);

  let agentName: string;
  if (options.agent) {
    if (!config.agents[options.agent]) {
      console.error(`Unknown agent: "${options.agent}". Available agents: ${agentNames.join(", ")}`);
      process.exit(2);
    }
    agentName = options.agent;
  } else if (agentNames.length === 1) {
    agentName = agentNames[0]!;
  } else {
    console.error(
      `Multiple agents defined. Specify one with --agent. Available agents: ${agentNames.join(", ")}`,
    );
    process.exit(2);
  }

  // Create harness and process turn
  let harness;
  try {
    const effectiveConfig =
      options.maxSteps === undefined
        ? config
        : {
            ...config,
            agents: {
              ...config.agents,
              [agentName]: {
                ...config.agents[agentName]!,
                maxSteps: options.maxSteps,
              },
            },
          };

    harness = await createHarness(effectiveConfig);
  } catch (err) {
    console.error(`Error creating harness: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    const result = await harness.processTurn(agentName, text, {
      conversationId: options.conversation,
    });

    // Print result
    if (result.text) {
      process.stdout.write(result.text);
      process.stdout.write("\n");
    }
  } catch (err) {
    console.error(`Runtime error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await harness.close();
  }
}

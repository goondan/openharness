import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createHarness } from "@goondan/openharness";
import { loadEnv } from "../env-loader.js";
import { loadConfig } from "../config-loader.js";

export interface ReplOptions {
  workdir?: string;
  config?: string;
  agent?: string;
  conversation?: string;
  maxSteps?: number;
}

/**
 * Start an interactive REPL session.
 * Maintains the same conversationId across the session.
 * Handles Ctrl+C and "exit" gracefully.
 */
export async function replCommand(options: ReplOptions): Promise<void> {
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

  // Create harness
  let harness;
  try {
    harness = await createHarness(config);
  } catch (err) {
    console.error(`Error creating harness: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Maintain a single conversationId across the session
  const conversationId = options.conversation ?? randomUUID();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("> ", async (line) => {
      const trimmed = line.trim();

      if (trimmed === "exit" || trimmed === "quit") {
        rl.close();
        await harness.close();
        return;
      }

      if (!trimmed) {
        prompt();
        return;
      }

      try {
        const result = await harness.processTurn(agentName, trimmed, { conversationId });
        if (result.text) {
          console.log(result.text);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      prompt();
    });
  };

  // Handle Ctrl+C
  rl.on("SIGINT", () => {
    console.log("\nExiting...");
    rl.close();
    harness.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  rl.on("close", () => {
    // If close triggered without exit being called (e.g. EOF), clean up
    harness.close().catch(() => {});
  });

  console.log(`OpenHarness REPL - Agent: ${agentName} (conversation: ${conversationId})`);
  console.log('Type "exit" or press Ctrl+C to quit.\n');
  prompt();
}

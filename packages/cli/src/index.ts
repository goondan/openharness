#!/usr/bin/env node

import { runCommand } from "./commands/run.js";
import { replCommand } from "./commands/repl.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: "run" | "repl";
  text?: string;
  workdir?: string;
  config?: string;
  agent?: string;
  conversation?: string;
  maxSteps?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] = node, argv[1] = script, argv[2+] = user args
  const args = argv.slice(2);
  let i = 0;

  const result: ParsedArgs = { command: "repl" };

  // First positional arg might be a command name
  if (args[i] && !args[i]!.startsWith("-")) {
    const cmd = args[i];
    if (cmd === "run") {
      result.command = "run";
      i++;
      // Next positional arg is the text
      if (args[i] && !args[i]!.startsWith("-")) {
        result.text = args[i];
        i++;
      }
    } else if (cmd === "repl") {
      result.command = "repl";
      i++;
    }
  }

  // Parse flags
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "--workdir" || arg === "-w") {
      result.workdir = args[++i];
    } else if (arg.startsWith("--workdir=")) {
      result.workdir = arg.slice("--workdir=".length);
    } else if (arg === "--config" || arg === "-c") {
      result.config = args[++i];
    } else if (arg.startsWith("--config=")) {
      result.config = arg.slice("--config=".length);
    } else if (arg === "--agent" || arg === "-a") {
      result.agent = args[++i];
    } else if (arg.startsWith("--agent=")) {
      result.agent = arg.slice("--agent=".length);
    } else if (arg === "--conversation") {
      result.conversation = args[++i];
    } else if (arg.startsWith("--conversation=")) {
      result.conversation = arg.slice("--conversation=".length);
    } else if (arg === "--max-steps") {
      result.maxSteps = parseInt(args[++i] ?? "25", 10);
    } else if (arg.startsWith("--max-steps=")) {
      result.maxSteps = parseInt(arg.slice("--max-steps=".length), 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log("2.0.0-alpha.0");
      process.exit(0);
    }

    i++;
  }

  return result;
}

function printHelp(): void {
  console.log(`
OpenHarness CLI (oh)

Usage:
  oh                                Start REPL (default)
  oh repl                           Start REPL
  oh run "<text>"                   Run a single turn

Options:
  --workdir, -w <dir>               Working directory (default: cwd)
  --config, -c <file>               Config file (default: harness.config.ts)
  --agent, -a <name>                Agent name (required if multiple agents)
  --conversation <id>               Conversation ID
  --max-steps <n>                   Maximum steps per turn
  --help, -h                        Show this help
  --version, -v                     Show version
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const opts = {
    workdir: parsed.workdir,
    config: parsed.config,
    agent: parsed.agent,
    conversation: parsed.conversation,
    maxSteps: parsed.maxSteps,
  };

  if (parsed.command === "run") {
    if (!parsed.text) {
      console.error('Usage: oh run "<text>"');
      process.exit(2);
    }
    await runCommand(parsed.text, opts);
  } else {
    await replCommand(opts);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

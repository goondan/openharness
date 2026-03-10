import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/types.js";

export interface TempWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

export async function createTempWorkspace(prefix = "openharness-integrations-"): Promise<TempWorkspace> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export function createToolContext(workdir: string): ToolContext {
  return {
    agentName: "agent-a",
    conversationId: "instance-1",
    turnId: "turn-1",
    traceId: "trace-1",
    toolCallId: "tool-call-1",
    workdir,
    logger: console,
    message: {
      id: "assistant-msg-1",
      data: {
        role: "assistant",
        content: "",
      },
      metadata: {},
      createdAt: new Date(),
      source: {
        type: "assistant",
      },
    },
  };
}


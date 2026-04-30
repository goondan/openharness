import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Connector,
  HarnessConfig,
  LlmClient,
  LlmResponse,
  ToolDefinition,
} from "@goondan/openharness-types";
import { createHarness } from "../create-harness.js";
import { createInMemoryDurableInboundStore } from "../inbound/memory-store.js";
import { createInMemoryHumanGateStore } from "../hitl/memory-store.js";

let currentClient: LlmClient;

vi.mock("../models/index.js", () => ({
  createLlmClient: vi.fn(() => currentClient),
}));

function mockClient(response: LlmResponse): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue(response),
  };
}

function connector(): Connector {
  return {
    name: "test",
    normalize: vi.fn(async (ctx) => ({
      name: "message.created",
      content: [{ type: "text" as const, text: String((ctx.payload as { text?: string }).text ?? "hello") }],
      properties: {
        id: String((ctx.payload as { id?: string }).id ?? "evt-1"),
      },
      conversationId: String((ctx.payload as { conversationId?: string }).conversationId ?? "conv-1"),
      source: {
        connector: "test",
        connectionName: ctx.connectionName,
        receivedAt: ctx.receivedAt,
      },
    })),
  };
}

function baseConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    agents: {
      default: {
        model: { provider: "openai", model: "gpt-4", apiKey: "test" },
        ...(overrides.agents?.default ?? {}),
      },
    },
    connections: {
      test: {
        connector: connector(),
        rules: [{ match: { event: "message.created" }, agent: "default" }],
      },
    },
    ...overrides,
  };
}

describe("durable inbound and Human Gate integration", () => {
  beforeEach(() => {
    currentClient = mockClient({ text: "ok", toolCalls: [] });
  });

  it("appends ingress input before returning a durable accepted result", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const accepted = await runtime.ingress.receive({
      connectionName: "test",
      payload: { id: "evt-append", text: "persist me" },
    });

    expect(accepted).toHaveLength(1);
    expect(accepted[0].disposition).toBe("started");
    expect(accepted[0].inboundItemId).toEqual(expect.any(String));

    const items = await inboundStore.listInboundItems({
      agentName: "default",
      conversationId: "conv-1",
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(accepted[0].inboundItemId);

    await runtime.close();
  });

  it("creates a durable Human Gate before running a guarded tool handler", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanGateStore = createInMemoryHumanGateStore();
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "secret" }));
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanGate: { required: true, prompt: "Approve?" },
      handler: toolHandler,
    };
    currentClient = mockClient({
      text: "need tool",
      toolCalls: [{ toolCallId: "call-1", toolName: "guarded", args: {} }],
    });

    const runtime = await createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          tools: [guardedTool],
        },
      },
      durableInbound: { enabled: true, store: inboundStore as any },
      humanGate: { store: humanGateStore as any },
    }));

    const result = await runtime.processTurn("default", "run guarded", {
      conversationId: "conv-human",
      idempotencyKey: "direct-human-1",
    });

    expect(result.status).toBe("waitingForHuman");
    expect(toolHandler).not.toHaveBeenCalled();

    const tasks = await humanGateStore.listTasks({ conversationId: "conv-human" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("waitingForHuman");

    const blocked = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "while waiting" }],
        properties: { id: "evt-blocked" },
        conversationId: "conv-human",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: new Date().toISOString(),
        },
      },
    });

    expect(blocked.disposition).toBe("blocked");
    expect(blocked.blocker?.type).toBe("humanGate");

    await runtime.control.submitHumanResult?.({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-1",
    });
    const resumed = await runtime.control.resumeHumanGate?.(tasks[0].humanGateId);

    expect(resumed?.status).toBe("completed");
    expect(toolHandler).toHaveBeenCalledOnce();
    const blockedItems = await inboundStore.listInboundItems({
      conversationId: "conv-human",
      statuses: ["consumed"],
    });
    expect(blockedItems.some((item) => item.id === blocked.inboundItemId)).toBe(true);

    await runtime.close();
  });
});

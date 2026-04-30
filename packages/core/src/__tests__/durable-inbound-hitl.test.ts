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

  it("does not release delivered inbound items as expired leases", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const appended = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-delivered",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "already delivered" }],
        properties: { id: "evt-delivered" },
        conversationId: "conv-delivered",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "ingress",
        connectionName: "test",
        externalId: "evt-delivered",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "ingress:test:default:conv-delivered:evt-delivered",
      now: "2026-01-01T00:00:00.000Z",
    });

    await inboundStore.markDelivered({
      id: appended.item.id,
      turnId: "turn-delivered",
      now: "2026-01-01T00:00:01.000Z",
    });

    const released = await inboundStore.releaseExpiredLeases("2026-01-01T00:01:00.000Z");
    const reacquired = await inboundStore.acquireNext({
      agentName: "default",
      conversationId: "conv-delivered",
      leaseOwner: "worker-2",
      now: "2026-01-01T00:01:01.000Z",
    });
    const items = await inboundStore.listInboundItems({ conversationId: "conv-delivered" });

    expect(released).toBe(0);
    expect(reacquired).toBeNull();
    expect(items[0].status).toBe("delivered");
    expect(items[0].turnId).toBe("turn-delivered");
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

  it("reports durable direct duplicates according to inbound item state", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const pending = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "pending duplicate" }],
        properties: {},
        conversationId: "conv-duplicates",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-pending",
      now: "2026-01-01T00:00:00.000Z",
    });
    const leased = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates-leased",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "leased duplicate" }],
        properties: {},
        conversationId: "conv-duplicates-leased",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-leased",
      now: "2026-01-01T00:00:00.000Z",
    });
    const leasedItem = await inboundStore.acquireNext({
      agentName: "default",
      conversationId: "conv-duplicates-leased",
      leaseOwner: "worker-1",
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(leasedItem?.id).toBe(leased.item.id);
    const delivered = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "delivered duplicate" }],
        properties: {},
        conversationId: "conv-duplicates",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-delivered",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.markDelivered({
      id: delivered.item.id,
      turnId: "turn-no-longer-active",
      now: "2026-01-01T00:00:01.000Z",
    });
    const blocked = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "blocked duplicate" }],
        properties: {},
        conversationId: "conv-duplicates",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-blocked",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.markBlocked({
      id: blocked.item.id,
      blockedBy: { type: "humanGate", id: "gate-duplicate" },
      now: "2026-01-01T00:00:01.000Z",
    });

    const failed = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "failed duplicate" }],
        properties: {},
        conversationId: "conv-duplicates",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-failed",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.markFailed({
      id: failed.item.id,
      reason: "previous failure",
      retryable: true,
      now: "2026-01-01T00:00:01.000Z",
    });
    const deadLetter = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "dead letter duplicate" }],
        properties: {},
        conversationId: "conv-duplicates",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-dead-letter",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.deadLetterInboundItem({
      id: deadLetter.item.id,
      reason: "sent to dead letter",
      now: "2026-01-01T00:00:01.000Z",
    });
    const consumed = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-duplicates",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "consumed duplicate" }],
        properties: {},
        conversationId: "conv-duplicates",
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "direct-duplicate-consumed",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.markConsumed({
      id: consumed.item.id,
      turnId: "turn-consumed-no-cache",
      commitRef: "inbound:consumed:user-message",
      now: "2026-01-01T00:00:01.000Z",
    });

    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const pendingResult = await runtime.processTurn("default", "pending duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-pending",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const leasedResult = await runtime.processTurn("default", "leased duplicate", {
      conversationId: "conv-duplicates-leased",
      idempotencyKey: "direct-duplicate-leased",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const deliveredResult = await runtime.processTurn("default", "delivered duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-delivered",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const blockedResult = await runtime.processTurn("default", "blocked duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-blocked",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const failedResult = await runtime.processTurn("default", "failed duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-failed",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const deadLetterResult = await runtime.processTurn("default", "dead letter duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-dead-letter",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const consumedResult = await runtime.processTurn("default", "consumed duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-consumed",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const firstCached = await runtime.processTurn("default", "cached duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-cached",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const secondCached = await runtime.processTurn("default", "cached duplicate", {
      conversationId: "conv-duplicates",
      idempotencyKey: "direct-duplicate-cached",
      receivedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(pending.item.status).toBe("pending");
    expect(pendingResult.status).toBe("aborted");
    expect(pendingResult.error?.message).toContain("pending");
    expect(leasedResult.status).toBe("aborted");
    expect(leasedResult.error?.message).toContain("leased");
    expect(deliveredResult.status).toBe("aborted");
    expect(deliveredResult.error?.message).toContain("delivered");
    expect(blockedResult.status).toBe("waitingForHuman");
    expect(failedResult.status).toBe("error");
    expect(failedResult.error?.message).toContain("previous failure");
    expect(deadLetterResult.status).toBe("error");
    expect(deadLetterResult.error?.message).toContain("sent to dead letter");
    expect(consumedResult.status).toBe("completed");
    expect(firstCached.status).toBe("completed");
    expect(secondCached).toBe(firstCached);

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

  it("rejects resume when a Human Gate record is missing", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanGateStore = createInMemoryHumanGateStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
      humanGate: { store: humanGateStore as any },
    }));

    await expect(runtime.control.resumeHumanGate?.("missing-gate")).rejects.toThrow(/Unknown human gate/);

    await runtime.close();
  });

  it("requires durable inbound when Human Gate is configured with ingress", async () => {
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
      toolCalls: [{ toolCallId: "call-non-durable", toolName: "guarded", args: {} }],
    });

    await expect(createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          tools: [guardedTool],
        },
      },
      humanGate: { store: humanGateStore as any },
    }))).rejects.toThrow(/requires durableInbound\.store/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Connector,
  Extension,
  HarnessConfig,
  LlmClient,
  LlmResponse,
  ToolDefinition,
} from "@goondan/openharness-types";
import { createHarness } from "../create-harness.js";
import { createInMemoryDurableInboundStore } from "../inbound/memory-store.js";
import { createInMemoryHumanApprovalStore } from "../hitl/memory-store.js";

let currentClient: LlmClient;

vi.mock("../models/index.js", () => ({
  createLlmClient: vi.fn(() => currentClient),
}));

function mockClient(response: LlmResponse | LlmResponse[]): LlmClient {
  const responses = Array.isArray(response) ? [...response] : [response];
  return {
    chat: vi.fn(async () => responses.shift() ?? responses[responses.length - 1] ?? { text: "ok", toolCalls: [] }),
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

describe("durable inbound and Human Approval integration", () => {
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

    const retried = await inboundStore.retryInboundItem(appended.item.id);
    expect(retried.status).toBe("pending");
    expect(retried.turnId).toBeUndefined();

    const reacquiredAfterRetry = await inboundStore.acquireNext({
      agentName: "default",
      conversationId: "conv-delivered",
      leaseOwner: "worker-3",
      now: "2026-01-01T00:01:02.000Z",
    });
    expect(reacquiredAfterRetry?.id).toBe(appended.item.id);
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

  it("marks active-turn delivery in the durable store before notifying memory steering", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const markDelivered = vi.fn(async () => {
      throw new Error("markDelivered failed");
    });
    const store = new Proxy(inboundStore, {
      get(target, property, receiver) {
        if (property === "markDelivered") {
          return markDelivered;
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    let resolveChat!: (response: LlmResponse) => void;
    const chat = vi.fn(() => new Promise<LlmResponse>((resolve) => {
      resolveChat = resolve;
    }));
    currentClient = { chat };

    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: store as any },
    }));

    const turnPromise = runtime.processTurn("default", "active turn", {
      conversationId: "conv-store-first",
      idempotencyKey: "direct-store-first",
    });
    for (let attempt = 0; attempt < 10 && chat.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "must not reach memory before delivered" }],
        properties: { id: "evt-store-first" },
        conversationId: "conv-store-first",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: new Date().toISOString(),
        },
      },
    })).rejects.toThrow(/markDelivered failed/);

    resolveChat({ text: "done", toolCalls: [] });
    await expect(turnPromise).resolves.toMatchObject({ status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markDelivered).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledTimes(1);

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
      blockedBy: { type: "humanApproval", id: "gate-duplicate" },
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
    expect(consumedResult.status).toBe("aborted");
    expect(consumedResult.error?.message).toContain("consumed");
    expect(firstCached.status).toBe("completed");
    expect(secondCached).toBe(firstCached);

    await runtime.close();
  });

  it("retries a delivered inbound item through the control API", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const appended = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-retry-delivered",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "recover delivered" }],
        properties: { id: "evt-retry-delivered" },
        conversationId: "conv-retry-delivered",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "ingress",
        connectionName: "test",
        externalId: "evt-retry-delivered",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "ingress:test:default:conv-retry-delivered:evt-retry-delivered",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.markDelivered({
      id: appended.item.id,
      turnId: "turn-crashed-before-consume",
      now: "2026-01-01T00:00:01.000Z",
    });

    currentClient = mockClient({ text: "recovered", toolCalls: [] });
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const retried = await runtime.control.retryInboundItem?.(appended.item.id);
    expect(retried?.status).toBe("pending");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [item] = await inboundStore.listInboundItems({ conversationId: "conv-retry-delivered" });
      if (item?.status === "consumed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const [item] = await inboundStore.listInboundItems({ conversationId: "conv-retry-delivered" });
    expect(item.status).toBe("consumed");
    expect(item.commitRef).toBe(`inbound:${appended.item.id}:user-message`);

    await runtime.close();
  });

  it("creates a durable Human Approval before running a guarded tool handler", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore({
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const markCompleted = vi.spyOn(humanApprovalStore, "markApprovalCompleted");
    const middlewareCalls: string[] = [];
    const extensionToolDoneEvents: unknown[] = [];
    const toolMiddlewareExtension: Extension = {
      name: "approval-tool-middleware",
      register(api) {
        api.pipeline.register("toolCall", async (ctx, next) => {
          middlewareCalls.push(ctx.toolName);
          return next();
        });
        api.on("tool.done", (event) => {
          extensionToolDoneEvents.push(event);
        });
      },
    };
    let humanApprovalId = "";
    let resumeLeaseExpiresAt: string | undefined;
    const toolHandler = vi.fn(async () => {
      const approval = await humanApprovalStore.getApproval(humanApprovalId);
      resumeLeaseExpiresAt = approval?.lease?.expiresAt;
      return { type: "text" as const, text: "secret" };
    });
    const resumingEvents: unknown[] = [];
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: toolHandler,
    };
    currentClient = mockClient([
      {
        text: "need tool",
        toolCalls: [{ toolCallId: "call-1", toolName: "guarded", args: {} }],
      },
      {
        text: "approved and continued",
        toolCalls: [],
      },
    ]);

    const runtime = await createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          extensions: [toolMiddlewareExtension],
          tools: [guardedTool],
        },
      },
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any, resumeLeaseMs: 1_234 },
    }));

    const result = await runtime.processTurn("default", "run guarded", {
      conversationId: "conv-human",
      idempotencyKey: "direct-human-1",
    });

    expect(result.status).toBe("waitingForHuman");
    expect(toolHandler).not.toHaveBeenCalled();
    expect(middlewareCalls).toEqual(["guarded"]);

    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-human" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("waitingForHuman");
    humanApprovalId = tasks[0].humanApprovalId;
    const publicTasks = await runtime.control.listHumanTasks!({ conversationId: "conv-human" });
    expect(publicTasks).toHaveLength(1);
    expect(publicTasks[0].type).toBe("approval");
    expect(publicTasks[0].humanApprovalId).toBe(tasks[0].humanApprovalId);

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
    expect(blocked.blocker?.type).toBe("humanApproval");

    runtime.events.on("humanApproval.resuming", (event) => {
      resumingEvents.push(event);
    });
    const submitResult = await runtime.control.submitHumanResult!({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-1",
    });
    const duplicateSubmitResult = await runtime.control.submitHumanResult!({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-1",
    });
    const resumed = await runtime.control.resumeHumanApproval?.(tasks[0].humanApprovalId);

    expect(submitResult.accepted).toBe(true);
    expect(submitResult.duplicate).toBe(false);
    expect(submitResult.task.type).toBe("approval");
    expect(submitResult.task.idempotencyKey).toBe("approve-1");
    expect(submitResult.approval.id).toBe(tasks[0].humanApprovalId);
    expect(duplicateSubmitResult.accepted).toBe(true);
    expect(duplicateSubmitResult.duplicate).toBe(true);
    expect(duplicateSubmitResult.task.type).toBe("approval");
    expect(resumed?.status).toBe("completed");
    expect(markCompleted).toHaveBeenCalledWith(expect.objectContaining({
      humanApprovalId: tasks[0].humanApprovalId,
      leaseOwner: "runtime",
    }));
    expect(resumed?.continuation?.status).toBe("completed");
    expect(resumed?.continuation?.text).toBe("approved and continued");
    expect(toolHandler).toHaveBeenCalledOnce();
    expect(middlewareCalls).toEqual(["guarded", "guarded"]);
    expect(resumingEvents).toHaveLength(1);
    expect((resumingEvents[0] as any).humanApprovalId).toBe(tasks[0].humanApprovalId);
    expect(extensionToolDoneEvents).toHaveLength(1);
    expect((extensionToolDoneEvents[0] as any).toolName).toBe("guarded");
    expect(resumeLeaseExpiresAt).toBe("2026-01-01T00:00:01.234Z");
    const blockedItems = await inboundStore.listInboundItems({
      conversationId: "conv-human",
      statuses: ["consumed"],
    });
    expect(blockedItems.some((item) => item.id === blocked.inboundItemId)).toBe(true);

    await runtime.close();
  });

  it("reblocks delivered steering items when a turn pauses for Human Approval", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "secret" }));
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: toolHandler,
    };
    let resolveChat!: (response: LlmResponse) => void;
    const chat = vi.fn(() => new Promise<LlmResponse>((resolve) => {
      resolveChat = resolve;
    }));
    currentClient = { chat };

    const runtime = await createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          tools: [guardedTool],
        },
      },
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));
    const turnPromise = runtime.processTurn("default", "run guarded", {
      conversationId: "conv-steered-human",
      idempotencyKey: "direct-human-steered",
    });
    for (let attempt = 0; attempt < 10 && chat.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(chat).toHaveBeenCalled();

    const delivered = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "arrived before human approval pause" }],
        properties: { id: "evt-steered-before-human" },
        conversationId: "conv-steered-human",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: new Date().toISOString(),
        },
      },
    });
    expect(delivered.disposition).toBe("delivered");

    resolveChat({
      text: "need tool",
      toolCalls: [{ toolCallId: "call-steered", toolName: "guarded", args: {} }],
    });
    const result = await turnPromise;

    const items = await inboundStore.listInboundItems({ conversationId: "conv-steered-human" });
    const steeredItem = items.find((item) => item.id === delivered.inboundItemId);

    expect(result.status).toBe("waitingForHuman");
    expect(steeredItem?.status).toBe("blocked");
    expect(steeredItem?.blockedBy?.type).toBe("humanApproval");

    await runtime.close();
  });

  it("marks failed Human Approval resumes with the acquired lease owner", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const markFailed = vi.spyOn(humanApprovalStore, "markApprovalFailed");
    vi.spyOn(humanApprovalStore, "markApprovalCompleted").mockRejectedValueOnce(
      new Error("completion write failed"),
    );
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: vi.fn(async () => ({ type: "text" as const, text: "secret" })),
    };
    currentClient = mockClient({
      text: "need tool",
      toolCalls: [{ toolCallId: "call-failed-resume", toolName: "guarded", args: {} }],
    });

    const runtime = await createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          tools: [guardedTool],
        },
      },
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));

    const result = await runtime.processTurn("default", "run guarded", {
      conversationId: "conv-failed-resume",
      idempotencyKey: "direct-human-failed-resume",
    });
    expect(result.status).toBe("waitingForHuman");

    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-failed-resume" });
    await runtime.control.submitHumanResult!({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-failed-resume",
    });
    const resumed = await runtime.control.resumeHumanApproval?.(tasks[0].humanApprovalId);

    expect(resumed?.status).toBe("failed");
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({
      humanApprovalId: tasks[0].humanApprovalId,
      leaseOwner: "runtime",
      reason: "completion write failed",
    }));

    await runtime.close();
  });

  it("reacquires resuming Human Approvals after resume lease expiry", async () => {
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const created = await humanApprovalStore.createApproval({
      humanApprovalId: "gate-resume-expiry",
      toolCall: {
        turnId: "turn-resume-expiry",
        agentName: "default",
        conversationId: "conv-resume-expiry",
        stepNumber: 1,
        toolCallId: "call-resume-expiry",
        toolName: "guarded",
        toolArgs: {},
      },
      tasks: [{ humanTaskId: "task-resume-expiry", type: "approval", required: true }],
      now: "2026-01-01T00:00:00.000Z",
    });
    await humanApprovalStore.submitResult({
      humanTaskId: created.tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approval-resume-expiry",
      now: "2026-01-01T00:00:01.000Z",
    });

    const first = await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-1",
      leaseTtlMs: 1_000,
      now: "2026-01-01T00:00:02.000Z",
    });
    const blockedByActiveLease = await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-2",
      leaseTtlMs: 1_000,
      now: "2026-01-01T00:00:02.500Z",
    });
    const reacquired = await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-2",
      leaseTtlMs: 1_000,
      now: "2026-01-01T00:00:03.001Z",
    });
    await humanApprovalStore.markApprovalHandlerStarted({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-2",
      now: "2026-01-01T00:00:03.002Z",
    });
    const blockedAfterHandlerStarted = await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-3",
      leaseTtlMs: 1_000,
      now: "2026-01-01T00:00:04.003Z",
    });

    expect(first?.status).toBe("resuming");
    expect(first?.lease?.owner).toBe("worker-1");
    expect(blockedByActiveLease).toBeNull();
    expect(reacquired?.status).toBe("resuming");
    expect(reacquired?.lease?.owner).toBe("worker-2");
    expect(blockedAfterHandlerStarted).toBeNull();
  });

  it("releases blocked inbound items when canceling a Human Approval", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const canceledEvents: unknown[] = [];
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "secret" }));
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: toolHandler,
    };
    currentClient = mockClient({
      text: "need tool",
      toolCalls: [{ toolCallId: "call-cancel", toolName: "guarded", args: {} }],
    });

    const runtime = await createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          tools: [guardedTool],
        },
      },
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));
    runtime.events.on("humanApproval.canceled", (event) => {
      canceledEvents.push(event);
    });

    const result = await runtime.processTurn("default", "run guarded", {
      conversationId: "conv-cancel-human",
      idempotencyKey: "direct-human-cancel",
    });
    expect(result.status).toBe("waitingForHuman");
    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-cancel-human" });

    const blocked = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "while waiting then canceled" }],
        properties: { id: "evt-cancel-blocked" },
        conversationId: "conv-cancel-human",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: new Date().toISOString(),
        },
      },
    });
    expect(blocked.disposition).toBe("blocked");

    const canceled = await runtime.control.cancelHumanApproval?.(tasks[0].humanApprovalId);
    const blockedItems = await inboundStore.listInboundItems({
      conversationId: "conv-cancel-human",
      statuses: ["blocked"],
    });
    let consumedItems = await inboundStore.listInboundItems({
      conversationId: "conv-cancel-human",
      statuses: ["consumed"],
    });
    for (let attempt = 0; attempt < 10 && !consumedItems.some((item) => item.id === blocked.inboundItemId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      consumedItems = await inboundStore.listInboundItems({
        conversationId: "conv-cancel-human",
        statuses: ["consumed"],
      });
    }

    expect(canceled?.status).toBe("canceled");
    expect(canceledEvents).toHaveLength(1);
    expect((canceledEvents[0] as any).humanApprovalId).toBe(tasks[0].humanApprovalId);
    expect(blockedItems.some((item) => item.id === blocked.inboundItemId)).toBe(false);
    expect(consumedItems.some((item) => item.id === blocked.inboundItemId)).toBe(true);

    await runtime.close();
  });

  it("dead-letters blocked inbound items when expiring a Human Approval", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const canceledEvents: unknown[] = [];
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: vi.fn(async () => ({ type: "text" as const, text: "secret" })),
    };
    currentClient = mockClient({
      text: "need tool",
      toolCalls: [{ toolCallId: "call-expire", toolName: "guarded", args: {} }],
    });

    const runtime = await createHarness(baseConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test" },
          tools: [guardedTool],
        },
      },
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));
    runtime.events.on("humanApproval.canceled", (event) => {
      canceledEvents.push(event);
    });

    const result = await runtime.processTurn("default", "run guarded", {
      conversationId: "conv-expire-human",
      idempotencyKey: "direct-human-expire",
    });
    expect(result.status).toBe("waitingForHuman");
    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-expire-human" });

    const blocked = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "while waiting then expired" }],
        properties: { id: "evt-expire-blocked" },
        conversationId: "conv-expire-human",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: new Date().toISOString(),
        },
      },
    });
    expect(blocked.disposition).toBe("blocked");

    const expired = await runtime.control.cancelHumanApproval?.({
      humanApprovalId: tasks[0].humanApprovalId,
      expired: true,
      reason: "approval expired",
    });
    const pendingItems = await inboundStore.listInboundItems({
      conversationId: "conv-expire-human",
      statuses: ["pending"],
    });
    const deadLetterItems = await inboundStore.listInboundItems({
      conversationId: "conv-expire-human",
      statuses: ["deadLetter"],
    });

    expect(expired?.status).toBe("expired");
    expect(canceledEvents).toHaveLength(1);
    expect((canceledEvents[0] as any).humanApprovalId).toBe(tasks[0].humanApprovalId);
    expect((canceledEvents[0] as any).reason).toBe("approval expired");
    expect(pendingItems.some((item) => item.id === blocked.inboundItemId)).toBe(false);
    expect(deadLetterItems.some((item) => item.id === blocked.inboundItemId)).toBe(true);

    await runtime.close();
  });

  it("rejects resume when a Human Approval record is missing", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));

    await expect(runtime.control.resumeHumanApproval?.("missing-gate")).rejects.toThrow(/Unknown human approval/);

    await runtime.close();
  });

  it("rejects invalid Human Task submissions through the control API", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));

    await expect(runtime.control.submitHumanResult!({
      humanTaskId: "missing-task",
      result: { type: "approval", approved: true },
      idempotencyKey: "missing-task-result",
    })).rejects.toThrow(/Unknown human task/);

    await runtime.close();
  });

  it("returns failed when resuming a terminal non-completed Human Approval", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const created = await humanApprovalStore.createApproval({
      humanApprovalId: "gate-canceled-terminal",
      toolCall: {
        turnId: "turn-canceled-terminal",
        agentName: "default",
        conversationId: "conv-canceled-terminal",
        stepNumber: 1,
        toolCallId: "call-canceled-terminal",
        toolName: "guarded",
        toolArgs: {},
      },
      tasks: [{ humanTaskId: "task-canceled-terminal", type: "approval", required: true }],
    });
    await humanApprovalStore.cancelApproval({ humanApprovalId: created.approval.id, reason: "operator canceled" });

    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));

    const resumed = await runtime.control.resumeHumanApproval?.(created.approval.id);

    expect(resumed?.status).toBe("failed");
    expect(resumed?.approval.status).toBe("canceled");

    await runtime.close();
  });

  it("requires durable inbound whenever Human Approval is configured", async () => {
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "secret" }));
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
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
      humanApproval: { store: humanApprovalStore as any },
    }))).rejects.toThrow(/requires durableInbound\.store/);

    await expect(createHarness(baseConfig({
      connections: undefined,
      humanApproval: { store: humanApprovalStore as any },
    }))).rejects.toThrow(/requires durableInbound\.store/);
  });
});

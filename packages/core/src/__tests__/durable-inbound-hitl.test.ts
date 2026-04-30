import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Connector,
  Extension,
  HarnessConfig,
  LlmClient,
  LlmResponse,
  ToolContext,
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

  it("clears stale delivery metadata when releasing blocked inbound items", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const appended = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-release-blocked-metadata",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "blocked after delivery" }],
        properties: { id: "evt-release-blocked-metadata" },
        conversationId: "conv-release-blocked-metadata",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "ingress",
        connectionName: "test",
        externalId: "evt-release-blocked-metadata",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "ingress:test:default:conv-release-blocked-metadata:evt-release-blocked-metadata",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.markDelivered({
      id: appended.item.id,
      turnId: "turn-before-block",
      now: "2026-01-01T00:00:01.000Z",
    });
    await inboundStore.markBlocked({
      id: appended.item.id,
      blockedBy: { type: "humanApproval", id: "approval-release-blocked-metadata" },
      now: "2026-01-01T00:00:02.000Z",
    });

    const [released] = await inboundStore.releaseBlockedInboundItems({
      conversationId: "conv-release-blocked-metadata",
      blockedBy: { type: "humanApproval", id: "approval-release-blocked-metadata" },
      now: "2026-01-01T00:00:03.000Z",
    });

    expect(released.status).toBe("pending");
    expect(released.turnId).toBeUndefined();
    expect(released.commitRef).toBeUndefined();
    expect(released.blockedBy).toBeUndefined();
  });

  it("does not expose releaseInboundItem control when the store has no release API", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const storeWithoutRelease = new Proxy(inboundStore, {
      get(target, property, receiver) {
        if (property === "releaseInboundItem") {
          return undefined;
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: storeWithoutRelease as any },
    }));

    expect(runtime.control.releaseInboundItem).toBeUndefined();

    await runtime.close();
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

  it("does not deduplicate no-id ingress deliveries that differ by receivedAt", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const first = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "hi" }],
        properties: {},
        conversationId: "conv-repeat-ingress",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const second = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "hi" }],
        properties: {},
        conversationId: "conv-repeat-ingress",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:01.000Z",
        },
      },
    });
    const items = await inboundStore.listInboundItems({ conversationId: "conv-repeat-ingress" });

    expect(first.disposition).not.toBe("duplicate");
    expect(second.disposition).not.toBe("duplicate");
    expect(second.inboundItemId).not.toBe(first.inboundItemId);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.idempotencyKey)).size).toBe(2);

    await runtime.close();
  });

  it("uses normalized content in fallback ingress idempotency keys", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const first = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "first message" }],
        properties: {},
        conversationId: "conv-no-external-content",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const second = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "second message" }],
        properties: {},
        conversationId: "conv-no-external-content",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:01.000Z",
        },
      },
    });
    const items = await inboundStore.listInboundItems({ conversationId: "conv-no-external-content" });

    expect(first.disposition).not.toBe("duplicate");
    expect(second.disposition).not.toBe("duplicate");
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.idempotencyKey)).size).toBe(2);

    await runtime.close();
  });

  it("treats blank ingress external ids as missing", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const first = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "blank id first" }],
        properties: { id: "" },
        conversationId: "conv-blank-external-id",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const second = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "blank id second" }],
        properties: { id: "" },
        conversationId: "conv-blank-external-id",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:01.000Z",
        },
      },
    });
    const items = await inboundStore.listInboundItems({ conversationId: "conv-blank-external-id" });

    expect(first.disposition).not.toBe("duplicate");
    expect(second.disposition).not.toBe("duplicate");
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.idempotencyKey)).size).toBe(2);

    await runtime.close();
  });

  it("uses numeric ingress external ids as provider idempotency ids", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const first = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "numeric id" }],
        properties: { id: 42 },
        conversationId: "conv-numeric-external-id",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const second = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "numeric id" }],
        properties: { id: 42 },
        conversationId: "conv-numeric-external-id",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:01.000Z",
        },
      },
    });
    const items = await inboundStore.listInboundItems({ conversationId: "conv-numeric-external-id" });

    expect(first.disposition).not.toBe("duplicate");
    expect(second.disposition).toBe("duplicate");
    expect(second.inboundItemId).toBe(first.inboundItemId);
    expect(items).toHaveLength(1);
    expect(items[0].source.externalId).toBe("42");
    expect(items[0].idempotencyKey).toBe("ingress:test:default:conv-numeric-external-id:message.created:42");

    await runtime.close();
  });

  it("uses stable property serialization in fallback ingress idempotency keys", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const first = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "same event" }],
        properties: { b: 2, a: 1 },
        conversationId: "conv-stable-fallback",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const second = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "same event" }],
        properties: { a: 1, b: 2 },
        conversationId: "conv-stable-fallback",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const items = await inboundStore.listInboundItems({ conversationId: "conv-stable-fallback" });

    expect(first.disposition).not.toBe("duplicate");
    expect(second.disposition).toBe("duplicate");
    expect(second.inboundItemId).toBe(first.inboundItemId);
    expect(items).toHaveLength(1);

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

  it("caches the active turn result for durable direct input delivered to that turn", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    let resolveFirstChat!: (response: LlmResponse) => void;
    const chat = vi.fn(async () => {
      if (chat.mock.calls.length === 1) {
        return new Promise<LlmResponse>((resolve) => {
          resolveFirstChat = resolve;
        });
      }
      return { text: "active turn completed with delivered input", toolCalls: [] };
    });
    currentClient = { chat };
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));

    const firstTurn = runtime.processTurn("default", "active turn", {
      conversationId: "conv-active-direct-cache",
      idempotencyKey: "direct-active-cache-first",
    });
    for (let attempt = 0; attempt < 10 && chat.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const deliveredTurn = runtime.processTurn("default", "delivered direct input", {
      conversationId: "conv-active-direct-cache",
      idempotencyKey: "direct-active-cache-delivered",
    });
    resolveFirstChat({ text: "first step", toolCalls: [] });

    const firstResult = await firstTurn;
    const deliveredResult = await deliveredTurn;
    const duplicateResult = await runtime.processTurn("default", "delivered direct input", {
      conversationId: "conv-active-direct-cache",
      idempotencyKey: "direct-active-cache-delivered",
    });

    expect(firstResult.status).toBe("completed");
    expect(deliveredResult.status).toBe("completed");
    expect(deliveredResult.text).toBe("active turn completed with delivered input");
    expect(duplicateResult.status).toBe("completed");
    expect(duplicateResult.text).toBe("active turn completed with delivered input");
    expect(chat).toHaveBeenCalledTimes(2);

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

  it("reports background scheduling failures after inbound retry", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const appended = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-retry-schedule-fail",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "retry me" }],
        properties: { id: "evt-retry-schedule-fail" },
        conversationId: "conv-retry-schedule-fail",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "ingress",
        connectionName: "test",
        externalId: "evt-retry-schedule-fail",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "ingress:test:default:conv-retry-schedule-fail:evt-retry-schedule-fail",
      now: "2026-01-01T00:00:00.000Z",
    });
    await inboundStore.deadLetterInboundItem({
      id: appended.item.id,
      reason: "operator test",
      now: "2026-01-01T00:00:01.000Z",
    });
    vi.spyOn(humanApprovalStore, "getConversationBlocker").mockRejectedValueOnce(
      new Error("blocker lookup unavailable"),
    );
    const failures: any[] = [];
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
      humanApproval: { store: humanApprovalStore as any },
    }));
    runtime.events.on("inbound.failed", (event) => failures.push(event));

    const retried = await runtime.control.retryInboundItem?.(appended.item.id);
    expect(retried?.status).toBe("pending");

    for (let attempt = 0; attempt < 20 && failures.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      type: "inbound.failed",
      inboundItemId: appended.item.id,
      retryable: true,
      reason: "blocker lookup unavailable",
    });

    await runtime.close();
  });

  it("emits inbound.deadLettered when operator dead-letters an inbound item", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const appended = await inboundStore.append({
      agentName: "default",
      conversationId: "conv-operator-dead-letter",
      envelope: {
        name: "message.created",
        content: [{ type: "text", text: "dead letter me" }],
        properties: { id: "evt-operator-dead-letter" },
        conversationId: "conv-operator-dead-letter",
        source: {
          connector: "test",
          connectionName: "test",
          receivedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      source: {
        kind: "ingress",
        connectionName: "test",
        externalId: "evt-operator-dead-letter",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      idempotencyKey: "ingress:test:default:conv-operator-dead-letter:evt-operator-dead-letter",
      now: "2026-01-01T00:00:00.000Z",
    });
    const deadLetterEvents: unknown[] = [];
    const runtime = await createHarness(baseConfig({
      durableInbound: { enabled: true, store: inboundStore as any },
    }));
    runtime.events.on("inbound.deadLettered", (event) => deadLetterEvents.push(event));

    const deadLettered = await runtime.control.deadLetterInboundItem?.({
      id: appended.item.id,
      reason: "operator decision",
    });

    expect(deadLettered?.status).toBe("deadLetter");
    expect(deadLetterEvents).toHaveLength(1);
    expect(deadLetterEvents[0]).toMatchObject({
      type: "inbound.deadLettered",
      inboundItemId: appended.item.id,
      reason: "operator decision",
    });

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
    const stepErrors: unknown[] = [];
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
    runtime.events.on("step.error", (event) => {
      stepErrors.push(event);
    });

    const result = await runtime.processTurn("default", "run guarded", {
      conversationId: "conv-human",
      idempotencyKey: "direct-human-1",
    });

    expect(result.status).toBe("waitingForHuman");
    expect(stepErrors).toHaveLength(0);
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
    expect(submitResult.approval.agentName).toBe("default");
    expect(submitResult.approval.conversationId).toBe("conv-human");
    expect(submitResult.approval.turnId).toEqual(expect.any(String));
    expect(submitResult.approval.toolCallId).toBe("call-1");
    expect(submitResult.approval.requiredTaskIds).toEqual([tasks[0].id]);
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
      retryable: true,
    }));
    expect(resumed?.approval.failure?.retryable).toBe(true);

    const reacquired = await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: tasks[0].humanApprovalId,
      leaseOwner: "worker-retry",
      leaseTtlMs: 10_000,
    });
    expect(reacquired?.status).toBe("resuming");
    expect(reacquired?.lease?.owner).toBe("worker-retry");

    await runtime.close();
  });

  it("aborts in-flight resumed Human Approval tool execution through runtime control", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    let capturedSignal: AbortSignal | undefined;
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: vi.fn(async (_args: unknown, ctx: ToolContext) => {
        capturedSignal = ctx.abortSignal;
        return new Promise<any>((resolve) => {
          ctx.abortSignal.addEventListener("abort", () => {
            resolve({ type: "text", text: "aborted" });
          }, { once: true });
        });
      }),
    };
    currentClient = mockClient({
      text: "need tool",
      toolCalls: [{ toolCallId: "call-abort-resume", toolName: "guarded", args: {} }],
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
      conversationId: "conv-abort-resume",
      idempotencyKey: "direct-human-abort-resume",
    });
    expect(result.status).toBe("waitingForHuman");

    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-abort-resume" });
    await runtime.control.submitHumanResult!({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-abort-resume",
    });
    const resumePromise = runtime.control.resumeHumanApproval!(tasks[0].humanApprovalId);

    for (let attempt = 0; attempt < 10 && !capturedSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(capturedSignal).toBeDefined();

    const abortResult = await runtime.control.abortConversation({
      conversationId: "conv-abort-resume",
      reason: "abort resume",
    });
    const resumed = await resumePromise;

    expect(abortResult.abortedTurns).toBe(1);
    expect(capturedSignal?.aborted).toBe(true);
    expect(resumed.status).toBe("failed");
    expect(resumed.approval.failure?.reason).toBe("abort resume");
    expect(resumed.approval.failure?.retryable).toBe(true);

    await runtime.close();
  });

  it("drains inbound items that become blocked while completing a Human Approval", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: vi.fn(async () => ({ type: "text" as const, text: "secret" })),
    };
    currentClient = mockClient([
      {
        text: "need tool",
        toolCalls: [{ toolCallId: "call-completion-race", toolName: "guarded", args: {} }],
      },
      { text: "continued after completion race", toolCalls: [] },
    ]);

    let runtime: Awaited<ReturnType<typeof createHarness>>;
    let lateInboundItemId = "";
    const markCompleted = humanApprovalStore.markApprovalCompleted.bind(humanApprovalStore);
    vi.spyOn(humanApprovalStore, "markApprovalCompleted").mockImplementation(async (input) => {
      if (!lateInboundItemId) {
        const late = await runtime.ingress.dispatch({
          connectionName: "test",
          envelope: {
            name: "message.created",
            content: [{ type: "text", text: "blocked during completion" }],
            properties: { id: "evt-completion-race" },
            conversationId: "conv-completion-race",
            source: {
              connector: "test",
              connectionName: "test",
              receivedAt: new Date().toISOString(),
            },
          },
        });
        expect(late.disposition).toBe("blocked");
        lateInboundItemId = String(late.inboundItemId);
      }
      return markCompleted(input as any);
    });

    runtime = await createHarness(baseConfig({
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
      conversationId: "conv-completion-race",
      idempotencyKey: "direct-human-completion-race",
    });
    expect(result.status).toBe("waitingForHuman");

    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-completion-race" });
    await runtime.control.submitHumanResult!({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-completion-race",
    });
    const resumed = await runtime.control.resumeHumanApproval!(tasks[0].humanApprovalId);
    const consumed = await inboundStore.listInboundItems({
      conversationId: "conv-completion-race",
      statuses: ["consumed"],
    });

    expect(resumed.status).toBe("completed");
    expect(lateInboundItemId).not.toBe("");
    expect(consumed.some((item) => item.id === lateInboundItemId)).toBe(true);

    await runtime.close();
  });

  it("delivers inbound arriving after approval completion to the prepared continuation turn", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const guardedTool: ToolDefinition = {
      name: "guarded",
      description: "guarded tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      humanApproval: { required: true, prompt: "Approve?" },
      handler: vi.fn(async () => ({ type: "text" as const, text: "secret" })),
    };
    currentClient = mockClient([
      {
        text: "need tool",
        toolCalls: [{ toolCallId: "call-handoff", toolName: "guarded", args: {} }],
      },
      { text: "continued after handoff", toolCalls: [] },
    ]);

    let runtime: Awaited<ReturnType<typeof createHarness>>;
    let handoffDispatch: any;
    const markCompleted = humanApprovalStore.markApprovalCompleted.bind(humanApprovalStore);
    vi.spyOn(humanApprovalStore, "markApprovalCompleted").mockImplementation(async (input) => {
      const completed = await markCompleted(input as any);
      handoffDispatch = await runtime.ingress.dispatch({
        connectionName: "test",
        envelope: {
          name: "message.created",
          content: [{ type: "text", text: "arrived during handoff" }],
          properties: { id: "evt-handoff-delivered" },
          conversationId: "conv-handoff-delivered",
          source: {
            connector: "test",
            connectionName: "test",
            receivedAt: new Date().toISOString(),
          },
        },
      });
      return completed;
    });

    runtime = await createHarness(baseConfig({
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
      conversationId: "conv-handoff-delivered",
      idempotencyKey: "direct-human-handoff-delivered",
    });
    expect(result.status).toBe("waitingForHuman");

    const tasks = await humanApprovalStore.listTasks({ conversationId: "conv-handoff-delivered" });
    await runtime.control.submitHumanResult!({
      humanTaskId: tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-handoff-delivered",
    });
    const resumed = await runtime.control.resumeHumanApproval!(tasks[0].humanApprovalId);
    const handoffItems = await inboundStore.listInboundItems({
      conversationId: "conv-handoff-delivered",
      statuses: ["consumed"],
    });

    expect(handoffDispatch?.disposition).toBe("delivered");
    expect(handoffDispatch?.turnId).toBe(resumed.continuation?.turnId);
    expect(resumed.status).toBe("completed");
    expect(resumed.continuation?.status).toBe("completed");
    expect(handoffItems.some((item) => item.id === handoffDispatch?.inboundItemId)).toBe(true);

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

  it("keeps conversation blocked while another Human Approval in the same conversation is active", async () => {
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const first = await humanApprovalStore.createApproval({
      humanApprovalId: "approval-shared-1",
      toolCall: {
        turnId: "turn-shared-1",
        agentName: "default",
        conversationId: "conv-shared-blocker",
        stepNumber: 1,
        toolCallId: "call-shared-1",
        toolName: "guarded",
        toolArgs: {},
      },
      tasks: [{ humanTaskId: "task-shared-1", type: "approval", required: true }],
      now: "2026-01-01T00:00:00.000Z",
    });
    const second = await humanApprovalStore.createApproval({
      humanApprovalId: "approval-shared-2",
      toolCall: {
        turnId: "turn-shared-2",
        agentName: "default",
        conversationId: "conv-shared-blocker",
        stepNumber: 1,
        toolCallId: "call-shared-2",
        toolName: "guarded",
        toolArgs: {},
      },
      tasks: [{ humanTaskId: "task-shared-2", type: "approval", required: true }],
      now: "2026-01-01T00:00:01.000Z",
    });

    await humanApprovalStore.submitResult({
      humanTaskId: first.tasks[0].id,
      result: { type: "approval", approved: true },
      idempotencyKey: "approve-shared-1",
      now: "2026-01-01T00:00:02.000Z",
    });
    await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: first.approval.id,
      leaseOwner: "worker-1",
      now: "2026-01-01T00:00:03.000Z",
    });
    await humanApprovalStore.markApprovalCompleted({
      humanApprovalId: first.approval.id,
      leaseOwner: "worker-1",
      now: "2026-01-01T00:00:04.000Z",
    });
    const blockerAfterFirstCompletion = await humanApprovalStore.getConversationBlocker({
      agentName: "default",
      conversationId: "conv-shared-blocker",
    });

    await humanApprovalStore.cancelApproval({
      humanApprovalId: second.approval.id,
      reason: "operator cancel",
      now: "2026-01-01T00:00:05.000Z",
    });
    const blockerAfterSecondCancel = await humanApprovalStore.getConversationBlocker({
      agentName: "default",
      conversationId: "conv-shared-blocker",
    });

    expect(blockerAfterFirstCompletion?.id).toBe(second.approval.id);
    expect(blockerAfterSecondCancel).toBeNull();
  });

  it("keeps resuming and failed Human Approvals from being reopened by late task submissions", async () => {
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const created = await humanApprovalStore.createApproval({
      humanApprovalId: "approval-late-task",
      toolCall: {
        turnId: "turn-late-task",
        agentName: "default",
        conversationId: "conv-late-task",
        stepNumber: 1,
        toolCallId: "call-late-task",
        toolName: "guarded",
        toolArgs: {},
      },
      tasks: [
        { humanTaskId: "task-required", type: "approval", title: "Required approval", required: true },
        { humanTaskId: "task-optional", type: "text", title: "Optional note", required: false },
      ],
      now: "2026-01-01T00:00:00.000Z",
    });

    const listedTasks = await humanApprovalStore.listTasks({ humanApprovalId: created.approval.id });
    expect(listedTasks.find((task) => task.id === "task-required")?.title).toBe("Required approval");
    expect(listedTasks.find((task) => task.id === "task-optional")?.title).toBe("Optional note");

    await humanApprovalStore.submitResult({
      humanTaskId: "task-required",
      result: { type: "approval", approved: true },
      idempotencyKey: "required-result",
      now: "2026-01-01T00:00:01.000Z",
    });
    const resuming = await humanApprovalStore.acquireApprovalForResume({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-1",
      leaseTtlMs: 10_000,
      now: "2026-01-01T00:00:02.000Z",
    });
    const lateWhileResuming = await humanApprovalStore.submitResult({
      humanTaskId: "task-optional",
      result: { type: "text", text: "late note" },
      idempotencyKey: "late-resuming",
      now: "2026-01-01T00:00:03.000Z",
    });
    const stillResuming = await humanApprovalStore.getApproval(created.approval.id);

    await humanApprovalStore.markApprovalFailed({
      humanApprovalId: created.approval.id,
      leaseOwner: "worker-1",
      reason: "resume failed",
      retryable: true,
      now: "2026-01-01T00:00:04.000Z",
    });
    const lateWhileFailed = await humanApprovalStore.submitResult({
      humanTaskId: "task-optional",
      result: { type: "text", text: "late note" },
      idempotencyKey: "late-failed",
      now: "2026-01-01T00:00:05.000Z",
    });
    const stillFailed = await humanApprovalStore.getApproval(created.approval.id);

    expect(resuming?.status).toBe("resuming");
    expect(lateWhileResuming.status).toBe("invalid");
    expect(stillResuming?.status).toBe("resuming");
    expect(lateWhileFailed.status).toBe("invalid");
    expect(stillFailed?.status).toBe("failed");
  });

  it("rejects human results that do not match the task type", async () => {
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const created = await humanApprovalStore.createApproval({
      humanApprovalId: "approval-type-mismatch",
      toolCall: {
        turnId: "turn-type-mismatch",
        agentName: "default",
        conversationId: "conv-type-mismatch",
        stepNumber: 1,
        toolCallId: "call-type-mismatch",
        toolName: "guarded",
        toolArgs: {},
      },
      tasks: [{ humanTaskId: "task-approval-only", type: "approval", required: true }],
    });

    const invalid = await humanApprovalStore.submitResult({
      humanTaskId: "task-approval-only",
      result: { type: "text", text: "not an approval" },
      idempotencyKey: "type-mismatch",
    });
    const approval = await humanApprovalStore.getApproval(created.approval.id);
    const tasks = await humanApprovalStore.listTasks({ humanApprovalId: created.approval.id });

    expect(invalid.status).toBe("invalid");
    expect(approval?.status).toBe("waitingForHuman");
    expect(tasks[0].status).toBe("waitingForHuman");
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

    const repeatedCancel = await runtime.control.cancelHumanApproval?.(tasks[0].humanApprovalId);
    expect(repeatedCancel?.status).toBe("canceled");
    expect(canceledEvents).toHaveLength(1);

    await runtime.close();
  });

  it("dead-letters blocked inbound items when expiring a Human Approval", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const canceledEvents: unknown[] = [];
    const deadLetterEvents: unknown[] = [];
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
    runtime.events.on("inbound.deadLettered", (event) => {
      deadLetterEvents.push(event);
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
    expect(deadLetterEvents).toHaveLength(1);
    expect(deadLetterEvents[0]).toMatchObject({
      type: "inbound.deadLettered",
      inboundItemId: blocked.inboundItemId,
      reason: "approval expired",
    });
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

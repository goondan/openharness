import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  HarnessConfig,
  LlmClient,
  LlmResponse,
  Extension,
  ConnectionExtension,
  TurnResult,
  Message,
  ToolDefinition,
  InboundEnvelope,
} from "@goondan/openharness-types";
import { defineHarness, env } from "@goondan/openharness-types";
import { createInMemoryDurableInboundStore } from "@goondan/openharness-adapters";
import { createHarness } from "../create-harness.js";
import { HarnessError } from "../errors.js";

// ---------------------------------------------------------------------------
// Mock LlmClient factory — returns a simple text response
// ---------------------------------------------------------------------------

function mockLlmClient(text = "Hello from mock"): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ text, toolCalls: [] } satisfies LlmResponse),
  };
}

function createManualDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    agents: {
      default: {
        model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
      },
    },
    ...overrides,
  };
}

function passthroughConnector() {
  return {
    name: "passthrough",
    normalize: async () => {
      throw new Error("dispatch tests bypass normalize");
    },
  };
}

function makeTestEnvelope(conversationId: string): InboundEnvelope {
  return {
    name: "test.message",
    conversationId,
    content: [{ type: "text", text: "hello" }],
    properties: { id: `msg:${conversationId}` },
    source: {
      connector: "test",
      connectionName: "test",
      receivedAt: "2026-05-21T00:00:00.000Z",
    },
  };
}

// We need to mock createLlmClient so we don't need real API clients
vi.mock("../models/index.js", () => ({
  createLlmClient: vi.fn(() => mockLlmClient()),
}));

describe("createHarness", () => {
  beforeEach(async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockReset();
    vi.mocked(createLlmClient).mockImplementation(() => mockLlmClient());
  });

  // -----------------------------------------------------------------------
  // Test 1: createHarness with minimal config → returns HarnessRuntime
  // -----------------------------------------------------------------------
  it("returns a HarnessRuntime with all required surfaces", async () => {
    const runtime = await createHarness(minimalConfig());

    // Verify runtime has all required API surfaces
    const result = await runtime.processTurn("default", "verify surfaces");
    expect(result.status).toBe("completed");

    // Ingress pipeline is functional
    expect(runtime.ingress).toBeDefined();
    expect(typeof runtime.ingress.receive).toBe("function");

    // Runtime events surface is functional
    expect(runtime.events).toBeDefined();
    expect(typeof runtime.events.on).toBe("function");

    // Control surface is functional
    expect(runtime.control).toBeDefined();
    expect(typeof runtime.control.abortConversation).toBe("function");

    await runtime.close();
  });

  it("keeps direct idempotency keys compact", async () => {
    const inboundStore = createInMemoryDurableInboundStore();
    const runtime = await createHarness(
      minimalConfig({
        durableInbound: {
          enabled: true,
          store: inboundStore,
        },
      }),
    );

    const conversationId = "conv-direct-idempotency";
    const prompt = `payload-${"x".repeat(1200)}`;

    await runtime.processTurn("default", prompt, {
      conversationId,
      receivedAt: "2026-05-03T00:00:00.000Z",
    });

    const [item] = await inboundStore.listInboundItems({
      agentName: "default",
      conversationId,
    });

    expect(item.idempotencyKey).toMatch(
      /^direct:default:conv-direct-idempotency:[a-f0-9]{64}$/,
    );
    expect(item.idempotencyKey).not.toContain("payload-");
    expect(item.idempotencyKey.length).toBeLessThan(128);

    await runtime.close();
  });

  it("returns leaseConflict instead of starting an ingress turn when the coordinator reports an active owner", async () => {
    const llmClient = mockLlmClient("should not run");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const coordinator = {
      getStatus: vi.fn(async () => "active" as const),
      acquire: vi.fn(async () => ({ acquired: false as const, reason: "active" as const })),
      release: vi.fn(async () => undefined),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
      connections: {
        test: {
          connector: passthroughConnector(),
          rules: [{ match: { event: "test.message" }, agent: "default" }],
        },
      },
    });

    const result = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: makeTestEnvelope("conv-coordinator-active"),
    });

    expect(result.disposition).toBe("leaseConflict");
    expect(result.turnId).toBeUndefined();
    expect(coordinator.acquire).toHaveBeenCalledWith({
      agentName: "default",
      conversationId: "conv-coordinator-active",
      turnId: expect.any(String),
      purpose: "start",
    });
    expect(coordinator.release).not.toHaveBeenCalled();
    expect(llmClient.chat).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("returns leaseUnknown instead of starting an ingress turn when the coordinator cannot verify ownership", async () => {
    const llmClient = mockLlmClient("should not run");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const coordinator = {
      getStatus: vi.fn(async () => "unknown" as const),
      acquire: vi.fn(async () => ({ acquired: false as const, reason: "unknown" as const })),
      release: vi.fn(async () => undefined),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
      connections: {
        test: {
          connector: passthroughConnector(),
          rules: [{ match: { event: "test.message" }, agent: "default" }],
        },
      },
    });

    const result = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: makeTestEnvelope("conv-coordinator-unknown"),
    });

    expect(result.disposition).toBe("leaseUnknown");
    expect(result.turnId).toBeUndefined();
    expect(coordinator.release).not.toHaveBeenCalled();
    expect(llmClient.chat).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("reserves the local conversation slot before awaiting turn admission", async () => {
    const releaseChat = createManualDeferred<void>();
    const llmClient: LlmClient = {
      chat: vi.fn(async () => {
        await releaseChat.promise;
        return { text: "only one turn", toolCalls: [] } satisfies LlmResponse;
      }),
    };
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const runtime = await createHarness(minimalConfig());

    const first = runtime.processTurn("default", "first", {
      conversationId: "conv-local-admission-race",
    });
    const second = await runtime.processTurn("default", "second", {
      conversationId: "conv-local-admission-race",
    });

    expect(second.status).toBe("error");
    expect(second.error?.message).toContain("Conversation turn start rejected: active");
    expect(llmClient.chat).toHaveBeenCalledTimes(1);

    releaseChat.resolve();
    const firstResult = await first;
    expect(firstResult.status).toBe("completed");
    expect(llmClient.chat).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it("keeps durable ingress queued when the coordinator rejects turn start after append", async () => {
    const llmClient = mockLlmClient("queued later");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const inboundStore = createInMemoryDurableInboundStore();
    let ownerActive = true;
    const coordinator = {
      getStatus: vi.fn(async () => (ownerActive ? "active" as const : "inactive" as const)),
      acquire: vi.fn(async () =>
        ownerActive
          ? { acquired: false as const, reason: "active" as const }
          : { acquired: true as const, fenceToken: "queued-fence" },
      ),
      release: vi.fn(async () => undefined),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
      durableInbound: {
        enabled: true,
        store: inboundStore,
      },
      connections: {
        test: {
          connector: passthroughConnector(),
          rules: [{ match: { event: "test.message" }, agent: "default" }],
        },
      },
    });

    const result = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: makeTestEnvelope("conv-coordinator-queued"),
    });

    expect(result.disposition).toBe("queued");
    expect(result.turnId).toBeUndefined();
    expect(result.inboundItemId).toBeDefined();
    expect(llmClient.chat).not.toHaveBeenCalled();

    const [queued] = await inboundStore.listInboundItems({
      agentName: "default",
      conversationId: "conv-coordinator-queued",
    });
    expect(queued.status).toBe("pending");

    ownerActive = false;
    await runtime.control.retryInboundItem?.({ id: queued.id });
    await vi.waitFor(() => expect(llmClient.chat).toHaveBeenCalledTimes(1));

    const [consumed] = await inboundStore.listInboundItems({
      agentName: "default",
      conversationId: "conv-coordinator-queued",
    });
    expect(consumed.status).toBe("consumed");
    expect(coordinator.release).toHaveBeenCalledWith({
      agentName: "default",
      conversationId: "conv-coordinator-queued",
      turnId: expect.any(String),
      fenceToken: "queued-fence",
    });

    await runtime.close();
  });

  it("keeps retried durable ingress pending when the coordinator still rejects scheduler start", async () => {
    const llmClient = mockLlmClient("should not run");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const inboundStore = createInMemoryDurableInboundStore();
    const coordinator = {
      getStatus: vi.fn(async () => "active" as const),
      acquire: vi.fn(async () => ({ acquired: false as const, reason: "active" as const })),
      release: vi.fn(async () => undefined),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
      durableInbound: {
        enabled: true,
        store: inboundStore,
      },
      connections: {
        test: {
          connector: passthroughConnector(),
          rules: [{ match: { event: "test.message" }, agent: "default" }],
        },
      },
    });

    const result = await runtime.ingress.dispatch({
      connectionName: "test",
      envelope: makeTestEnvelope("conv-coordinator-retry-pending"),
    });
    expect(result.disposition).toBe("queued");

    await runtime.control.retryInboundItem?.({ id: result.inboundItemId! });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [item] = await inboundStore.listInboundItems({
      agentName: "default",
      conversationId: "conv-coordinator-retry-pending",
    });
    expect(item.status).toBe("pending");
    expect(item.turnId).toBeUndefined();
    expect(llmClient.chat).not.toHaveBeenCalled();
    expect(coordinator.release).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("releases the coordinator fence after an accepted turn finishes", async () => {
    const llmClient = mockLlmClient("coordinated answer");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const coordinator = {
      getStatus: vi.fn(async () => "inactive" as const),
      acquire: vi.fn(async () => ({ acquired: true as const, fenceToken: "fence-1" })),
      release: vi.fn(async () => undefined),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
    });

    const result = await runtime.processTurn("default", "hello", {
      conversationId: "conv-coordinator-release",
    });

    expect(result.status).toBe("completed");
    expect(coordinator.release).toHaveBeenCalledWith({
      agentName: "default",
      conversationId: "conv-coordinator-release",
      turnId: result.turnId,
      fenceToken: "fence-1",
    });

    await runtime.close();
  });

  it("waits for coordinator fence release before resolving a completed turn", async () => {
    const llmClient = mockLlmClient("coordinated answer");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const releaseEntered = createManualDeferred<void>();
    const releaseGate = createManualDeferred<void>();
    const coordinator = {
      getStatus: vi.fn(async () => "inactive" as const),
      acquire: vi.fn(async () => ({ acquired: true as const, fenceToken: "fence-delayed-release" })),
      release: vi.fn(async () => {
        releaseEntered.resolve();
        await releaseGate.promise;
      }),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
    });

    const turnPromise = runtime.processTurn("default", "hello", {
      conversationId: "conv-coordinator-delayed-release",
    });
    let settled = false;
    void turnPromise.finally(() => {
      settled = true;
    });

    await releaseEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseGate.resolve();
    const result = await turnPromise;
    expect(result.status).toBe("completed");
    expect(settled).toBe(true);

    await runtime.close();
  });

  it("rejects a completed turn when coordinator fence release fails", async () => {
    const llmClient = mockLlmClient("coordinated answer");
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => llmClient);
    const coordinator = {
      getStatus: vi.fn(async () => "inactive" as const),
      acquire: vi.fn(async () => ({ acquired: true as const, fenceToken: "fence-release-fails" })),
      release: vi.fn(async () => {
        throw new Error("coordinator release failed");
      }),
    };
    const runtime = await createHarness({
      ...minimalConfig(),
      conversationTurnCoordinator: coordinator,
    });

    await expect(runtime.processTurn("default", "hello", {
      conversationId: "conv-coordinator-release-fails",
    })).rejects.toThrow("coordinator release failed");
    expect(coordinator.release).toHaveBeenCalledWith({
      agentName: "default",
      conversationId: "conv-coordinator-release-fails",
      turnId: expect.any(String),
      fenceToken: "fence-release-fails",
    });

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 2: env() refs resolved at createHarness time
  // -----------------------------------------------------------------------
  it("resolves env() refs at createHarness time", async () => {
    const original = process.env["TEST_API_KEY"];
    process.env["TEST_API_KEY"] = "resolved-key-123";

    try {
      const { createLlmClient } = await import("../models/index.js");
      const config = minimalConfig({
        agents: {
          default: {
            model: { provider: "openai", model: "gpt-4", apiKey: env("TEST_API_KEY") },
          },
        },
      });

      const runtime = await createHarness(config);

      // createLlmClient should have been called with the resolved key
      expect(createLlmClient).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai", model: "gpt-4" }),
        "resolved-key-123",
      );

      await runtime.close();
    } finally {
      if (original === undefined) {
        delete process.env["TEST_API_KEY"];
      } else {
        process.env["TEST_API_KEY"] = original;
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Missing env var → clear error message (ConfigError)
  // -----------------------------------------------------------------------
  it("throws ConfigError when env var is missing", async () => {
    delete process.env["MISSING_KEY_XYZ"];

    const config = minimalConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: env("MISSING_KEY_XYZ") },
        },
      },
    });

    await expect(createHarness(config)).rejects.toThrow("MISSING_KEY_XYZ");
    await expect(createHarness(config)).rejects.toThrow(/not set/i);
  });

  it("allows model configs without top-level apiKey", async () => {
    const { createLlmClient } = await import("../models/index.js");

    const runtime = await createHarness({
      agents: {
        default: {
          model: {
            provider: "openai",
            model: "gpt-4.1-mini",
            providerOptions: {
              baseURL: "https://proxy.example.com/v1",
              project: "openharness",
            },
          },
        },
      },
    });

    expect(createLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4.1-mini",
        providerOptions: {
          baseURL: "https://proxy.example.com/v1",
          project: "openharness",
        },
      }),
      undefined,
    );

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 4: Extension registration order matches declaration order
  // -----------------------------------------------------------------------
  it("registers extensions in declaration order", async () => {
    const order: string[] = [];

    const ext1: Extension = {
      name: "ext-a",
      register: () => { order.push("ext-a"); },
    };
    const ext2: Extension = {
      name: "ext-b",
      register: () => { order.push("ext-b"); },
    };
    const ext3: Extension = {
      name: "ext-c",
      register: () => { order.push("ext-c"); },
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [ext1, ext2, ext3],
        },
      },
    };

    const runtime = await createHarness(config);
    expect(order).toEqual(["ext-a", "ext-b", "ext-c"]);
    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 5: Multiple agents — no crash
  // -----------------------------------------------------------------------
  it("handles multiple agents without error", async () => {
    const config: HarnessConfig = {
      agents: {
        agent1: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key1" },
        },
        agent2: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key2" },
        },
      },
    };

    const runtime = await createHarness(config);
    expect(runtime).toBeDefined();

    // Both agents should be usable — try processTurn with each
    const result1 = await runtime.processTurn("agent1", "hello");
    expect(result1.agentName).toBe("agent1");

    const result2 = await runtime.processTurn("agent2", "hello");
    expect(result2.agentName).toBe("agent2");

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 6: runtime.processTurn → calls executeTurn, returns TurnResult
  // -----------------------------------------------------------------------
  it("processTurn returns a TurnResult with correct values", async () => {
    const runtime = await createHarness(minimalConfig());

    const result = await runtime.processTurn("default", "test input");

    expect(result.agentName).toBe("default");
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Hello from mock");
    expect(typeof result.turnId).toBe("string");
    expect(result.turnId.length).toBeGreaterThan(0);
    expect(typeof result.conversationId).toBe("string");
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 7: runtime.close → rejects subsequent processTurn calls
  // -----------------------------------------------------------------------
  it("close() causes subsequent processTurn to throw", async () => {
    const runtime = await createHarness(minimalConfig());

    await runtime.close();

    await expect(runtime.processTurn("default", "hello")).rejects.toThrow(HarnessError);
    await expect(runtime.processTurn("default", "hello")).rejects.toThrow(/closed/i);
  });

  // -----------------------------------------------------------------------
  // Test 8: runtime.ingress.receive → delegates to IngressPipeline
  // -----------------------------------------------------------------------
  it("ingress.receive delegates to the IngressPipeline", async () => {
    const connector = {
      name: "test-connector",
      normalize: vi.fn().mockResolvedValue({
        name: "message",
        content: [{ type: "text" as const, text: "hello" }],
        properties: {},
        conversationId: "test-conv-1",
        source: { connector: "test-connector", connectionName: "test-conn", receivedAt: new Date().toISOString() },
      } satisfies InboundEnvelope),
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        "test-conn": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    };

    const runtime = await createHarness(config);

    const results = await runtime.ingress.receive({
      connectionName: "test-conn",
      payload: { text: "hello" },
    });

    expect(results.length).toBe(1);
    expect(results[0].accepted).toBe(true);
    expect(results[0].agentName).toBe("default");
    expect(connector.normalize).toHaveBeenCalled();

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 9: runtime.control.abortConversation → aborts correct conversation
  // -----------------------------------------------------------------------
  it("abortConversation aborts the correct conversation", async () => {
    // Use a slow mock to keep a turn in-flight
    const { createLlmClient } = await import("../models/index.js");
    let chatCalled: () => void;
    const chatStarted = new Promise<void>((resolve) => { chatCalled = resolve; });

    const slowClient: LlmClient = {
      chat: vi.fn().mockImplementation(
        (_msgs: Message[], _tools: ToolDefinition[], signal: AbortSignal) =>
          new Promise<LlmResponse>((resolve, reject) => {
            chatCalled!();
            const timer = setTimeout(() => resolve({ text: "done" }), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    (createLlmClient as ReturnType<typeof vi.fn>).mockReturnValue(slowClient);

    const runtime = await createHarness(minimalConfig());

    // Start a turn that will hang
    const turnPromise = runtime.processTurn("default", "long task", {
      conversationId: "conv-to-abort",
    });

    // Wait until the LLM mock is actually called (reliable latch, no sleep)
    await chatStarted;

    // Abort it
    const abortResult = await runtime.control.abortConversation({
      conversationId: "conv-to-abort",
      reason: "user cancelled",
    });

    expect(abortResult.conversationId).toBe("conv-to-abort");
    expect(abortResult.abortedTurns).toBeGreaterThanOrEqual(1);

    // The turn should resolve with aborted status
    const result = await turnPromise;
    expect(result.status).toBe("aborted");

    await runtime.close();
  });

  it("runtime.events exposes aborted turn.error payloads with status", async () => {
    const { createLlmClient } = await import("../models/index.js");
    let chatCalled: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      chatCalled = resolve;
    });
    const observedStatuses: Array<"aborted" | "error"> = [];

    const slowClient: LlmClient = {
      chat: vi.fn().mockImplementation(
        (_msgs: Message[], _tools: ToolDefinition[], signal: AbortSignal) =>
          new Promise<LlmResponse>((resolve, reject) => {
            chatCalled!();
            const timer = setTimeout(() => resolve({ text: "done" }), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    (createLlmClient as ReturnType<typeof vi.fn>).mockReturnValue(slowClient);

    const runtime = await createHarness(minimalConfig());
    const unsubscribe = runtime.events.on("turn.error", (payload) => {
      observedStatuses.push(payload.status);
    });

    const turnPromise = runtime.processTurn("default", "long task", {
      conversationId: "conv-runtime-event-abort",
    });

    await chatStarted;

    await runtime.control.abortConversation({
      conversationId: "conv-runtime-event-abort",
      reason: "user cancelled",
    });

    const result = await turnPromise;
    unsubscribe();

    expect(result.status).toBe("aborted");
    expect(observedStatuses).toEqual(["aborted"]);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 10: defineHarness is identity function (no side effects)
  // -----------------------------------------------------------------------
  it("defineHarness is an identity function with no side effects", () => {
    const config = minimalConfig();
    const result = defineHarness(config);

    // Same reference (identity function)
    expect(result).toBe(config);
    // No mutation
    expect(result).toEqual(config);
  });

  // -----------------------------------------------------------------------
  // Test 11: runtime snapshots include all agents and connections
  // -----------------------------------------------------------------------
  it("builds complete api.runtime snapshots before registering extensions", async () => {
    const snapshots: Array<{
      agentName: string;
      agentKeys: string[];
      connectionKeys: string[];
    }> = [];

    const captureRuntime = (name: string): Extension => ({
      name,
      register(api) {
        snapshots.push({
          agentName: api.runtime.agent.name,
          agentKeys: Object.keys(api.runtime.agents).sort(),
          connectionKeys: Object.keys(api.runtime.connections).sort(),
        });
      },
    });

    const runtime = await createHarness({
      agents: {
        agentA: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-a" },
          extensions: [captureRuntime("capture-a")],
        },
        agentB: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-b" },
          extensions: [captureRuntime("capture-b")],
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "conv-1",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "agentA" }],
        },
      },
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual([
      {
        agentName: "agentA",
        agentKeys: ["agentA", "agentB"],
        connectionKeys: ["inbound"],
      },
      {
        agentName: "agentB",
        agentKeys: ["agentA", "agentB"],
        connectionKeys: ["inbound"],
      },
    ]);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 12: conversation state is isolated per agent
  // -----------------------------------------------------------------------
  it("isolates conversation state by agent even when conversationId is shared", async () => {
    const { createLlmClient } = await import("../models/index.js");

    const agentAClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "agent-a-response" }),
    };
    const agentBClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "agent-b-response" }),
    };

    vi.mocked(createLlmClient)
      .mockReturnValueOnce(agentAClient)
      .mockReturnValueOnce(agentBClient);

    const runtime = await createHarness({
      agents: {
        agentA: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-a" },
        },
        agentB: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-b" },
        },
      },
    });

    await runtime.processTurn("agentA", "hello from agent A", {
      conversationId: "shared-conv",
    });
    await runtime.processTurn("agentB", "hello from agent B", {
      conversationId: "shared-conv",
    });

    const [messagesForAgentB] = vi.mocked(agentBClient.chat).mock.calls[0] as [
      Message[],
      unknown,
      unknown,
    ];

    expect(messagesForAgentB).toHaveLength(1);
    expect(messagesForAgentB[0]?.data.role).toBe("user");
    expect(messagesForAgentB[0]?.data.content).toBe("hello from agent B");

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 13: route middleware is connection-scoped (F5)
  // -----------------------------------------------------------------------
  it("runs connection-level route middleware and observes the matched agent", async () => {
    const routedAgents: string[] = [];

    const routeObserver: ConnectionExtension = {
      name: "route-observer",
      register(api) {
        api.pipeline.register("route", async (_ctx, next) => {
          const result = await next();
          routedAgents.push(result.agentName);
          return result;
        });
      },
    };

    const runtime = await createHarness({
      agents: {
        agentA: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-a" },
        },
        agentB: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-b" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "conv-1",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          extensions: [routeObserver],
          rules: [{ match: { event: "message" }, agent: "agentB" }],
        },
      },
    });

    const results = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "hello" },
    });

    expect(results).toHaveLength(1);
    expect(routedAgents).toEqual(["agentB"]);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 14: ingress accepted turnId matches turn.start turnId
  // -----------------------------------------------------------------------
  it("reuses the ingress turnId for the actual turn execution", async () => {
    let acceptedTurnId: string | undefined;
    let startedTurnId: string | undefined;

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
          extensions: [
            {
              name: "capture-turn-start",
              register(api) {
                api.on("turn.start", (payload) => {
                  startedTurnId = (payload as { turnId: string }).turnId;
                });
              },
            },
          ],
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "turn-id-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          extensions: [
            {
              name: "capture-ingress-accepted",
              register(api) {
                api.on("ingress.accepted", (payload) => {
                  acceptedTurnId = (payload as { turnId: string }).turnId;
                });
              },
            },
          ],
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });

    const results = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "hello" },
    });

    await Promise.resolve();

    expect(results).toHaveLength(1);
    expect(results[0]?.turnId).toBeTruthy();
    expect(acceptedTurnId).toBe(results[0]?.turnId);
    expect(startedTurnId).toBe(results[0]?.turnId);

    await runtime.close();
  });

  it("steers a second ingress message into an active turn for the same conversation", async () => {
    const { createLlmClient } = await import("../models/index.js");
    let releaseFirstResponse!: () => void;
    let firstChatStarted!: () => void;
    const firstChatStartedPromise = new Promise<void>((resolve) => {
      firstChatStarted = resolve;
    });
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const capturedMessages: Message[][] = [];
    let callCount = 0;

    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn(async (messages) => {
        capturedMessages.push([...(messages as Message[])]);
        callCount++;
        if (callCount === 1) {
          firstChatStarted();
          await firstResponseGate;
          return { text: "first answer", toolCalls: [] };
        }
        return { text: "answer after steer", toolCalls: [] };
      }),
    }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async (ctx) => ({
              name: "message",
              content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
              properties: {},
              conversationId: "steer-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: ctx.receivedAt,
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });

    const first = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "first" },
    });
    await firstChatStartedPromise;

    const second = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "second" },
    });

    releaseFirstResponse();

    await new Promise<void>((resolve) => {
      const unsubscribe = runtime.events.on("turn.done", () => {
        unsubscribe();
        resolve();
      });
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].disposition).toBe("started");
    expect(second[0].disposition).toBe("steered");
    expect(second[0].turnId).toBe(first[0].turnId);
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1].some((message) =>
      message.data.role === "user" && message.data.content === "second",
    )).toBe(true);

    await runtime.close();
  });

  it("tracks an active turn before turn.start listeners run", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn().mockResolvedValue({ text: "should not run", toolCalls: [] });
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    let runtime: Awaited<ReturnType<typeof createHarness>>;
    let resolveAbortedTurns!: (value: number) => void;
    const abortedTurnsPromise = new Promise<number>((resolve) => {
      resolveAbortedTurns = resolve;
    });

    runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
          extensions: [
            {
              name: "abort-on-turn-start",
              register(api) {
                api.on("turn.start", () => {
                  void runtime.control.abortConversation({
                    conversationId: "early-active-conv",
                    reason: "test abort from turn.start",
                  }).then((result) => resolveAbortedTurns(result.abortedTurns));
                });
              },
            },
          ],
        },
      },
    });

    const result = await runtime.processTurn("default", "start", {
      conversationId: "early-active-conv",
    });

    expect(await abortedTurnsPromise).toBe(1);
    expect(result.status).toBe("aborted");
    expect(chat).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("starts a new turn for ingress received while emitting turn.done", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const capturedMessages: Message[][] = [];
    const chat = vi.fn(async (messages) => {
      capturedMessages.push([...(messages as Message[])]);
      return { text: `answer ${capturedMessages.length}`, toolCalls: [] };
    });
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async (ctx) => ({
              name: "message",
              content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
              properties: {},
              conversationId: "done-boundary-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: ctx.receivedAt,
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });

    let secondIngressPromise: Promise<Awaited<ReturnType<typeof runtime.ingress.receive>>> | undefined;
    let resolveSecondIngressScheduled!: () => void;
    const secondIngressScheduled = new Promise<void>((resolve) => {
      resolveSecondIngressScheduled = resolve;
    });
    let doneCount = 0;
    const twoTurnsDone = new Promise<void>((resolve) => {
      const unsubscribe = runtime.events.on("turn.done", () => {
        doneCount++;
        if (doneCount === 1) {
          secondIngressPromise = runtime.ingress.receive({
            connectionName: "inbound",
            payload: { text: "second" },
          });
          resolveSecondIngressScheduled();
        }
        if (doneCount === 2) {
          unsubscribe();
          resolve();
        }
      });
    });

    const first = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "first" },
    });

    await secondIngressScheduled;
    const second = await secondIngressPromise!;
    await twoTurnsDone;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].disposition).toBe("started");
    expect(second[0].disposition).toBe("started");
    expect(second[0].turnId).not.toBe(first[0].turnId);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(capturedMessages[1].some((message) =>
      message.data.role === "user" && message.data.content === "second",
    )).toBe(true);

    await runtime.close();
  });

  it("runtime.events receives processTurn lifecycle events", async () => {
    const runtime = await createHarness(minimalConfig());
    const observed: TurnResult[] = [];

    const unsubscribe = runtime.events.on("turn.done", (payload) => {
      observed.push(payload.result);
    });

    const result = await runtime.processTurn("default", "capture runtime events");

    unsubscribe();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.turnId).toBe(result.turnId);
    expect(observed[0]?.conversationId).toBe(result.conversationId);

    await runtime.close();
  });

  it("runtime.events receives ingress lifecycle events", async () => {
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "runtime-events-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });
    const receivedTypes: string[] = [];

    const unsubReceived = runtime.events.on("ingress.received", (payload) => {
      receivedTypes.push(payload.type);
    });
    const unsubAccepted = runtime.events.on("ingress.accepted", (payload) => {
      receivedTypes.push(payload.type);
    });

    const results = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "hello" },
    });

    await Promise.resolve();

    unsubReceived();
    unsubAccepted();

    expect(results).toHaveLength(1);
    expect(receivedTypes).toEqual(["ingress.received", "ingress.accepted"]);

    await runtime.close();
  });
});

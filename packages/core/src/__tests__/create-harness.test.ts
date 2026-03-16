import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  HarnessConfig,
  LlmClient,
  LlmResponse,
  Extension,
  TurnResult,
  Message,
  ToolDefinition,
  InboundEnvelope,
} from "@goondan/openharness-types";
import { defineHarness, env } from "@goondan/openharness-types";
import { createHarness } from "../create-harness.js";

// ---------------------------------------------------------------------------
// Mock LlmClient factory — returns a simple text response
// ---------------------------------------------------------------------------

function mockLlmClient(text = "Hello from mock"): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ text, toolCalls: [] } satisfies LlmResponse),
  };
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

// We need to mock createLlmClient so we don't need real API clients
vi.mock("../models/index.js", () => ({
  createLlmClient: vi.fn(() => mockLlmClient()),
}));

describe("createHarness", () => {
  // -----------------------------------------------------------------------
  // Test 1: createHarness with minimal config → returns HarnessRuntime
  // -----------------------------------------------------------------------
  it("returns a HarnessRuntime with minimal config", async () => {
    const runtime = await createHarness(minimalConfig());

    expect(runtime).toBeDefined();
    expect(typeof runtime.processTurn).toBe("function");
    expect(typeof runtime.close).toBe("function");
    expect(runtime.ingress).toBeDefined();
    expect(runtime.control).toBeDefined();
    expect(typeof runtime.control.abortConversation).toBe("function");

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
  it("processTurn returns a TurnResult with correct shape", async () => {
    const runtime = await createHarness(minimalConfig());

    const result = await runtime.processTurn("default", "test input");

    expect(result).toBeDefined();
    expect(result.turnId).toBeDefined();
    expect(result.agentName).toBe("default");
    expect(result.conversationId).toBeDefined();
    expect(result.status).toBeDefined();
    expect(Array.isArray(result.steps)).toBe(true);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 7: runtime.close → rejects subsequent processTurn calls
  // -----------------------------------------------------------------------
  it("close() causes subsequent processTurn to throw", async () => {
    const runtime = await createHarness(minimalConfig());

    await runtime.close();

    await expect(runtime.processTurn("default", "hello")).rejects.toThrow(
      /closed/i,
    );
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
    const slowClient: LlmClient = {
      chat: vi.fn().mockImplementation(
        (_msgs: Message[], _tools: ToolDefinition[], signal: AbortSignal) =>
          new Promise<LlmResponse>((resolve, reject) => {
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

    // Give it a tick to start
    await new Promise((r) => setTimeout(r, 10));

    // Abort it
    const abortResult = await runtime.control.abortConversation({
      conversationId: "conv-to-abort",
      reason: "user cancelled",
    });

    expect(abortResult.conversationId).toBe("conv-to-abort");
    expect(abortResult.abortedTurns).toBeGreaterThanOrEqual(1);

    // The turn should resolve (with error or aborted status)
    const result = await turnPromise;
    expect(["aborted", "error"]).toContain(result.status);

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
});

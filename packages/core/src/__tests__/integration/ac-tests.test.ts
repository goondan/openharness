/**
 * Integration tests for all 14 Acceptance Criteria.
 *
 * Each test exercises actual code paths and verifies observable behavior
 * rather than just asserting that code runs without errors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  HarnessConfig,
  Extension,
  ExtensionApi,
  LlmClient,
  LlmResponse,
  Message,
  ToolDefinition,
  ToolCallContext,
  ToolResult,
  MessageEvent,
} from "@goondan/openharness-types";
import { defineHarness } from "@goondan/openharness-types";
import { createHarness } from "../../create-harness.js";
import { createConversationState } from "../../conversation-state.js";

// ---------------------------------------------------------------------------
// Inline implementations of base extensions
// (avoids adding @goondan/openharness-base as a test dependency of core)
// ---------------------------------------------------------------------------

function ContextMessage(text: string): Extension {
  return {
    name: "context-message",
    register(api: ExtensionApi): void {
      api.pipeline.register(
        "turn",
        async (ctx, next) => {
          ctx.conversation.emit({
            type: "append",
            message: {
              id: `ctx-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: "system",
              content: text,
            },
          });
          return next();
        },
        { priority: 10 },
      );
    },
  };
}

function MessageWindow(config: { maxMessages: number }): Extension {
  return {
    name: "message-window",
    register(api: ExtensionApi): void {
      api.pipeline.register("step", async (ctx, next) => {
        if (ctx.conversation.messages.length > config.maxMessages) {
          ctx.conversation.emit({
            type: "truncate",
            keepLast: config.maxMessages,
          });
        }
        return next();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CRITICAL: Mock createLlmClient so we never touch real API endpoints
// ---------------------------------------------------------------------------

vi.mock("../../models/index.js", () => ({
  createLlmClient: vi.fn(() => ({
    chat: vi.fn().mockResolvedValue({ text: "mock response", toolCalls: undefined }),
  })),
}));

// ---------------------------------------------------------------------------
// Helper: configurable mock LLM client
// ---------------------------------------------------------------------------

function mockLlmClient(responses?: LlmResponse[]): LlmClient {
  let callIdx = 0;
  return {
    chat: vi.fn().mockImplementation(async () => {
      if (responses && callIdx < responses.length) {
        return responses[callIdx++];
      }
      return { text: "default mock response" };
    }),
  };
}

// ---------------------------------------------------------------------------
// Helper: minimal harness config builder
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

// We capture the mock module for per-test control
let mockedCreateLlmClient: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const mod = await import("../../models/index.js");
  mockedCreateLlmClient = mod.createLlmClient as ReturnType<typeof vi.fn>;
  vi.clearAllMocks();
  // Restore default mock after clearAllMocks
  mockedCreateLlmClient.mockImplementation(() => ({
    chat: vi.fn().mockResolvedValue({ text: "mock response", toolCalls: undefined }),
  }));
});

// ===========================================================================
// AC-1: Minimal execution with ContextMessage
// ===========================================================================

describe("AC-1: Minimal execution with ContextMessage", () => {
  it("AC-1: ContextMessage prepends a system message and LLM receives it alongside the user message", async () => {
    const capturedChat = vi.fn().mockResolvedValue({ text: "AC-1 response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat });

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [ContextMessage("You are helpful.")],
        },
      },
    };

    const runtime = await createHarness(config);
    const result = await runtime.processTurn("default", "hello");

    // Verify LLM received messages
    expect(capturedChat).toHaveBeenCalledOnce();
    const [messagesArg] = capturedChat.mock.calls[0] as [Message[], unknown, unknown];

    // There must be a system message with the ContextMessage text
    const systemMessages = messagesArg.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
    expect(systemMessages.some((m) => m.content === "You are helpful.")).toBe(true);

    // There must be a user message with "hello"
    const userMessages = messagesArg.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(
      userMessages.some((m) => typeof m.content === "string" && m.content.includes("hello")),
    ).toBe(true);

    // TurnResult assertions
    expect(result.status).toBe("completed");
    expect(result.text).toBe("AC-1 response");

    await runtime.close();
  });
});

// ===========================================================================
// AC-2: No Extension = empty context to LLM
// ===========================================================================

describe("AC-2: No Extension = empty context to LLM", () => {
  it("AC-2: With no extensions and no tools, LLM receives only the user message and empty tools array", async () => {
    const capturedChat = vi.fn().mockResolvedValue({ text: "AC-2 response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat });

    const config: HarnessConfig = {
      agents: {
        assistant: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          // no extensions, no tools
        },
      },
    };

    const runtime = await createHarness(config);
    await runtime.processTurn("assistant", "hello");

    expect(capturedChat).toHaveBeenCalledOnce();
    const [messagesArg, toolsArg] = capturedChat.mock.calls[0] as [
      Message[],
      ToolDefinition[],
      unknown,
    ];

    // Only a user message — no system message injected
    const systemMessages = messagesArg.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(0);

    const userMessages = messagesArg.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);

    // tools parameter is empty array
    expect(toolsArg).toEqual([]);

    await runtime.close();
  });
});

// ===========================================================================
// AC-3: Extension swap (MessageWindow ↔ mock)
// ===========================================================================

describe("AC-3: Extension swap — MessageWindow truncates, no-op extension does not", () => {
  it("AC-3: MessageWindow limits messages seen by LLM; swapping it out gives LLM all messages", async () => {
    // We run multiple turns and inspect what the LLM receives on the last call.
    // With MessageWindow(maxMessages: 2), only the last 2 messages should reach the LLM.
    // Without MessageWindow, all messages accumulate.

    // --- Setup with MessageWindow ---
    const chatWithWindow = vi.fn().mockResolvedValue({ text: "response" });
    mockedCreateLlmClient.mockReturnValue({ chat: chatWithWindow });

    const configWithWindow: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [MessageWindow({ maxMessages: 2 })],
        },
      },
    };

    const convId = "ac3-conv";
    const runtimeWithWindow = await createHarness(configWithWindow);

    // Run 4 turns in the same conversation
    await runtimeWithWindow.processTurn("default", "turn 1", { conversationId: convId });
    await runtimeWithWindow.processTurn("default", "turn 2", { conversationId: convId });
    await runtimeWithWindow.processTurn("default", "turn 3", { conversationId: convId });
    await runtimeWithWindow.processTurn("default", "turn 4", { conversationId: convId });

    // The last call should have received at most 2 messages
    const lastCallWithWindow = chatWithWindow.mock.calls[chatWithWindow.mock.calls.length - 1];
    const messagesWithWindow = lastCallWithWindow[0] as Message[];
    expect(messagesWithWindow.length).toBeGreaterThanOrEqual(1);
    expect(messagesWithWindow.length).toBeLessThanOrEqual(2);

    await runtimeWithWindow.close();

    // --- Setup WITHOUT MessageWindow (no-op extension) ---
    const chatNoWindow = vi.fn().mockResolvedValue({ text: "response" });
    mockedCreateLlmClient.mockReturnValue({ chat: chatNoWindow });

    const noOpExtension: Extension = {
      name: "no-op",
      register: (_api: ExtensionApi) => {
        // Does nothing — does not truncate messages
      },
    };

    const configNoWindow: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [noOpExtension],
        },
      },
    };

    const runtimeNoWindow = await createHarness(configNoWindow);

    // Run same 4 turns
    await runtimeNoWindow.processTurn("default", "turn 1", { conversationId: convId });
    await runtimeNoWindow.processTurn("default", "turn 2", { conversationId: convId });
    await runtimeNoWindow.processTurn("default", "turn 3", { conversationId: convId });
    await runtimeNoWindow.processTurn("default", "turn 4", { conversationId: convId });

    const lastCallNoWindow = chatNoWindow.mock.calls[chatNoWindow.mock.calls.length - 1];
    const messagesNoWindow = lastCallNoWindow[0] as Message[];

    // Without window, more messages accumulate
    expect(messagesNoWindow.length).toBeGreaterThan(2);

    await runtimeNoWindow.close();
  });
});

// ===========================================================================
// AC-4: Event sourcing — restore(events) → identical messages
// ===========================================================================

describe("AC-4: Event sourcing — restore(events) produces identical messages", () => {
  it("AC-4: A new ConversationState restored from events has deeply equal messages to the original", () => {
    const original = createConversationState();

    // Manually activate turn so emit() works
    original["_turnActive"] = true;

    // Emit several events
    original.emit({
      type: "append",
      message: { id: "m1", role: "user", content: "hello" },
    });
    original.emit({
      type: "append",
      message: { id: "m2", role: "assistant", content: "hi there" },
    });
    original.emit({
      type: "append",
      message: { id: "m3", role: "user", content: "how are you?" },
    });
    original.emit({
      type: "append",
      message: { id: "m4", role: "assistant", content: "I am fine" },
    });

    const originalMessages = [...original.messages];
    const originalEvents = [...original.events] as MessageEvent[];

    // Create a new ConversationState and restore from events
    const restored = createConversationState();
    restored.restore(originalEvents);

    // Messages must be deeply equal
    expect(restored.messages).toEqual(originalMessages);
    expect(restored.messages).toHaveLength(4);
    expect(restored.messages[0]).toEqual({ id: "m1", role: "user", content: "hello" });
    expect(restored.messages[1]).toEqual({ id: "m2", role: "assistant", content: "hi there" });
    expect(restored.messages[2]).toEqual({ id: "m3", role: "user", content: "how are you?" });
    expect(restored.messages[3]).toEqual({ id: "m4", role: "assistant", content: "I am fine" });
  });

  it("AC-4: restore works with mixed event types (append + truncate)", () => {
    const original = createConversationState();
    original["_turnActive"] = true;

    for (let i = 1; i <= 5; i++) {
      original.emit({
        type: "append",
        message: { id: `m${i}`, role: "user", content: `message ${i}` },
      });
    }
    original.emit({ type: "truncate", keepLast: 2 });

    const events = [...original.events] as MessageEvent[];

    const restored = createConversationState();
    restored.restore(events);

    // After truncate keepLast: 2, we should have 2 messages
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages).toEqual(original.messages);
  });
});

// ===========================================================================
// AC-5: Persistence Extension — conversation survives restart
// ===========================================================================

describe("AC-5 & AC-6: Persistence Extension presence/absence", () => {
  it("AC-5: Persistence Extension saves events; new harness restores conversation so LLM sees prior history", async () => {
    // Storage shared between harness instances (simulates durable store)
    const eventStore = new Map<string, MessageEvent[]>();
    const convId = "ac5-conv";

    function createPersistenceExtension(): Extension {
      return {
        name: "persistence",
        register(api: ExtensionApi): void {
          // Use turn middleware to both restore (at start) and save (after next())
          api.pipeline.register("turn", async (ctx, next) => {
            // At turn start, executeTurn has already appended the user message (1 event).
            // If we have saved history, we need to restore the previous events +
            // keep the newly added user message.
            const saved = eventStore.get(ctx.conversationId);
            if (saved && saved.length > 0 && ctx.conversation.events.length === 1) {
              // Capture the current (new) user message event
              const currentEvents = [...ctx.conversation.events] as MessageEvent[];
              // Combine: saved history + new user message
              ctx.conversation.restore([...saved, ...currentEvents]);
            }

            // Run the turn
            const result = await next();

            // Save all events after the turn completes
            const events = [...ctx.conversation.events] as MessageEvent[];
            eventStore.set(ctx.conversationId, events);

            return result;
          });
        },
      };
    }

    // First harness instance — run 2 turns
    const capturedChat1 = vi.fn().mockResolvedValue({ text: "first harness response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat1 });

    const config1: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [createPersistenceExtension()],
        },
      },
    };

    const runtime1 = await createHarness(config1);
    await runtime1.processTurn("default", "hello from turn 1", { conversationId: convId });
    await runtime1.processTurn("default", "hello from turn 2", { conversationId: convId });
    await runtime1.close();

    // Verify events were saved
    expect(eventStore.has(convId)).toBe(true);
    const savedEvents = eventStore.get(convId)!;
    expect(savedEvents.length).toBeGreaterThan(0);

    // Second harness instance — simulate "restart"
    const capturedChat2 = vi.fn().mockResolvedValue({ text: "second harness response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat2 });

    const config2: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [createPersistenceExtension()],
        },
      },
    };

    const runtime2 = await createHarness(config2);
    await runtime2.processTurn("default", "hello from turn 3", { conversationId: convId });

    // The LLM on the second harness should see messages from the restored conversation
    expect(capturedChat2).toHaveBeenCalledOnce();
    const [messages] = capturedChat2.mock.calls[0] as [Message[], unknown, unknown];

    // The restored messages plus new user message from turn 3 should be present
    // There should be more than just the 1 new user message (proving history was restored)
    expect(messages.length).toBeGreaterThan(1);

    // Must contain at least one message from previous turns
    const userMessages = messages.filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        (m.content.includes("turn 1") || m.content.includes("turn 2")),
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(1);

    await runtime2.close();
  });

  it("AC-6: Without Persistence Extension, conversation starts fresh after harness restart", async () => {
    const convId = "ac6-conv";

    // First harness instance — run turns
    const capturedChat1 = vi.fn().mockResolvedValue({ text: "first response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat1 });

    const runtime1 = await createHarness(minimalConfig());
    await runtime1.processTurn("default", "hello from turn 1", { conversationId: convId });
    await runtime1.processTurn("default", "hello from turn 2", { conversationId: convId });
    await runtime1.close();

    // Second harness — no persistence, fresh start
    const capturedChat2 = vi.fn().mockResolvedValue({ text: "second response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat2 });

    const runtime2 = await createHarness(minimalConfig());
    await runtime2.processTurn("default", "hello from turn 3", { conversationId: convId });

    expect(capturedChat2).toHaveBeenCalledOnce();
    const [messages] = capturedChat2.mock.calls[0] as [Message[], unknown, unknown];

    // Only the 1 new user message — no history
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(typeof userMessages[0].content === "string" && userMessages[0].content).toContain(
      "turn 3",
    );

    await runtime2.close();
  });
});

// ===========================================================================
// AC-7: Observability isolation — throwing listener does not abort the turn
// ===========================================================================

describe("AC-7: Observability isolation — throwing event listener does not fail the turn", () => {
  it("AC-7: A turn.done listener that throws does not prevent successful turn completion", async () => {
    mockedCreateLlmClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ text: "AC-7 response" }),
    });

    const throwingExtension: Extension = {
      name: "throwing-observer",
      register(api: ExtensionApi): void {
        api.on("turn.done", () => {
          throw new Error("boom — listener intentionally throws");
        });
      },
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [throwingExtension],
        },
      },
    };

    const runtime = await createHarness(config);

    // Turn should complete successfully despite the throwing listener
    const result = await runtime.processTurn("default", "hello");

    expect(result.status).toBe("completed");
    expect(result.text).toBe("AC-7 response");

    await runtime.close();
  });
});

// ===========================================================================
// AC-8: Middleware blocking ToolCall
// ===========================================================================

describe("AC-8: Middleware blocks ToolCall — tool handler not invoked", () => {
  it("AC-8: toolCall middleware that short-circuits prevents the tool handler from running", async () => {
    // LLM calls a tool first, then returns a text response after getting the error result
    const llmResponses: LlmResponse[] = [
      {
        text: undefined,
        toolCalls: [{ toolCallId: "tc-1", toolName: "blocked-tool", args: {} }],
      },
      { text: "final response after blocked tool" },
    ];
    mockedCreateLlmClient.mockReturnValue({ chat: mockLlmClient(llmResponses).chat });

    const toolHandlerFn = vi.fn().mockResolvedValue({ type: "text", text: "tool result" });

    const blockedTool: ToolDefinition = {
      name: "blocked-tool",
      description: "A tool that will be blocked by middleware",
      parameters: { type: "object", properties: {} },
      handler: toolHandlerFn,
    };

    const blockingExtension: Extension = {
      name: "blocking-middleware",
      register(api: ExtensionApi): void {
        api.pipeline.register("toolCall", async (ctx: ToolCallContext, _next): Promise<ToolResult> => {
          if (ctx.toolName === "blocked-tool") {
            // Short-circuit: return error without calling next()
            return { type: "error", error: "Tool blocked by middleware policy" };
          }
          return _next();
        });
      },
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [blockingExtension],
          tools: [blockedTool],
        },
      },
    };

    const runtime = await createHarness(config);
    const result = await runtime.processTurn("default", "use the blocked tool");

    // Tool handler must NOT have been called
    expect(toolHandlerFn).not.toHaveBeenCalled();

    // Turn should eventually complete (LLM gets the error result and returns text)
    expect(result.status).toBe("completed");
    expect(result.text).toBe("final response after blocked tool");

    // The step that invoked the tool should show the error result
    const toolCallSummary = result.steps.find((s) => s.toolCalls.length > 0)?.toolCalls[0];
    expect(toolCallSummary).toBeDefined();
    expect(toolCallSummary!.toolName).toBe("blocked-tool");
    // The result contains the error from our blocking middleware
    expect(toolCallSummary!.result).toEqual({ type: "error", error: "Tool blocked by middleware policy" });

    await runtime.close();
  });
});

// ===========================================================================
// AC-9: Ingress pipeline (verify → normalize → route → dispatch)
// ===========================================================================

describe("AC-9: Ingress pipeline — verify → normalize → route → dispatch", () => {
  it("AC-9: All 4 pipeline stages fire in order and envelope is accepted with correct agent", async () => {
    mockedCreateLlmClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ text: "ingress response" }),
    });

    const callOrder: string[] = [];
    const verifyFn = vi.fn().mockImplementation(async () => { callOrder.push("verify"); });
    const normalizeFn = vi.fn().mockImplementation(async (ctx: { connectionName: string; payload: unknown; receivedAt: string }) => {
      callOrder.push("normalize");
      return {
      name: "message",
      content: [{ type: "text" as const, text: "hello from connector" }],
      properties: {},
      conversationId: "ac9-conv",
      source: {
        connector: "test-connector",
        connectionName: ctx.connectionName,
        receivedAt: ctx.receivedAt,
      },
    };
    });

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      connections: {
        "test-conn": {
          connector: {
            name: "test-connector",
            verify: verifyFn,
            normalize: normalizeFn,
          },
          rules: [
            {
              match: { event: "message" },
              agent: "default",
              conversationId: "ac9-conv",
            },
          ],
        },
      },
    };

    const runtime = await createHarness(config);

    const results = await runtime.ingress.receive({
      connectionName: "test-conn",
      payload: { text: "hello" },
    });

    // Verify stage fired
    expect(verifyFn).toHaveBeenCalledOnce();
    expect(verifyFn.mock.calls[0][0]).toMatchObject({
      connectionName: "test-conn",
      payload: { text: "hello" },
    });

    // Normalize stage fired
    expect(normalizeFn).toHaveBeenCalledOnce();

    // Verify stages ran in correct order: verify → normalize, then route+dispatch (implicit)
    expect(callOrder).toEqual(["verify", "normalize"]);

    // Envelope was accepted with correct agent
    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
    expect(results[0].agentName).toBe("default");
    expect(results[0].conversationId).toBe("ac9-conv");

    await runtime.close();
  });
});

// ===========================================================================
// AC-10: Ingress conversationId from property
// ===========================================================================

describe("AC-10: Ingress conversationId resolved from envelope property", () => {
  it("AC-10: conversationIdProperty: 'channel' resolves conversationId from envelope.properties.channel", async () => {
    mockedCreateLlmClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ text: "response" }),
    });

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      connections: {
        "slack-conn": {
          connector: {
            name: "slack",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text" as const, text: "hello" }],
              properties: { channel: "C123" },
              source: {
                connector: "slack",
                connectionName: "slack-conn",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [
            {
              match: { event: "message" },
              agent: "default",
              conversationIdProperty: "channel",
            },
          ],
        },
      },
    };

    const runtime = await createHarness(config);

    const results = await runtime.ingress.receive({
      connectionName: "slack-conn",
      payload: {},
    });

    expect(results).toHaveLength(1);
    expect(results[0].conversationId).toBe("C123");

    await runtime.close();
  });
});

// ===========================================================================
// AC-11: Ingress conversationId absence → rejection
// ===========================================================================

describe("AC-11: Ingress rejected when no conversationId can be resolved", () => {
  it("AC-11: No conversationId in rule or envelope → result is empty (rejected)", async () => {
    mockedCreateLlmClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ text: "response" }),
    });

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      connections: {
        "no-conv-conn": {
          connector: {
            name: "no-conv-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text" as const, text: "hello" }],
              properties: {},
              // No conversationId set
              source: {
                connector: "no-conv-connector",
                connectionName: "no-conv-conn",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [
            {
              match: { event: "message" },
              agent: "default",
              // No conversationId, no conversationIdProperty, no conversationIdPrefix
            },
          ],
        },
      },
    };

    const runtime = await createHarness(config);

    const results = await runtime.ingress.receive({
      connectionName: "no-conv-conn",
      payload: {},
    });

    // Should be rejected — empty results
    expect(results).toHaveLength(0);

    await runtime.close();
  });
});

// ===========================================================================
// AC-12: Runtime introspection
// ===========================================================================

describe("AC-12: Runtime introspection via api.runtime.agent", () => {
  it("AC-12: Extensions can read agent name, model info, extensionCount, toolCount from api.runtime", async () => {
    mockedCreateLlmClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ text: "response" }),
    });

    let capturedRuntimeInfo: {
      agentName?: string;
      provider?: string;
      model?: string;
      extensionCount?: number;
      toolCount?: number;
    } = {};

    const introspectionExtension: Extension = {
      name: "introspection-ext",
      register(api: ExtensionApi): void {
        capturedRuntimeInfo = {
          agentName: api.runtime.agent.name,
          provider: api.runtime.agent.model.provider,
          model: api.runtime.agent.model.model,
          extensionCount: api.runtime.agent.extensions.length,
          toolCount: api.runtime.agent.tools.length,
        };
      },
    };

    const secondExtension: Extension = {
      name: "second-ext",
      register: (_api: ExtensionApi) => {},
    };

    const tool1: ToolDefinition = {
      name: "tool-a",
      description: "Tool A",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ type: "text", text: "a" }),
    };
    const tool2: ToolDefinition = {
      name: "tool-b",
      description: "Tool B",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ type: "text", text: "b" }),
    };
    const tool3: ToolDefinition = {
      name: "tool-c",
      description: "Tool C",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ type: "text", text: "c" }),
    };

    const config: HarnessConfig = {
      agents: {
        "my-agent": {
          model: { provider: "anthropic", model: "claude-3-5-sonnet", apiKey: "test-key" },
          extensions: [introspectionExtension, secondExtension],
          tools: [tool1, tool2, tool3],
        },
      },
    };

    const runtime = await createHarness(config);

    // Introspection should have captured runtime info during register()
    expect(capturedRuntimeInfo.agentName).toBe("my-agent");
    expect(capturedRuntimeInfo.provider).toBe("anthropic");
    expect(capturedRuntimeInfo.model).toBe("claude-3-5-sonnet");
    // 2 extensions declared in config
    expect(capturedRuntimeInfo.extensionCount).toBe(2);
    // 3 tools declared in config
    expect(capturedRuntimeInfo.toolCount).toBe(3);

    await runtime.close();
  });
});

// ===========================================================================
// AC-13: Abort control
// ===========================================================================

describe("AC-13: Abort control — abortConversation stops in-flight turn", () => {
  it("AC-13: Calling abortConversation while turn is in flight results in aborted/error status", async () => {
    let chatStartedResolve!: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      chatStartedResolve = resolve;
    });

    const slowClient: LlmClient = {
      chat: vi.fn().mockImplementation(
        (_msgs: Message[], _tools: ToolDefinition[], signal: AbortSignal) =>
          new Promise<LlmResponse>((resolve, reject) => {
            chatStartedResolve();
            const timer = setTimeout(() => resolve({ text: "done" }), 10_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    mockedCreateLlmClient.mockReturnValue(slowClient);

    const runtime = await createHarness(minimalConfig());

    const convId = "ac13-abort-conv";

    // Start a turn that will hang
    const turnPromise = runtime.processTurn("default", "slow task", {
      conversationId: convId,
    });

    // Wait until the LLM mock has been called (reliable latch)
    await chatStarted;

    // Abort the conversation
    const abortResult = await runtime.control.abortConversation({
      conversationId: convId,
      reason: "user cancelled",
    });

    expect(abortResult.conversationId).toBe(convId);
    expect(abortResult.abortedTurns).toBeGreaterThanOrEqual(1);

    // Turn should resolve with aborted or error status
    const result = await turnPromise;
    expect(["aborted", "error"]).toContain(result.status);

    await runtime.close();
  });
});

// ===========================================================================
// AC-14: Third-party Extension using types-only dependency
// ===========================================================================

describe("AC-14: Third-party Extension with types-only import", () => {
  it("AC-14: An Extension defined using only @goondan/openharness-types works correctly", async () => {
    const capturedChat = vi.fn().mockResolvedValue({ text: "AC-14 response" });
    mockedCreateLlmClient.mockReturnValue({ chat: capturedChat });

    // This extension only imports types from @goondan/openharness-types
    // It is defined inline here, simulating a third-party package
    // that has @goondan/openharness-types as its only dependency.
    const thirdPartyExtension: Extension = {
      name: "third-party-system-prompt",
      register(api: ExtensionApi): void {
        // Register a turn middleware that prepends a system message
        api.pipeline.register("turn", async (ctx, next) => {
          ctx.conversation.emit({
            type: "append",
            message: {
              id: `tp-sys-${Date.now()}`,
              role: "system",
              content: "You are a third-party assistant.",
            },
          });
          return next();
        });
      },
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [thirdPartyExtension],
        },
      },
    };

    // Using defineHarness from types-only package (proves it's callable from types)
    const definedConfig = defineHarness(config);

    const runtime = await createHarness(definedConfig);
    const result = await runtime.processTurn("default", "hello from third party test");

    // Extension ran — LLM received a system message from the third-party extension
    expect(capturedChat).toHaveBeenCalledOnce();
    const [messages] = capturedChat.mock.calls[0] as [Message[], unknown, unknown];

    const systemMessages = messages.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
    expect(
      systemMessages.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("third-party assistant"),
      ),
    ).toBe(true);

    // Turn completed successfully
    expect(result.status).toBe("completed");
    expect(result.text).toBe("AC-14 response");

    await runtime.close();
  });
});

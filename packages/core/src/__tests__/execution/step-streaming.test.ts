import { describe, it, expect, vi } from "vitest";
import { executeStep } from "../../execution/step.js";
import { ToolRegistry } from "../../tool-registry.js";
import { MiddlewareRegistry } from "../../middleware-chain.js";
import { EventBus } from "../../event-bus.js";
import { createConversationState } from "../../conversation-state.js";
import type {
  StepContext,
  LlmClient,
  LlmStreamCallbacks,
  LlmResponse,
  Message,
  ToolDefinition,
  EventPayload,
} from "@goondan/openharness-types";

// -----------------------------------------------------------------------
// Helpers — mirrors step.test.ts patterns
// -----------------------------------------------------------------------

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeConversation() {
  const conv = createConversationState();
  conv._turnActive = true;
  return conv;
}

function makeStepContext(overrides?: Partial<StepContext>): StepContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation: makeConversation(),
    abortSignal: makeAbortSignal(),
    input: {
      name: "test",
      content: [],
      properties: {},
      source: {
        connector: "test",
        connectionName: "conn-1",
        receivedAt: new Date().toISOString(),
      },
    },
    stepNumber: 1,
    llm: {
      chat: vi.fn().mockResolvedValue({ text: "unused" }),
    },
    ...overrides,
  };
}

function makeDeps(opts?: {
  llmClient?: LlmClient;
  toolRegistry?: ToolRegistry;
  middlewareRegistry?: MiddlewareRegistry;
  eventBus?: EventBus;
}) {
  return {
    llmClient: opts?.llmClient ?? { chat: vi.fn().mockResolvedValue({ text: "default" }) },
    toolRegistry: opts?.toolRegistry ?? new ToolRegistry(),
    middlewareRegistry: opts?.middlewareRegistry ?? new MiddlewareRegistry(),
    eventBus: opts?.eventBus ?? new EventBus(),
  };
}

/**
 * Create a mock LlmClient that has streamChat. The streamChat implementation
 * invokes the provided callbacks with the given deltas, then returns the response.
 */
function makeMockStreamingClient(opts: {
  textDeltas?: string[];
  toolCallDeltas?: Array<{ toolCallId: string; toolName: string; argsDelta: string }>;
  response: LlmResponse;
}): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue(opts.response),
    streamChat: vi.fn(
      async (
        _messages: Message[],
        _tools: ToolDefinition[],
        _signal: AbortSignal,
        callbacks: LlmStreamCallbacks,
      ): Promise<LlmResponse> => {
        // Simulate streaming deltas via callbacks
        for (const delta of opts.textDeltas ?? []) {
          callbacks.onTextDelta?.(delta);
        }
        for (const tc of opts.toolCallDeltas ?? []) {
          callbacks.onToolCallDelta?.(tc.toolCallId, tc.toolName, tc.argsDelta);
        }
        return opts.response;
      },
    ),
  };
}

// -----------------------------------------------------------------------
// Tests: FR-CORE-010 — Step streaming
// -----------------------------------------------------------------------

describe("executeStep — streaming (FR-CORE-010)", () => {
  // AC-17: When streamChat is available, it is preferred over chat()
  it("AC-17: prefers streamChat over chat when available", async () => {
    const streamingClient = makeMockStreamingClient({
      textDeltas: ["Hi"],
      response: { text: "Hi" },
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient: streamingClient });

    await executeStep(ctx, deps);

    expect(streamingClient.streamChat).toHaveBeenCalledOnce();
    expect(streamingClient.chat).not.toHaveBeenCalled();
  });

  // AC-17: When streamChat is absent, falls back to chat()
  it("AC-17: falls back to chat() when streamChat is absent", async () => {
    const chatOnlyClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "from chat" }),
      // No streamChat
    };

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient: chatOnlyClient });

    const result = await executeStep(ctx, deps);

    expect(chatOnlyClient.chat).toHaveBeenCalledOnce();
    expect(result.text).toBe("from chat");
  });

  // AC-18: step.textDelta events emitted between step.start and step.done
  it("AC-18: step.textDelta events are emitted between step.start and step.done", async () => {
    const eventBus = new EventBus();
    const eventLog: string[] = [];

    eventBus.on("step.start", () => eventLog.push("step.start"));
    eventBus.on("step.textDelta", (payload) => {
      eventLog.push(`step.textDelta:${payload.delta}`);
    });
    eventBus.on("step.done", () => eventLog.push("step.done"));

    const streamingClient = makeMockStreamingClient({
      textDeltas: ["Hello", " world"],
      response: { text: "Hello world" },
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient: streamingClient, eventBus });

    await executeStep(ctx, deps);

    // Verify ordering: start → deltas → done
    expect(eventLog).toEqual([
      "step.start",
      "step.textDelta:Hello",
      "step.textDelta: world",
      "step.done",
    ]);
  });

  // step.toolCallDelta events emitted between step.start and step.done
  it("step.toolCallDelta events are emitted between step.start and step.done", async () => {
    const eventBus = new EventBus();
    const eventLog: string[] = [];

    eventBus.on("step.start", () => eventLog.push("step.start"));
    eventBus.on("step.toolCallDelta", (payload) => {
      eventLog.push(`step.toolCallDelta:${payload.toolName}:${payload.argsDelta}`);
    });
    eventBus.on("step.done", () => eventLog.push("step.done"));

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: "my_tool",
      description: "A tool",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ type: "text", text: "result" }),
    });

    const streamingClient = makeMockStreamingClient({
      toolCallDeltas: [
        { toolCallId: "tc-1", toolName: "my_tool", argsDelta: '{"key":' },
        { toolCallId: "tc-1", toolName: "my_tool", argsDelta: '"value"}' },
      ],
      response: {
        text: undefined,
        toolCalls: [
          { toolCallId: "tc-1", toolName: "my_tool", args: { key: "value" } },
        ],
      },
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient: streamingClient, eventBus, toolRegistry });

    await executeStep(ctx, deps);

    expect(eventLog).toEqual([
      "step.start",
      'step.toolCallDelta:my_tool:{"key":',
      'step.toolCallDelta:my_tool:"value"}',
      "step.done",
    ]);
  });

  // Delta event payloads contain correct context fields
  it("delta event payloads include turnId, agentName, conversationId, stepNumber", async () => {
    const eventBus = new EventBus();
    const textDeltaPayloads: EventPayload[] = [];
    const toolCallDeltaPayloads: EventPayload[] = [];

    eventBus.on("step.textDelta", (p) => textDeltaPayloads.push(p));
    eventBus.on("step.toolCallDelta", (p) => toolCallDeltaPayloads.push(p));

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: "test_tool",
      description: "A tool",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ type: "text", text: "ok" }),
    });

    const streamingClient = makeMockStreamingClient({
      textDeltas: ["hi"],
      toolCallDeltas: [
        { toolCallId: "tc-1", toolName: "test_tool", argsDelta: "{}" },
      ],
      response: {
        text: "hi",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "test_tool", args: {} },
        ],
      },
    });

    const ctx = makeStepContext({
      turnId: "turn-42",
      agentName: "agent-z",
      conversationId: "conv-99",
      stepNumber: 7,
    });
    const deps = makeDeps({ llmClient: streamingClient, eventBus, toolRegistry });

    await executeStep(ctx, deps);

    // Verify text delta payload
    expect(textDeltaPayloads).toHaveLength(1);
    expect(textDeltaPayloads[0]).toEqual({
      type: "step.textDelta",
      turnId: "turn-42",
      agentName: "agent-z",
      conversationId: "conv-99",
      stepNumber: 7,
      delta: "hi",
    });

    // Verify tool call delta payload
    expect(toolCallDeltaPayloads).toHaveLength(1);
    expect(toolCallDeltaPayloads[0]).toEqual({
      type: "step.toolCallDelta",
      turnId: "turn-42",
      agentName: "agent-z",
      conversationId: "conv-99",
      stepNumber: 7,
      toolCallId: "tc-1",
      toolName: "test_tool",
      argsDelta: "{}",
    });
  });

  // No delta events when using chat() fallback
  it("no delta events emitted when using chat() fallback", async () => {
    const eventBus = new EventBus();
    const deltaEvents: EventPayload[] = [];

    eventBus.on("step.textDelta", (p) => deltaEvents.push(p));
    eventBus.on("step.toolCallDelta", (p) => deltaEvents.push(p));

    const chatOnlyClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "from chat" }),
    };

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient: chatOnlyClient, eventBus });

    await executeStep(ctx, deps);

    expect(deltaEvents).toHaveLength(0);
  });

  // streamChat receives messages, tools, and abort signal correctly
  it("streamChat receives messages, tools, signal, and callbacks", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: "my_tool",
      description: "Tool",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ type: "text", text: "ok" }),
    });

    const streamingClient = makeMockStreamingClient({
      response: { text: "ok" },
    });

    const conv = makeConversation();
    conv.emit({
      type: "append",
      message: {
        id: "msg-1",
        data: { role: "user", content: "Hello" },
      },
    });

    const ctx = makeStepContext({ conversation: conv });
    const deps = makeDeps({ llmClient: streamingClient, toolRegistry });

    await executeStep(ctx, deps);

    expect(streamingClient.streamChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-1" }),
      ]),
      expect.arrayContaining([
        expect.objectContaining({ name: "my_tool" }),
      ]),
      expect.any(Object), // AbortSignal
      expect.objectContaining({
        onTextDelta: expect.any(Function),
        onToolCallDelta: expect.any(Function),
      }),
    );
  });

  // streamChat error propagates correctly with step.error event
  it("streamChat error propagates and emits step.error", async () => {
    const eventBus = new EventBus();
    const errorListener = vi.fn();
    eventBus.on("step.error", errorListener);

    const streamError = new Error("Stream failed");
    const failingClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "unused" }),
      streamChat: vi.fn().mockRejectedValue(streamError),
    };

    const ctx = makeStepContext({ stepNumber: 3 });
    const deps = makeDeps({ llmClient: failingClient, eventBus });

    await expect(executeStep(ctx, deps)).rejects.toThrow("Stream failed");

    expect(errorListener).toHaveBeenCalledOnce();
    expect(errorListener.mock.calls[0][0].type).toBe("step.error");
    expect(errorListener.mock.calls[0][0].stepNumber).toBe(3);
    expect(errorListener.mock.calls[0][0].error.message).toBe("Stream failed");
  });
});

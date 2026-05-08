import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeStep } from "../../execution/step.js";
import { ToolRegistry } from "../../tool-registry.js";
import { MiddlewareRegistry } from "../../middleware-chain.js";
import { EventBus } from "../../event-bus.js";
import { createConversationState } from "../../conversation-state.js";
import type {
  StepContext,
  StepResult,
  LlmClient,
  LlmResponse,
  ToolDefinition,
  Message,
  MessageEvent,
  JsonObject,
} from "@goondan/openharness-types";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeMessage(
  id: string,
  role: Message["data"]["role"],
  content: Message["data"]["content"],
): Message {
  return { id, data: { role, content } as Message["data"] };
}

function makeConversation() {
  const conv = createConversationState();
  // Must be active for emit() to work
  conv._turnActive = true;
  return conv;
}

function makeMockLlmClient(): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ text: "mock response" }),
  };
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
    llm: makeMockLlmClient(),
    ...overrides,
  };
}

function makeLlmClient(response: LlmResponse): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue(response),
  };
}

function makeTool(
  name: string,
  handler?: ToolDefinition["handler"]
): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: handler ?? (async () => ({ type: "text", text: `${name} result` })),
  };
}

function makeDeps(opts?: {
  llmClient?: LlmClient;
  toolRegistry?: ToolRegistry;
  middlewareRegistry?: MiddlewareRegistry;
  eventBus?: EventBus;
}) {
  return {
    llmClient: opts?.llmClient ?? makeLlmClient({ text: "default response" }),
    toolRegistry: opts?.toolRegistry ?? new ToolRegistry(),
    middlewareRegistry: opts?.middlewareRegistry ?? new MiddlewareRegistry(),
    eventBus: opts?.eventBus ?? new EventBus(),
  };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("executeStep", () => {
  // Test 1: LLM returns text only → Step completes, no tool calls
  it("LLM returns text only → step completes with no tool calls", async () => {
    const llmClient = makeLlmClient({ text: "Hello, world!" });
    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient });

    const result = await executeStep(ctx, deps);

    expect(result.text).toBe("Hello, world!");
    expect(result.toolCalls).toHaveLength(0);
    expect(llmClient.chat).toHaveBeenCalledOnce();
  });

  it("propagates LLM usage into StepResult and step.done", async () => {
    const usage = {
      inputTokens: 7,
      outputTokens: 4,
      totalTokens: 11,
      inputTokenDetails: {
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      outputTokenDetails: {
        reasoningTokens: 3,
      },
    };
    const llmClient = makeLlmClient({ text: "Hello, world!", usage });
    const eventBus = new EventBus();
    const doneListener = vi.fn();
    eventBus.on("step.done", doneListener);
    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, eventBus });

    const result = await executeStep(ctx, deps);

    expect(result.usage).toEqual(usage);
    expect(doneListener).toHaveBeenCalledOnce();
    expect(doneListener.mock.calls[0][0].result.usage).toEqual(usage);
  });

  // Test 2: LLM returns tool calls → each tool executed via executeToolCall
  it("LLM returns tool calls → each tool is executed", async () => {
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "tool result" }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", toolHandler));

    const llmClient = makeLlmClient({
      text: "Using tool",
      toolCalls: [
        { toolCallId: "call-1", toolName: "my_tool", args: { value: "hello" } },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry });

    const result = await executeStep(ctx, deps);

    expect(toolHandler).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolCallId).toBe("call-1");
    expect(result.toolCalls[0].toolName).toBe("my_tool");
    expect(result.toolCalls[0].result).toEqual({ type: "text", text: "tool result" });
  });

  // Test 3: Step middleware can modify conversation before next()
  it("step middleware can modify context before next()", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();
    const middlewareCalled = vi.fn();

    middlewareRegistry.register("step", async (ctx, next) => {
      middlewareCalled(ctx);
      return await next();
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, middlewareRegistry });

    const result = await executeStep(ctx, deps);

    expect(middlewareCalled).toHaveBeenCalledOnce();
    expect(middlewareCalled).toHaveBeenCalledWith(expect.objectContaining({
      turnId: "turn-1",
      stepNumber: 1,
    }));
    expect(result.text).toBe("response");
  });

  // Test 4: AbortSignal aborts LLM call
  it("AbortSignal is forwarded to LLM client", async () => {
    const abortController = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const llmClient: LlmClient = {
      chat: vi.fn(async (_messages, _tools, signal) => {
        capturedSignal = signal;
        return { text: "response" };
      }),
    };

    const ctx = makeStepContext({ abortSignal: abortController.signal });
    const deps = makeDeps({ llmClient });

    await executeStep(ctx, deps);

    expect(capturedSignal).toBe(abortController.signal);
  });

  // Test 5: LLM API error → step error propagated
  it("LLM API error → error is propagated (rethrown)", async () => {
    const llmError = new Error("LLM API failure");
    const llmClient: LlmClient = {
      chat: vi.fn().mockRejectedValue(llmError),
    };

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient });

    await expect(executeStep(ctx, deps)).rejects.toThrow("LLM API failure");
  });

  // Test 6: step.start and step.done events emitted
  it("step.start and step.done events are emitted", async () => {
    const llmClient = makeLlmClient({
      text: "result",
      finishReason: "stop",
      rawFinishReason: "stop",
    });
    const eventBus = new EventBus();
    const startListener = vi.fn();
    const doneListener = vi.fn();
    eventBus.on("step.start", startListener);
    eventBus.on("step.done", doneListener);

    const ctx = makeStepContext({
      turnId: "turn-99",
      agentName: "agent-x",
      conversationId: "conv-z",
      stepNumber: 3,
    });
    const deps = makeDeps({ llmClient, eventBus });

    const result = await executeStep(ctx, deps);

    expect(startListener).toHaveBeenCalledOnce();
    const startPayload = startListener.mock.calls[0][0];
    expect(startPayload.type).toBe("step.start");
    expect(startPayload.turnId).toBe("turn-99");
    expect(startPayload.agentName).toBe("agent-x");
    expect(startPayload.conversationId).toBe("conv-z");
    expect(startPayload.stepNumber).toBe(3);

    expect(doneListener).toHaveBeenCalledOnce();
    const donePayload = doneListener.mock.calls[0][0];
    expect(donePayload.type).toBe("step.done");
    expect(donePayload.turnId).toBe("turn-99");
    expect(donePayload.agentName).toBe("agent-x");
    expect(donePayload.conversationId).toBe("conv-z");
    expect(donePayload.stepNumber).toBe(3);
    expect(donePayload.result).toEqual(result);
    expect(result.finishReason).toBe("stop");
    expect(result.rawFinishReason).toBe("stop");
  });

  // Test 7: step.error event emitted on failure
  it("step.error event emitted on LLM failure", async () => {
    const llmError = new Error("LLM crashed");
    const llmClient: LlmClient = {
      chat: vi.fn().mockRejectedValue(llmError),
    };

    const eventBus = new EventBus();
    const errorListener = vi.fn();
    eventBus.on("step.error", errorListener);

    const ctx = makeStepContext({ stepNumber: 2 });
    const deps = makeDeps({ llmClient, eventBus });

    await expect(executeStep(ctx, deps)).rejects.toThrow("LLM crashed");

    expect(errorListener).toHaveBeenCalledOnce();
    const errorPayload = errorListener.mock.calls[0][0];
    expect(errorPayload.type).toBe("step.error");
    expect(errorPayload.stepNumber).toBe(2);
    expect(errorPayload.error).toBeInstanceOf(Error);
    expect(errorPayload.error.message).toContain("LLM crashed");
  });

  // Test 8: Multiple tool calls in one step → all executed
  it("multiple tool calls in one step → all executed", async () => {
    const handlerA = vi.fn(async () => ({ type: "text" as const, text: "A result" }));
    const handlerB = vi.fn(async () => ({ type: "text" as const, text: "B result" }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("tool_a", handlerA));
    toolRegistry.register(makeTool("tool_b", handlerB));

    const llmClient = makeLlmClient({
      toolCalls: [
        { toolCallId: "call-a", toolName: "tool_a", args: { value: "alpha" } },
        { toolCallId: "call-b", toolName: "tool_b", args: { value: "beta" } },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry });

    const result = await executeStep(ctx, deps);

    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolCallId).toBe("call-a");
    expect(result.toolCalls[0].result).toEqual({ type: "text", text: "A result" });
    expect(result.toolCalls[1].toolCallId).toBe("call-b");
    expect(result.toolCalls[1].result).toEqual({ type: "text", text: "B result" });
  });

  it("malformed JSON-string tool args are stored as valid tool calls with error tool results", async () => {
    const validHandler = vi.fn(async () => ({ type: "text" as const, text: "valid result" }));
    const invalidHandler = vi.fn(async () => ({ type: "text" as const, text: "should not run" }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("valid_tool", validHandler));
    toolRegistry.register(makeTool("invalid_tool", invalidHandler));
    const malformedArgs =
      '{"command": ["grep", "-r", "ThrottlingOverride\\|throttling_overrides\\|throttling_seconds"]}' as unknown as JsonObject;

    const eventBus = new EventBus();
    const toolDoneListener = vi.fn();
    eventBus.on("tool.done", toolDoneListener);

    const llmClient = makeLlmClient({
      toolCalls: [
        { toolCallId: "call-valid", toolName: "valid_tool", args: { value: "ok" } },
        { toolCallId: "call-malformed", toolName: "invalid_tool", args: malformedArgs },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry, eventBus });

    const result = await executeStep(ctx, deps);

    expect(validHandler).toHaveBeenCalledOnce();
    expect(invalidHandler).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].args).toEqual({ value: "ok" });
    expect(result.toolCalls[0].result).toEqual({ type: "text", text: "valid result" });
    expect(result.toolCalls[1].args).toEqual({});
    expect(result.toolCalls[1].result).toEqual({
      type: "error",
      error: expect.stringContaining("Malformed tool arguments"),
    });
    expect(result.toolCalls[1].result?.type === "error" ? result.toolCalls[1].result.error : "").toContain(
      "Original arguments preview:",
    );
    expect(result.toolCalls[1].result?.type === "error" ? result.toolCalls[1].result.error : "").toContain(
      "ThrottlingOverride\\|throttling_overrides\\|throttling_seconds",
    );

    const assistantMessage = ctx.conversation.messages.find((m: Message) => m.data.role === "assistant");
    const assistantContent = assistantMessage?.data.content as Array<{
      type: string;
      toolCallId?: string;
      input?: unknown;
    }>;
    expect(assistantContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-call", toolCallId: "call-valid", input: { value: "ok" } }),
        expect.objectContaining({ type: "tool-call", toolCallId: "call-malformed", input: {} }),
      ]),
    );

    const toolMessages = ctx.conversation.messages.filter((m: Message) => m.data.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1].data.content).toEqual([
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "call-malformed",
        output: expect.objectContaining({
          type: "error-text",
          value: expect.stringContaining("Original arguments preview:"),
        }),
      }),
    ]);

    expect(toolDoneListener).toHaveBeenCalledTimes(2);
    expect(toolDoneListener.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        toolCallId: "call-malformed",
        args: {},
        result: expect.objectContaining({
          type: "error",
          error: expect.stringContaining("Malformed tool arguments"),
        }),
      }),
    );
  });

  // FR-CORE-007: Core appends LLM response to conversation
  it("FR-CORE-007: LLM response appended to conversation as assistant message", async () => {
    const llmClient = makeLlmClient({ text: "assistant reply" });
    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient });

    await executeStep(ctx, deps);

    const messages = ctx.conversation.messages;
    const assistantMessages = messages.filter((m: Message) => m.data.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].data.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "assistant reply" }),
      ])
    );
  });

  // FR-CORE-007: Core appends tool results to conversation
  it("FR-CORE-007: Tool results appended to conversation as tool messages", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool"));

    const llmClient = makeLlmClient({
      toolCalls: [
        { toolCallId: "tc-1", toolName: "my_tool", args: { value: "x" } },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry });

    await executeStep(ctx, deps);

    const messages = ctx.conversation.messages;
    const toolMessages = messages.filter((m: Message) => m.data.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].data.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-result", toolCallId: "tc-1" }),
      ])
    );
  });

  it("appends multimodal content tool results as AI SDK content output", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      makeTool("read_image", async () => ({
        type: "content",
        content: [
          { type: "text", text: "[image] /tmp/a.png" },
          { type: "media", mediaType: "image/png", data: "aW1hZ2U=" },
        ],
      })),
    );

    const llmClient = makeLlmClient({
      toolCalls: [
        { toolCallId: "tc-image", toolName: "read_image", args: {} },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry });

    await executeStep(ctx, deps);

    const toolMessages = ctx.conversation.messages.filter((m: Message) => m.data.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].data.content[0]).toEqual(
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "tc-image",
        toolName: "read_image",
        output: {
          type: "content",
          value: [
            { type: "text", text: "[image] /tmp/a.png" },
            { type: "media", mediaType: "image/png", data: "aW1hZ2U=" },
          ],
        },
      })
    );
  });

  it("invalid tool calls are not executed and are returned as tool error results", async () => {
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "should not run" }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", toolHandler));
    const invalidReason = [
      "Malformed tool arguments: expected a JSON object.",
      "The tool was not executed. Retry this tool call with a valid object input.",
      "Original arguments preview: [\"NYC\"]",
    ].join("\n");

    const eventBus = new EventBus();
    const toolStartListener = vi.fn();
    eventBus.on("tool.start", toolStartListener);

    const llmClient = makeLlmClient({
      toolCalls: [
        {
          toolCallId: "tc-invalid",
          toolName: "my_tool",
          args: {},
          invalidReason,
        },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry, eventBus });

    const result = await executeStep(ctx, deps);

    expect(toolHandler).not.toHaveBeenCalled();
    expect(toolStartListener).toHaveBeenCalledOnce();
    expect(toolStartListener).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tc-invalid",
        toolName: "my_tool",
        args: {},
      }),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      toolCallId: "tc-invalid",
      toolName: "my_tool",
      args: {},
      invalidReason,
      result: {
        type: "error",
        error: invalidReason,
      },
    });

    const assistantMessages = ctx.conversation.messages.filter((m: Message) => m.data.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].data.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "tc-invalid",
          toolName: "my_tool",
          input: {},
        }),
      ])
    );

    const toolMessages = ctx.conversation.messages.filter((m: Message) => m.data.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].data.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "tc-invalid",
          output: {
            type: "error-text",
            value: invalidReason,
          },
        }),
      ])
    );
  });

  // FR-CORE-007: LLM response with tool-call content parts appended
  it("FR-CORE-007: LLM response with tool calls includes tool-call content parts", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool"));

    const llmClient = makeLlmClient({
      text: "Using a tool",
      toolCalls: [
        { toolCallId: "tc-1", toolName: "my_tool", args: { value: "x" } },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry });

    await executeStep(ctx, deps);

    const messages = ctx.conversation.messages;
    const assistantMessages = messages.filter((m: Message) => m.data.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    const assistantContent = assistantMessages[0].data.content as Array<{ type: string }>;
    expect(assistantContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Using a tool" }),
        expect.objectContaining({ type: "tool-call", toolName: "my_tool", toolCallId: "tc-1" }),
      ])
    );
  });

  // Test: Multiple tool calls execute sequentially, not concurrently
  it("multiple tool calls in one step execute sequentially (not concurrently)", async () => {
    const executionOrder: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    function makeSequentialTool(name: string) {
      return makeTool(name, async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        executionOrder.push(`start:${name}`);
        // Simulate async work with a small delay
        await new Promise((resolve) => setTimeout(resolve, 5));
        executionOrder.push(`end:${name}`);
        concurrentCount--;
        return { type: "text" as const, text: `${name} result` };
      });
    }

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeSequentialTool("tool_1"));
    toolRegistry.register(makeSequentialTool("tool_2"));
    toolRegistry.register(makeSequentialTool("tool_3"));

    const llmClient = makeLlmClient({
      toolCalls: [
        { toolCallId: "call-1", toolName: "tool_1", args: { value: "a" } },
        { toolCallId: "call-2", toolName: "tool_2", args: { value: "b" } },
        { toolCallId: "call-3", toolName: "tool_3", args: { value: "c" } },
      ],
    });

    const ctx = makeStepContext();
    const deps = makeDeps({ llmClient, toolRegistry });

    const result = await executeStep(ctx, deps);

    // All tools should have been called
    expect(result.toolCalls).toHaveLength(3);

    // Sequential execution: max concurrent should never exceed 1
    expect(maxConcurrent).toBe(1);

    // Order should be: start/end tool_1, start/end tool_2, start/end tool_3
    expect(executionOrder).toEqual([
      "start:tool_1",
      "end:tool_1",
      "start:tool_2",
      "end:tool_2",
      "start:tool_3",
      "end:tool_3",
    ]);
  });

  // LLM client receives current messages and available tools
  it("LLM client is called with current messages and available tools", async () => {
    const toolRegistry = new ToolRegistry();
    const toolDef = makeTool("available_tool");
    toolRegistry.register(toolDef);

    const llmClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "ok" }),
    };

    const conv = makeConversation();
    // Pre-populate conversation with a message
    conv.emit({
      type: "appendMessage",
      message: makeMessage("msg-1", "user", "Hello") as Extract<
        MessageEvent,
        { type: "appendMessage" }
      >["message"],
    });

    const ctx = makeStepContext({ conversation: conv });
    const deps = makeDeps({ llmClient, toolRegistry });

    await executeStep(ctx, deps);

    expect(llmClient.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-1", data: expect.objectContaining({ role: "user" }) }),
      ]),
      expect.arrayContaining([
        expect.objectContaining({ name: "available_tool" }),
      ]),
      expect.any(Object) // AbortSignal
    );
  });
});

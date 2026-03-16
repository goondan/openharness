import { describe, it, expect, vi } from "vitest";
import { executeTurn } from "../../execution/turn.js";
import { ToolRegistry } from "../../tool-registry.js";
import { MiddlewareRegistry } from "../../middleware-chain.js";
import { EventBus } from "../../event-bus.js";
import { createConversationState } from "../../conversation-state.js";
import type {
  LlmClient,
  LlmResponse,
  ToolDefinition,
  TurnContext,
  TurnResult,
  InboundEnvelope,
  Message,
} from "@goondan/openharness-types";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeLlmClient(
  responses: LlmResponse | LlmResponse[]
): LlmClient {
  if (Array.isArray(responses)) {
    let callCount = 0;
    return {
      chat: vi.fn().mockImplementation(async () => {
        const response = responses[Math.min(callCount, responses.length - 1)];
        callCount++;
        return response;
      }),
    };
  }
  return {
    chat: vi.fn().mockResolvedValue(responses),
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

function makeEnvelope(text: string): InboundEnvelope {
  return {
    name: "test",
    content: [{ type: "text", text }],
    properties: {},
    source: {
      connector: "test",
      connectionName: "conn-1",
      receivedAt: new Date().toISOString(),
    },
  };
}

interface MakeDepsOptions {
  llmClient?: LlmClient;
  toolRegistry?: ToolRegistry;
  middlewareRegistry?: MiddlewareRegistry;
  eventBus?: EventBus;
  maxSteps?: number;
}

function makeDeps(opts?: MakeDepsOptions) {
  const conversationState = createConversationState();
  return {
    llmClient: opts?.llmClient ?? makeLlmClient({ text: "default response" }),
    toolRegistry: opts?.toolRegistry ?? new ToolRegistry(),
    middlewareRegistry: opts?.middlewareRegistry ?? new MiddlewareRegistry(),
    eventBus: opts?.eventBus ?? new EventBus(),
    conversationState,
    maxSteps: opts?.maxSteps ?? 10,
  };
}

// Helper to register a typed turn middleware (the registry uses unknown, so we cast)
function registerTurnMiddleware(
  registry: MiddlewareRegistry,
  handler: (ctx: TurnContext, next: () => Promise<TurnResult>) => Promise<TurnResult>
): void {
  registry.register("turn", handler as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>);
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("executeTurn", () => {
  // Test 1: Simple turn: input → 1 step → text response → TurnResult
  it("simple turn: string input → 1 step → text response → TurnResult", async () => {
    const llmClient = makeLlmClient({ text: "Hello, world!" });
    const deps = makeDeps({ llmClient });

    const result = await executeTurn("agent-1", "Hi there", undefined, deps);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Hello, world!");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stepNumber).toBe(1);
    expect(result.steps[0].toolCalls).toHaveLength(0);
    expect(result.agentName).toBe("agent-1");
    expect(result.turnId).toBeDefined();
    expect(result.conversationId).toBeDefined();
  });

  // Test 2: Multi-step: LLM requests tools → step 2 → text → done
  it("multi-step: LLM requests tool → step 2 with text → done", async () => {
    const toolRegistry = new ToolRegistry();
    const toolHandler = vi.fn(async () => ({ type: "text" as const, text: "tool result" }));
    toolRegistry.register(makeTool("my_tool", toolHandler));

    // Step 1: LLM returns a tool call; Step 2: LLM returns text
    const llmClient = makeLlmClient([
      {
        text: "Using tool",
        toolCalls: [{ toolCallId: "call-1", toolName: "my_tool", args: { value: "x" } }],
      },
      { text: "Final answer" },
    ]);

    const deps = makeDeps({ llmClient, toolRegistry });
    const result = await executeTurn("agent-1", "Do something", undefined, deps);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Final answer");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolCalls).toHaveLength(1);
    expect(result.steps[0].toolCalls[0].toolName).toBe("my_tool");
    expect(result.steps[1].toolCalls).toHaveLength(0);
    expect(toolHandler).toHaveBeenCalledOnce();
  });

  // Test 3: maxSteps reached → status "maxStepsReached"
  it("maxSteps reached → status maxStepsReached", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool"));

    // LLM always returns tool calls → never terminates naturally
    const llmClient = makeLlmClient({
      text: "Using tool",
      toolCalls: [{ toolCallId: "call-1", toolName: "my_tool", args: { value: "x" } }],
    });

    const deps = makeDeps({ llmClient, toolRegistry, maxSteps: 3 });
    const result = await executeTurn("agent-1", "Repeat", undefined, deps);

    expect(result.status).toBe("maxStepsReached");
    expect(result.steps).toHaveLength(3);
    expect(llmClient.chat).toHaveBeenCalledTimes(3);
  });

  // Test 4: Turn middleware wraps entire turn
  it("turn middleware wraps entire turn", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();
    const middlewareCalled = vi.fn();
    const afterNextCalled = vi.fn();

    registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
      middlewareCalled(ctx);
      const result = await next();
      afterNextCalled(result);
      return result;
    });

    const deps = makeDeps({ llmClient, middlewareRegistry });
    const result = await executeTurn("agent-1", "Hello", undefined, deps);

    expect(middlewareCalled).toHaveBeenCalledOnce();
    expect(middlewareCalled).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "agent-1" })
    );
    expect(afterNextCalled).toHaveBeenCalledOnce();
    expect(afterNextCalled).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    );
    expect(result.status).toBe("completed");
  });

  // Test 5: Turn middleware blocks (no next()) → steps not executed
  it("turn middleware that blocks (no next()) → steps not executed", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();

    const customResult: TurnResult = {
      turnId: "blocked-turn",
      agentName: "agent-1",
      conversationId: "conv-1",
      status: "completed",
      text: "blocked by middleware",
      steps: [],
    };

    registerTurnMiddleware(middlewareRegistry, async (_ctx, _next) => {
      // Intentionally does NOT call next()
      return customResult;
    });

    const deps = makeDeps({ llmClient, middlewareRegistry });
    const result = await executeTurn("agent-1", "Hello", undefined, deps);

    // LLM should NOT have been called since middleware blocked
    expect(llmClient.chat).not.toHaveBeenCalled();
    expect(result).toEqual(customResult);
  });

  // Test 6: AbortSignal → status "aborted"
  it("AbortSignal already aborted in context → status aborted before first step", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();

    // Middleware injects aborted signal into TurnContext before core handler runs
    registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
      // Replace the abortSignal with an already-aborted one
      Object.defineProperty(ctx, "abortSignal", {
        value: abortController.signal,
        writable: true,
        configurable: true,
      });
      return next();
    });

    const deps = makeDeps({ llmClient, middlewareRegistry });
    const result = await executeTurn("agent-1", "Hello", undefined, deps);

    expect(result.status).toBe("aborted");
    expect(llmClient.chat).not.toHaveBeenCalled();
  });

  // Test 7: String input auto-wrapped to InboundEnvelope
  it("string input is auto-wrapped to InboundEnvelope", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();
    let capturedCtx: TurnContext | undefined;

    registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
      capturedCtx = ctx;
      return next();
    });

    const deps = makeDeps({ llmClient, middlewareRegistry });
    await executeTurn("agent-1", "my string input", undefined, deps);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.input.name).toBe("text");
    expect(capturedCtx!.input.content).toEqual([{ type: "text", text: "my string input" }]);
    expect(capturedCtx!.input.source.connector).toBe("programmatic");
  });

  // Test 8: InboundEnvelope input used directly
  it("InboundEnvelope input is used directly without wrapping", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();
    let capturedCtx: TurnContext | undefined;

    registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
      capturedCtx = ctx;
      return next();
    });

    const envelope = makeEnvelope("envelope text");
    envelope.source.connector = "custom-connector";

    const deps = makeDeps({ llmClient, middlewareRegistry });
    await executeTurn("agent-1", envelope, undefined, deps);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.input).toBe(envelope);
    expect(capturedCtx!.input.source.connector).toBe("custom-connector");
  });

  // Test 9: turn.start, turn.done events emitted
  it("turn.start and turn.done events are emitted", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const eventBus = new EventBus();
    const startListener = vi.fn();
    const doneListener = vi.fn();
    eventBus.on("turn.start", startListener);
    eventBus.on("turn.done", doneListener);

    const deps = makeDeps({ llmClient, eventBus });
    const result = await executeTurn("my-agent", "input", { conversationId: "conv-abc" }, deps);

    expect(startListener).toHaveBeenCalledOnce();
    const startPayload = startListener.mock.calls[0][0];
    expect(startPayload.type).toBe("turn.start");
    expect(startPayload.agentName).toBe("my-agent");
    expect(startPayload.conversationId).toBe("conv-abc");
    expect(startPayload.turnId).toBeDefined();

    expect(doneListener).toHaveBeenCalledOnce();
    const donePayload = doneListener.mock.calls[0][0];
    expect(donePayload.type).toBe("turn.done");
    expect(donePayload.agentName).toBe("my-agent");
    expect(donePayload.conversationId).toBe("conv-abc");
    expect(donePayload.result).toEqual(result);
  });

  // Test 10: turn.error on exception
  it("turn.error event emitted on LLM exception", async () => {
    const llmError = new Error("LLM crashed");
    const llmClient: LlmClient = {
      chat: vi.fn().mockRejectedValue(llmError),
    };

    const eventBus = new EventBus();
    const errorListener = vi.fn();
    const doneListener = vi.fn();
    eventBus.on("turn.error", errorListener);
    eventBus.on("turn.done", doneListener);

    const deps = makeDeps({ llmClient, eventBus });
    const result = await executeTurn("agent-1", "input", undefined, deps);

    expect(result.status).toBe("error");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("LLM crashed");

    expect(errorListener).toHaveBeenCalledOnce();
    const errorPayload = errorListener.mock.calls[0][0];
    expect(errorPayload.type).toBe("turn.error");
    expect(errorPayload.error).toBeInstanceOf(Error);
    expect(errorPayload.error.message).toContain("LLM crashed");

    // turn.done should NOT be emitted on error
    expect(doneListener).not.toHaveBeenCalled();
  });

  // Test 11: Inbound message auto-appended to conversation (FR-CORE-007)
  it("FR-CORE-007: inbound message is appended to conversation before LLM is called", async () => {
    let capturedMessages: Message[] | undefined;
    const llmClient: LlmClient = {
      chat: vi.fn().mockImplementation(async (messages: Message[]) => {
        capturedMessages = [...messages];
        return { text: "response" };
      }),
    };

    const deps = makeDeps({ llmClient });
    await executeTurn("agent-1", "user message text", undefined, deps);

    // LLM should have been called with user message pre-populated
    expect(capturedMessages).toBeDefined();
    expect(capturedMessages!.length).toBeGreaterThanOrEqual(1);

    const userMessages = capturedMessages!.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toContain("user message text");
  });

  // Test 11b: Verify conversation state directly after turn
  it("FR-CORE-007: inbound message stored in conversation state after turn", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const deps = makeDeps({ llmClient });

    await executeTurn("agent-1", "hello from user", undefined, deps);

    const messages = deps.conversationState.messages;
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toContain("hello from user");
  });

  // Test 12: LLM response + tool results also appended to conversation
  it("FR-CORE-007: LLM response and tool results appended to conversation", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("calc_tool"));

    const llmClient = makeLlmClient([
      {
        text: "Using calculator",
        toolCalls: [{ toolCallId: "call-1", toolName: "calc_tool", args: { value: "42" } }],
      },
      { text: "Final answer after tool" },
    ]);

    const deps = makeDeps({ llmClient, toolRegistry });
    await executeTurn("agent-1", "Calculate something", undefined, deps);

    const messages = deps.conversationState.messages;

    // Should have: user message, assistant (with tool_use), tool result, assistant (final)
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const toolMessages = messages.filter((m) => m.role === "tool");

    expect(userMessages).toHaveLength(1);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages).toHaveLength(1);

    // Check tool result was appended
    const toolMessage = toolMessages[0];
    const toolContent = toolMessage.content as Array<{ type: string; toolCallId: string }>;
    expect(toolContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_result", toolCallId: "call-1" }),
      ])
    );

    // Final assistant response appended
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
    const lastContent = lastAssistantMessage.content as Array<{ type: string; text: string }>;
    expect(lastContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Final answer after tool" }),
      ])
    );
  });

  // Additional: conversationId from options takes precedence
  it("conversationId from options is used when provided", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();
    let capturedCtx: TurnContext | undefined;

    registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
      capturedCtx = ctx;
      return next();
    });

    const deps = makeDeps({ llmClient, middlewareRegistry });
    await executeTurn("agent-1", "input", { conversationId: "my-conv-id" }, deps);

    expect(capturedCtx!.conversationId).toBe("my-conv-id");
  });

  // Additional: conversationId from InboundEnvelope used when no options
  it("conversationId from InboundEnvelope used when no options.conversationId", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const middlewareRegistry = new MiddlewareRegistry();
    let capturedCtx: TurnContext | undefined;

    registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
      capturedCtx = ctx;
      return next();
    });

    const envelope: InboundEnvelope = {
      name: "test",
      content: [{ type: "text", text: "hello" }],
      properties: {},
      conversationId: "envelope-conv-id",
      source: {
        connector: "test",
        connectionName: "conn-1",
        receivedAt: new Date().toISOString(),
      },
    };

    const deps = makeDeps({ llmClient, middlewareRegistry });
    await executeTurn("agent-1", envelope, undefined, deps);

    expect(capturedCtx!.conversationId).toBe("envelope-conv-id");
  });

  // Additional: _turnActive is reset to false after turn completes
  it("conversationState._turnActive is set to false after turn completes", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const deps = makeDeps({ llmClient });

    expect(deps.conversationState._turnActive).toBe(false);
    await executeTurn("agent-1", "input", undefined, deps);
    expect(deps.conversationState._turnActive).toBe(false);
  });

  // Additional: _turnActive is reset to false even on error
  it("conversationState._turnActive is reset to false even on error", async () => {
    const llmClient: LlmClient = {
      chat: vi.fn().mockRejectedValue(new Error("crash")),
    };
    const deps = makeDeps({ llmClient });

    await executeTurn("agent-1", "input", undefined, deps);
    expect(deps.conversationState._turnActive).toBe(false);
  });
});

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

function messageRole(message: Message): Message["data"]["role"] {
  return message.data.role;
}

function messageContent(message: Message): any {
  return message.data.content;
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
    const llmClient = makeLlmClient({
      text: "Hello, world!",
      finishReason: "stop",
      rawFinishReason: "stop",
    });
    const deps = makeDeps({ llmClient });

    const result = await executeTurn("agent-1", "Hi there", undefined, deps);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Hello, world!");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stepNumber).toBe(1);
    expect(result.steps[0].toolCalls).toHaveLength(0);
    expect(result.finishReason).toBe("stop");
    expect(result.rawFinishReason).toBe("stop");
    expect(result.steps[0].finishReason).toBe("stop");
    expect(result.steps[0].rawFinishReason).toBe("stop");
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
        finishReason: "tool-calls",
        rawFinishReason: "tool_use",
        toolCalls: [{ toolCallId: "call-1", toolName: "my_tool", args: { value: "x" } }],
      },
      { text: "Final answer", finishReason: "stop", rawFinishReason: "stop" },
    ]);

    const deps = makeDeps({ llmClient, toolRegistry });
    const result = await executeTurn("agent-1", "Do something", undefined, deps);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Final answer");
    expect(result.steps).toHaveLength(2);
    expect(result.finishReason).toBe("stop");
    expect(result.rawFinishReason).toBe("stop");
    expect(result.steps[0].finishReason).toBe("tool-calls");
    expect(result.steps[1].finishReason).toBe("stop");
    expect(result.steps[0].toolCalls).toHaveLength(1);
    expect(result.steps[0].toolCalls[0].toolName).toBe("my_tool");
    expect(result.steps[1].toolCalls).toHaveLength(0);
    expect(toolHandler).toHaveBeenCalledOnce();
  });

  it("adds steered ingress input to the same turn and continues the step loop", async () => {
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

    const llmClient: LlmClient = {
      chat: vi.fn(async (messages) => {
        capturedMessages.push([...(messages as Message[])]);
        callCount++;
        if (callCount === 1) {
          firstChatStarted();
          await firstResponseGate;
          return { text: "first answer", finishReason: "stop" as const };
        }
        return { text: "answer after steer", finishReason: "stop" as const };
      }),
    };
    const deps = makeDeps({ llmClient });
    let queuedInputs: InboundEnvelope[] = [];
    const steering = {
      drain: () => {
        const inputs = queuedInputs;
        queuedInputs = [];
        return inputs;
      },
    };

    const turnPromise = executeTurn("agent-1", "original input", undefined, {
      ...deps,
      steering,
    });

    await firstChatStartedPromise;
    queuedInputs.push(makeEnvelope("mid-turn input"));
    releaseFirstResponse();

    const result = await turnPromise;

    expect(result.status).toBe("completed");
    expect(result.text).toBe("answer after steer");
    expect(result.steps).toHaveLength(2);
    expect(llmClient.chat).toHaveBeenCalledTimes(2);
    expect(capturedMessages[1].some((message) =>
      messageRole(message) === "user" && messageContent(message) === "mid-turn input",
    )).toBe(true);
  });

  it("adds step usage to StepSummary and aggregates TurnResult totalUsage", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool"));

    const llmClient = makeLlmClient([
      {
        text: "Using tool",
        toolCalls: [{ toolCallId: "call-1", toolName: "my_tool", args: { value: "x" } }],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: {
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
          },
          outputTokenDetails: {
            reasoningTokens: 2,
          },
        },
      },
      {
        text: "Final answer",
        usage: {
          inputTokens: 20,
          outputTokens: 7,
          totalTokens: 27,
          inputTokenDetails: {
            cacheReadTokens: 4,
            cacheWriteTokens: 2,
          },
          outputTokenDetails: {
            reasoningTokens: 5,
          },
        },
      },
    ]);

    const deps = makeDeps({ llmClient, toolRegistry });
    const result = await executeTurn("agent-1", "Do something", undefined, deps);

    expect(result.steps[0].usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputTokenDetails: {
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
      outputTokenDetails: {
        reasoningTokens: 2,
      },
    });
    expect(result.steps[1].usage).toEqual({
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      inputTokenDetails: {
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
      },
      outputTokenDetails: {
        reasoningTokens: 5,
      },
    });
    expect(result.totalUsage).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      inputTokenDetails: {
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
      },
      outputTokenDetails: {
        reasoningTokens: 7,
      },
    });
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
    expect(errorPayload.status).toBe("error");
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

    const userMessages = capturedMessages!.filter((m) => messageRole(m) === "user");
    expect(userMessages).toHaveLength(1);
    expect(messageContent(userMessages[0])).toContain("user message text");
  });

  // Test 11b: Verify conversation state directly after turn
  it("FR-CORE-007: inbound message stored in conversation state after turn", async () => {
    const llmClient = makeLlmClient({ text: "response" });
    const deps = makeDeps({ llmClient });

    await executeTurn("agent-1", "hello from user", undefined, deps);

    const messages = deps.conversationState.messages;
    const userMessages = messages.filter((m) => messageRole(m) === "user");
    expect(userMessages).toHaveLength(1);
    expect(messageContent(userMessages[0])).toContain("hello from user");
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

    // Should have: user message, assistant (with tool-call), tool result, assistant (final)
    const userMessages = messages.filter((m) => messageRole(m) === "user");
    const assistantMessages = messages.filter((m) => messageRole(m) === "assistant");
    const toolMessages = messages.filter((m) => messageRole(m) === "tool");

    expect(userMessages).toHaveLength(1);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages).toHaveLength(1);

    // Check tool result was appended
    const toolMessage = toolMessages[0];
    const toolContent = messageContent(toolMessage) as Array<{ type: string; toolCallId: string }>;
    expect(toolContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-result", toolCallId: "call-1" }),
      ])
    );

    // Final assistant response appended
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
    const lastContent = messageContent(lastAssistantMessage) as Array<{ type: string; text: string }>;
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

  // -----------------------------------------------------------------------
  // FR-CORE-008: TurnContext.llm — Extension에서 LLM 호출 가능
  // -----------------------------------------------------------------------

  describe("FR-CORE-008: TurnContext.llm", () => {
    // AC-15: Turn 미들웨어에서 ctx.llm.chat()을 호출할 수 있다
    it("AC-15: turn middleware can call ctx.llm.chat() and get a response", async () => {
      const llmClient = makeLlmClient({ text: "main response" });
      const middlewareRegistry = new MiddlewareRegistry();
      let middlewareLlmResult: unknown;

      registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
        // Extension이 ctx.llm을 통해 직접 LLM 호출
        middlewareLlmResult = await ctx.llm.chat(
          [{ id: "ext-1", data: { role: "user" as const, content: "summarize this" } }],
          [],
          ctx.abortSignal,
        );
        return next();
      });

      const deps = makeDeps({ llmClient, middlewareRegistry });
      const result = await executeTurn("agent-1", "Hello", undefined, deps);

      // ctx.llm.chat이 호출됨 — 미들웨어에서 1회 + 코어 실행에서 1회 = 최소 2회
      expect(llmClient.chat).toHaveBeenCalledTimes(2);
      expect(middlewareLlmResult).toEqual({ text: "main response" });
      expect(result.status).toBe("completed");
    });

    // TurnContext.llm은 코어가 주입한 것과 동일한 LlmClient 인스턴스다
    it("ctx.llm is the same LlmClient instance passed to executeTurn", async () => {
      const llmClient = makeLlmClient({ text: "response" });
      const middlewareRegistry = new MiddlewareRegistry();
      let capturedLlm: LlmClient | undefined;

      registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
        capturedLlm = ctx.llm;
        return next();
      });

      const deps = makeDeps({ llmClient, middlewareRegistry });
      await executeTurn("agent-1", "Hello", undefined, deps);

      expect(capturedLlm).toBe(llmClient);
    });

    // StepContext도 TurnContext.llm을 상속한다 (propagation)
    it("StepContext inherits llm from TurnContext (auto-propagation)", async () => {
      const llmClient = makeLlmClient({ text: "response" });
      const middlewareRegistry = new MiddlewareRegistry();
      let stepLlmRef: LlmClient | undefined;

      // Step 미들웨어에서 ctx.llm 접근
      middlewareRegistry.register(
        "step",
        ((ctx: import("@goondan/openharness-types").StepContext, next: () => Promise<unknown>) => {
          stepLlmRef = ctx.llm;
          return next();
        }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      );

      const deps = makeDeps({ llmClient, middlewareRegistry });
      await executeTurn("agent-1", "Hello", undefined, deps);

      expect(stepLlmRef).toBe(llmClient);
    });

    // EXEC-CONST-006: ctx.llm.chat() 호출이 대화 상태에 자동 반영되지 않는다
    it("EXEC-CONST-006: ctx.llm.chat() does NOT auto-append to conversation state", async () => {
      const llmClient: LlmClient = {
        chat: vi.fn()
          .mockResolvedValueOnce({ text: "side-channel response" })  // 미들웨어에서 호출
          .mockResolvedValue({ text: "main response" }),              // 코어에서 호출
      };
      const middlewareRegistry = new MiddlewareRegistry();

      registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
        // Extension이 ctx.llm으로 별도 LLM 호출 (대화 외 용도)
        await ctx.llm.chat(
          [{ id: "side-1", data: { role: "user" as const, content: "side query" } }],
          [],
          ctx.abortSignal,
        );
        return next();
      });

      const deps = makeDeps({ llmClient, middlewareRegistry });
      await executeTurn("agent-1", "user input", undefined, deps);

      const messages = deps.conversationState.messages;
      // "side-channel response"가 대화 메시지에 포함되지 않아야 한다
      const allContent = messages.map((m) => {
        const c = m.data.content;
        return typeof c === "string" ? c : JSON.stringify(c);
      }).join(" ");
      expect(allContent).not.toContain("side-channel response");
      expect(allContent).toContain("user input");
    });

    // 실패 케이스: ctx.llm.chat()이 에러를 던져도 Turn은 미들웨어의 에러 핸들링에 따른다
    it("ctx.llm.chat() error in middleware propagates as turn error if not caught", async () => {
      const llmClient: LlmClient = {
        chat: vi.fn().mockRejectedValue(new Error("LLM API down")),
      };
      const middlewareRegistry = new MiddlewareRegistry();

      registerTurnMiddleware(middlewareRegistry, async (ctx, next) => {
        // Extension이 ctx.llm.chat()을 호출하고 에러를 잡지 않음
        await ctx.llm.chat([], [], ctx.abortSignal);
        return next();
      });

      const deps = makeDeps({ llmClient, middlewareRegistry });
      const result = await executeTurn("agent-1", "Hello", undefined, deps);

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("LLM API down");
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeToolCall } from "../../execution/tool-call.js";
import { makeStoreWrapCtxFor } from "../../execution/store-injection.js";
import { ToolRegistry } from "../../tool-registry.js";
import { MiddlewareRegistry } from "../../middleware-chain.js";
import { EventBus } from "../../event-bus.js";
import { createConversationState } from "../../conversation-state.js";
import { createMemoryStoreBacking, createScopedStore } from "../../store.js";
import { createInMemoryHumanApprovalStore } from "@goondan/openharness-adapters";
import type {
  ToolCallContext,
  ToolResult,
  ToolContext,
  ToolDefinition,
} from "@goondan/openharness-types";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeToolCallContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation: createConversationState(),
    store: createScopedStore(createMemoryStoreBacking(), "core", "conv-1"),
    abortSignal: makeAbortSignal(),
    input: {
      name: "test",
      content: [],
      properties: {},
      source: { connector: "test", connectionName: "conn-1", receivedAt: new Date().toISOString() },
    },
    stepNumber: 1,
    toolName: "my_tool",
    toolArgs: { value: "hello" },
    llm: { chat: vi.fn().mockResolvedValue({ text: "mock" }) },
    ...overrides,
  };
}

function unsafeToolArgs(value: unknown): ToolCallContext["toolArgs"] {
  return value as ToolCallContext["toolArgs"];
}

function makeTool(
  name: string,
  handler?: ToolDefinition["handler"],
  schema?: Record<string, unknown>
): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: schema ?? {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: handler ?? (async (_args, _ctx) => ({ type: "text", text: "ok" })),
  };
}

function makeDeps(opts?: {
  toolRegistry?: ToolRegistry;
  middlewareRegistry?: MiddlewareRegistry;
  eventBus?: EventBus;
}) {
  return {
    toolRegistry: opts?.toolRegistry ?? new ToolRegistry(),
    middlewareRegistry: opts?.middlewareRegistry ?? new MiddlewareRegistry(),
    eventBus: opts?.eventBus ?? new EventBus(),
  };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("executeToolCall", () => {
  // Test 1: Valid tool call → handler invoked, result returned
  it("valid tool call → handler invoked, result returned", async () => {
    const handler = vi.fn(async (): Promise<ToolResult> => ({
      type: "text",
      text: "handler result",
    }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", handler));

    const ctx = makeToolCallContext({ toolName: "my_tool", toolArgs: { value: "hello" } });
    const deps = makeDeps({ toolRegistry });

    const result = await executeToolCall("call-1", ctx, deps);

    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ type: "text", text: "handler result" });
  });

  // Test 2: Tool not in registry → error result returned to LLM
  it("tool not in registry → error result returned", async () => {
    const toolRegistry = new ToolRegistry();
    const ctx = makeToolCallContext({ toolName: "unknown_tool", toolArgs: {} });
    const deps = makeDeps({ toolRegistry });

    const result = await executeToolCall("call-2", ctx, deps);

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toMatch(/unknown_tool/i);
    }
  });

  // Test 3: JSON Schema validation fails → error result, handler NOT called
  it("JSON Schema validation fails → error result, handler NOT called", async () => {
    const handler = vi.fn(async (): Promise<ToolResult> => ({
      type: "text",
      text: "should not be called",
    }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      makeTool("strict_tool", handler, {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      })
    );

    // Pass args that fail validation (missing required "name")
    const ctx = makeToolCallContext({ toolName: "strict_tool", toolArgs: { wrong: "arg" } });
    const deps = makeDeps({ toolRegistry });

    const result = await executeToolCall("call-3", ctx, deps);

    expect(result.type).toBe("error");
    expect(handler).not.toHaveBeenCalled();
  });

  it("recovers JSON-string args before validation and handler invocation", async () => {
    let capturedArgs: unknown;
    const handler = vi.fn(async (args): Promise<ToolResult> => {
      capturedArgs = args;
      return { type: "text", text: "hello Alice" };
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      makeTool("strict_tool", handler, {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      })
    );

    const eventBus = new EventBus();
    const startListener = vi.fn();
    const doneListener = vi.fn();
    eventBus.on("tool.start", startListener);
    eventBus.on("tool.done", doneListener);

    const ctx = makeToolCallContext({
      toolName: "strict_tool",
      toolArgs: unsafeToolArgs(JSON.stringify({ name: "Alice" })),
    });
    const deps = makeDeps({ toolRegistry, eventBus });

    const result = await executeToolCall("call-json-string", ctx, deps);

    expect(result).toEqual({ type: "text", text: "hello Alice" });
    expect(handler).toHaveBeenCalledOnce();
    expect(capturedArgs).toEqual({ name: "Alice" });
    expect(startListener.mock.calls[0][0].args).toEqual({ name: "Alice" });
    expect(doneListener.mock.calls[0][0].args).toEqual({ name: "Alice" });
  });

  // Test 4: ToolCall middleware wraps execution
  it("ToolCall middleware wraps execution", async () => {
    const executionOrder: string[] = [];
    const handler = vi.fn(async (): Promise<ToolResult> => {
      executionOrder.push("handler");
      return { type: "text", text: "wrapped" };
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", handler));

    const middlewareRegistry = new MiddlewareRegistry();
    middlewareRegistry.register("toolCall", async (ctx, next) => {
      executionOrder.push("middleware-before");
      const result = await next();
      executionOrder.push("middleware-after");
      return result;
    });

    const ctx = makeToolCallContext({ toolName: "my_tool", toolArgs: { value: "hello" } });
    const deps = makeDeps({ toolRegistry, middlewareRegistry });

    const result = await executeToolCall("call-4", ctx, deps);

    expect(result).toEqual({ type: "text", text: "wrapped" });
    expect(executionOrder).toEqual(["middleware-before", "handler", "middleware-after"]);
  });

  it("validates and executes with ToolCall middleware override args", async () => {
    const handler = vi.fn(async (args): Promise<ToolResult> => {
      return { type: "text", text: `hello ${String(args.name)}` };
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      makeTool("strict_tool", handler, {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      })
    );

    const eventBus = new EventBus();
    const doneListener = vi.fn();
    eventBus.on("tool.done", doneListener);

    const middlewareRegistry = new MiddlewareRegistry();
    middlewareRegistry.register("toolCall", async (_ctx, next) => {
      return next({ toolArgs: { name: "Alice" } });
    });

    const ctx = makeToolCallContext({
      toolName: "strict_tool",
      toolArgs: { wrong: "arg" },
    });
    const deps = makeDeps({ toolRegistry, middlewareRegistry, eventBus });

    const result = await executeToolCall("call-override-args", ctx, deps);

    expect(result).toEqual({ type: "text", text: "hello Alice" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({ name: "Alice" });
    expect(doneListener).toHaveBeenCalledOnce();
    expect(doneListener.mock.calls[0][0].args).toEqual({ name: "Alice" });
  });

  it("ToolCall middleware arg overrides are used when creating human approval gates", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      ...makeTool("strict_tool", undefined, {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      }),
      humanApproval: { required: true, prompt: "Approve?" },
    });

    const middlewareRegistry = new MiddlewareRegistry();
    middlewareRegistry.register("toolCall", async (_ctx, next) => {
      return next({ toolArgs: { name: "Alice" } });
    });

    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const createApproval = humanApprovalStore.createApproval.bind(humanApprovalStore);
    const createApprovalSpy = vi.spyOn(humanApprovalStore, "createApproval").mockImplementation(createApproval);

    const ctx = makeToolCallContext({
      toolName: "strict_tool",
      toolArgs: { wrong: "arg" },
    });
    const deps = { ...makeDeps({ toolRegistry, middlewareRegistry }), humanApprovalStore };

    await expect(executeToolCall("call-override-approval", ctx, deps)).rejects.toThrow(/Human Approval/);

    expect(createApprovalSpy).toHaveBeenCalledOnce();
    expect(createApprovalSpy.mock.calls[0][0].toolCall.toolArgs).toEqual({ name: "Alice" });
  });

  // Test 5: Middleware blocks (no next()) → handler NOT called, middleware result used
  it("middleware blocks without calling next → handler NOT called, middleware result used", async () => {
    const handler = vi.fn(async (): Promise<ToolResult> => ({
      type: "text",
      text: "should not be called",
    }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", handler));

    const middlewareRegistry = new MiddlewareRegistry();
    middlewareRegistry.register("toolCall", async (_ctx, _next) => {
      // Deliberately does NOT call next()
      return { type: "text", text: "blocked by middleware" };
    });

    const ctx = makeToolCallContext({ toolName: "my_tool", toolArgs: { value: "hello" } });
    const deps = makeDeps({ toolRegistry, middlewareRegistry });

    const result = await executeToolCall("call-5", ctx, deps);

    expect(result).toEqual({ type: "text", text: "blocked by middleware" });
    expect(handler).not.toHaveBeenCalled();
  });

  // Test 6: Handler throws → tool.error event emitted, error result returned
  it("handler throws → tool.error event emitted, error result returned", async () => {
    const handler = vi.fn(async (): Promise<ToolResult> => {
      throw new Error("handler explosion");
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", handler));

    const eventBus = new EventBus();
    const errorListener = vi.fn();
    eventBus.on("tool.error", errorListener);

    const ctx = makeToolCallContext({ toolName: "my_tool", toolArgs: { value: "hello" } });
    const deps = makeDeps({ toolRegistry, eventBus });

    const result = await executeToolCall("call-6", ctx, deps);

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toContain("handler explosion");
    }
    expect(errorListener).toHaveBeenCalledOnce();
    const payload = errorListener.mock.calls[0][0];
    expect(payload.type).toBe("tool.error");
    expect(payload.toolName).toBe("my_tool");
    expect(payload.error).toBeInstanceOf(Error);
    expect(payload.error.message).toContain("handler explosion");
  });

  // Test 7: AbortSignal passed to handler in ToolContext
  it("AbortSignal passed to handler in ToolContext", async () => {
    const abortController = new AbortController();
    let capturedCtx: ToolContext | undefined;

    const handler = vi.fn(async (_args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      capturedCtx = ctx;
      return { type: "text", text: "ok" };
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", handler));

    const ctx = makeToolCallContext({
      toolName: "my_tool",
      toolArgs: { value: "hello" },
      abortSignal: abortController.signal,
    });
    const deps = makeDeps({ toolRegistry });

    await executeToolCall("call-7", ctx, deps);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.abortSignal).toBe(abortController.signal);
  });

  // Test 8: tool.start and tool.done events emitted
  it("tool.start and tool.done events emitted", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool"));

    const eventBus = new EventBus();
    const startListener = vi.fn();
    const doneListener = vi.fn();
    eventBus.on("tool.start", startListener);
    eventBus.on("tool.done", doneListener);

    const ctx = makeToolCallContext({
      toolName: "my_tool",
      toolArgs: { value: "hello" },
      turnId: "turn-99",
      agentName: "agent-x",
      conversationId: "conv-z",
      stepNumber: 3,
    });
    const deps = makeDeps({ toolRegistry, eventBus });

    const result = await executeToolCall("call-8", ctx, deps);

    expect(startListener).toHaveBeenCalledOnce();
    const startPayload = startListener.mock.calls[0][0];
    expect(startPayload.type).toBe("tool.start");
    expect(startPayload.turnId).toBe("turn-99");
    expect(startPayload.agentName).toBe("agent-x");
    expect(startPayload.conversationId).toBe("conv-z");
    expect(startPayload.stepNumber).toBe(3);
    expect(startPayload.toolCallId).toBe("call-8");
    expect(startPayload.toolName).toBe("my_tool");
    expect(startPayload.args).toEqual({ value: "hello" });

    expect(doneListener).toHaveBeenCalledOnce();
    const donePayload = doneListener.mock.calls[0][0];
    expect(donePayload.type).toBe("tool.done");
    expect(donePayload.toolCallId).toBe("call-8");
    expect(donePayload.result).toEqual(result);
  });

  it("does not re-emit human approval created events for duplicate gate creation", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      ...makeTool("my_tool"),
      humanApproval: { required: true, prompt: "Approve?" },
    });
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const eventBus = new EventBus();
    const gateCreated = vi.fn();
    const taskCreated = vi.fn();
    eventBus.on("humanApproval.created", gateCreated);
    eventBus.on("humanTask.created", taskCreated);

    const ctx = makeToolCallContext({ toolName: "my_tool", toolArgs: { value: "hello" } });
    const deps = { ...makeDeps({ toolRegistry, eventBus }), humanApprovalStore };

    await expect(executeToolCall("call-duplicate-gate", ctx, deps)).rejects.toThrow(/Human Approval/);
    await expect(executeToolCall("call-duplicate-gate", ctx, deps)).rejects.toThrow(/Human Approval/);

    expect(gateCreated).toHaveBeenCalledOnce();
    expect(taskCreated).toHaveBeenCalledOnce();
  });

  it("emits human approval created events from public store result fields", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      ...makeTool("my_tool"),
      humanApproval: { required: true, prompt: "Approve?" },
    });
    const humanApprovalStore = createInMemoryHumanApprovalStore();
    const createApproval = humanApprovalStore.createApproval.bind(humanApprovalStore);
    vi.spyOn(humanApprovalStore, "createApproval").mockImplementation(async (input) => {
      const result = await createApproval(input as any);
      return {
        approval: result.approval,
        duplicate: result.duplicate,
        tasks: result.tasks,
      } as any;
    });
    const eventBus = new EventBus();
    const gateCreated = vi.fn();
    const taskCreated = vi.fn();
    eventBus.on("humanApproval.created", gateCreated);
    eventBus.on("humanTask.created", taskCreated);

    const ctx = makeToolCallContext({ toolName: "my_tool", toolArgs: { value: "hello" } });
    const deps = { ...makeDeps({ toolRegistry, eventBus }), humanApprovalStore };

    await expect(executeToolCall("call-public-store", ctx, deps as any)).rejects.toThrow(/Human Approval/);

    expect(gateCreated).toHaveBeenCalledOnce();
    expect(taskCreated).toHaveBeenCalledOnce();
    expect(taskCreated.mock.calls[0][0].taskType).toBe("approval");
  });

  // P1 regression: toolCall middleware must receive a ctx.store scoped to its
  // OWN registering extension (extension × conversationId), not the shared
  // default/core store. Two extensions writing the same key must not see each
  // other's data.
  it("scopes ctx.store per registering extension across toolCall middleware", async () => {
    const handler = vi.fn(async (): Promise<ToolResult> => ({ type: "text", text: "ok" }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(makeTool("my_tool", handler));

    // Shared backing for the whole conversation — isolation comes from the
    // per-layer wrapCtx, not from separate backings.
    const backing = createMemoryStoreBacking();

    let seenByExtA: unknown;
    let seenByExtB: unknown;

    const middlewareRegistry = new MiddlewareRegistry();
    // ext-a runs first (outer), writes its own value under "secret".
    middlewareRegistry.register(
      "toolCall",
      async (rawCtx, next) => {
        const ctx = rawCtx as ToolCallContext;
        await ctx.store.set("secret", "from-a");
        // Should never observe ext-b's value (different scope).
        seenByExtA = await ctx.store.get("secret");
        return next();
      },
      { name: "mw-a" },
      "ext-a",
    );
    // ext-b runs second (inner), writes its own value under the SAME key.
    middlewareRegistry.register(
      "toolCall",
      async (rawCtx, next) => {
        const ctx = rawCtx as ToolCallContext;
        // Before writing, ext-b must not see ext-a's value.
        seenByExtB = await ctx.store.get("secret");
        await ctx.store.set("secret", "from-b");
        return next();
      },
      { name: "mw-b", after: "mw-a" },
      "ext-b",
    );

    const ctx = makeToolCallContext({
      toolName: "my_tool",
      toolArgs: { value: "hello" },
      conversationId: "conv-scope",
      // Base ctx.store is the default "core" store; wrapCtx re-scopes each layer.
      store: createScopedStore(backing, "core", "conv-scope"),
    });

    const deps = {
      ...makeDeps({ toolRegistry, middlewareRegistry }),
      storeWrapCtxFor: makeStoreWrapCtxFor<ToolCallContext>(backing, "conv-scope"),
    };

    const result = await executeToolCall("call-scope", ctx, deps);

    expect(result).toEqual({ type: "text", text: "ok" });
    // ext-a reads back its own write.
    expect(seenByExtA).toBe("from-a");
    // ext-b never saw ext-a's value despite the shared key.
    expect(seenByExtB).toBeUndefined();

    // The two writes landed in distinct, extension-scoped namespaces.
    const storeA = createScopedStore(backing, "ext-a", "conv-scope");
    const storeB = createScopedStore(backing, "ext-b", "conv-scope");
    expect(await storeA.get("secret")).toBe("from-a");
    expect(await storeB.get("secret")).toBe("from-b");

    // The default "core" store was untouched by either extension.
    const coreStore = createScopedStore(backing, "core", "conv-scope");
    expect(await coreStore.get("secret")).toBeUndefined();
  });
});

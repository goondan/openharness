import { describe, it, expect, vi } from "vitest";
import { ContextMessage } from "../extensions/context-message.js";
import type {
  ExtensionApi,
  TurnMiddleware,
  TurnContext,
  TurnResult,
  ConversationState,
  Message,
  MessageEvent,
} from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockConversationState(): ConversationState & { emitted: MessageEvent[] } {
  const emitted: MessageEvent[] = [];
  const messages: Message[] = [];
  return {
    messages,
    events: [],
    emitted,
    emit: vi.fn((event: MessageEvent) => {
      emitted.push(event);
      if (event.type === "append") {
        messages.push(event.message);
      }
    }),
    restore: vi.fn(),
  };
}

function makeMockApi(conversation: ConversationState): {
  api: ExtensionApi;
  registeredMiddleware: Array<{ level: string; handler: TurnMiddleware; options?: { priority?: number } }>;
} {
  const registeredMiddleware: Array<{ level: string; handler: TurnMiddleware; options?: { priority?: number } }> = [];

  const api: ExtensionApi = {
    pipeline: {
      register: vi.fn((level: string, handler: TurnMiddleware, options?: { priority?: number }) => {
        registeredMiddleware.push({ level, handler, options });
      }) as unknown as ExtensionApi["pipeline"]["register"],
    },
    tools: {
      register: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => []),
    },
    on: vi.fn(),
    conversation,
    runtime: {
      agent: {
        name: "test-agent",
        model: { provider: "openai", model: "gpt-4o" },
        extensions: [],
        tools: [],
      },
      agents: {},
      connections: {},
    },
  };

  return { api, registeredMiddleware };
}

function makeTurnContext(conversation: ConversationState): TurnContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation,
    abortSignal: new AbortController().signal,
    input: {
      name: "test-event",
      content: [{ type: "text", text: "hello" }],
      properties: {},
      source: {
        connector: "test-connector",
        connectionName: "test",
        receivedAt: new Date().toISOString(),
      },
    },
  };
}

const stubTurnResult: TurnResult = {
  turnId: "turn-1",
  agentName: "test-agent",
  conversationId: "conv-1",
  status: "completed",
  steps: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextMessage", () => {
  // Test 1: creates Extension with correct name
  it("creates an Extension with name 'context-message'", () => {
    const ext = ContextMessage("You are a helpful assistant.");
    expect(ext.name).toBe("context-message");
  });

  // Test 2: register() adds turn middleware via api.pipeline.register
  it("register() calls api.pipeline.register with level 'turn'", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = ContextMessage("Hello");
    ext.register(api);

    expect(api.pipeline.register).toHaveBeenCalledOnce();
    expect(registeredMiddleware).toHaveLength(1);
    expect(registeredMiddleware[0].level).toBe("turn");
    expect(typeof registeredMiddleware[0].handler).toBe("function");
  });

  // Test 3: middleware is registered with HIGH priority (low number)
  it("registers turn middleware with priority 10 (high priority)", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = ContextMessage("Hello");
    ext.register(api);

    expect(registeredMiddleware[0].options?.priority).toBe(10);
  });

  // Test 4: middleware prepends system message to conversation and text matches
  it("middleware emits append event with system message matching the text argument", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);
    const systemText = "You are a helpful assistant.";

    const ext = ContextMessage(systemText);
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await middleware(ctx, next);

    expect(conversation.emit).toHaveBeenCalledOnce();
    const emitted = conversation.emitted[0];
    expect(emitted.type).toBe("append");
    if (emitted.type === "append") {
      expect(emitted.message.data.role).toBe("system");
      expect(emitted.message.data.content).toBe(systemText);
      expect(emitted.message.metadata?.__createdBy).toBe("context-message");
      expect(typeof emitted.message.id).toBe("string");
    }
  });

  // Test 5: middleware calls next() after emitting
  it("middleware calls next() after emitting the system message", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = ContextMessage("Some context");
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe(stubTurnResult);
  });

  // Test 6: multiple ContextMessage extensions → multiple system messages
  it("multiple ContextMessage extensions each prepend their own system message", async () => {
    const conversation = makeMockConversationState();
    const { api: api1, registeredMiddleware: rm1 } = makeMockApi(conversation);
    const { api: api2, registeredMiddleware: rm2 } = makeMockApi(conversation);

    const ext1 = ContextMessage("First context");
    const ext2 = ContextMessage("Second context");

    ext1.register(api1);
    ext2.register(api2);

    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await rm1[0].handler(ctx, next);
    await rm2[0].handler(ctx, next);

    expect(conversation.emitted).toHaveLength(2);

    const texts = conversation.emitted
      .filter((e): e is Extract<typeof e, { type: "append" }> => e.type === "append")
      .map((e) => e.message.data.content);

    expect(texts).toContain("First context");
    expect(texts).toContain("Second context");
  });
});

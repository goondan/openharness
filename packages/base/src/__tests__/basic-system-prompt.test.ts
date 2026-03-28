import { describe, it, expect, vi } from "vitest";
import { BasicSystemPrompt } from "../extensions/basic-system-prompt.js";
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
    llm: { chat: vi.fn().mockResolvedValue({ text: "mock" }) },
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

describe("BasicSystemPrompt", () => {
  it("creates an Extension with name 'basic-system-prompt'", () => {
    const ext = BasicSystemPrompt("You are helpful.");
    expect(ext.name).toBe("basic-system-prompt");
  });

  it("register() calls api.pipeline.register with level 'turn'", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = BasicSystemPrompt("You are helpful.");
    ext.register(api);

    expect(api.pipeline.register).toHaveBeenCalledOnce();
    expect(registeredMiddleware).toHaveLength(1);
    expect(registeredMiddleware[0].level).toBe("turn");
    expect(typeof registeredMiddleware[0].handler).toBe("function");
  });

  it("registers turn middleware with priority 10 (high priority)", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = BasicSystemPrompt("You are helpful.");
    ext.register(api);

    expect(registeredMiddleware[0].options?.priority).toBe(10);
  });

  it("middleware appends a system message and calls next()", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = BasicSystemPrompt("You are helpful.");
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe(stubTurnResult);

    // Verify system message was emitted
    expect(conversation.emit).toHaveBeenCalledOnce();
    const emittedEvent = conversation.emitted[0];
    expect(emittedEvent.type).toBe("append");
    if (emittedEvent.type === "append") {
      expect(emittedEvent.message.id).toBe("sys-basic-system-prompt");
      expect(emittedEvent.message.data.role).toBe("system");
      expect(emittedEvent.message.data.content).toBe("You are helpful.");
      expect(emittedEvent.message.metadata?.__createdBy).toBe("basic-system-prompt");
    }
  });

  it("does not duplicate the system message on subsequent turns", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = BasicSystemPrompt("You are helpful.");
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const next = vi.fn(async () => stubTurnResult);

    // First turn — should append
    const ctx1 = makeTurnContext(conversation);
    await middleware(ctx1, next);
    expect(conversation.emitted).toHaveLength(1);

    // Second turn — system message already in conversation.messages, should skip
    const ctx2 = makeTurnContext(conversation);
    await middleware(ctx2, next);
    expect(conversation.emitted).toHaveLength(1); // still 1, no new append

    // Third turn — still no duplication
    const ctx3 = makeTurnContext(conversation);
    await middleware(ctx3, next);
    expect(conversation.emitted).toHaveLength(1);

    // next() should have been called every turn
    expect(next).toHaveBeenCalledTimes(3);
  });
});

import { describe, it, expect, vi } from "vitest";
import { CompactionSummarize } from "../extensions/compaction-summarize.js";
import type {
  ExtensionApi,
  StepMiddleware,
  StepContext,
  StepResult,
  ConversationState,
  Message,
  MessageEvent,
} from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    data: {
      role: "user" as const,
      content: `Message ${i}`,
    },
  }));
}

function makeMockConversationState(
  messages: Message[],
): ConversationState & { emitted: MessageEvent[] } {
  const emitted: MessageEvent[] = [];
  return {
    messages,
    events: [],
    emitted,
    emit: vi.fn((event: MessageEvent) => {
      emitted.push(event);
    }),
    restore: vi.fn(),
  };
}

function makeMockApi(conversation: ConversationState): {
  api: ExtensionApi;
  registeredMiddleware: Array<{
    level: string;
    handler: StepMiddleware;
    options?: { priority?: number };
  }>;
} {
  const registeredMiddleware: Array<{
    level: string;
    handler: StepMiddleware;
    options?: { priority?: number };
  }> = [];

  const api: ExtensionApi = {
    pipeline: {
      register: vi.fn(
        (level: string, handler: StepMiddleware, options?: { priority?: number }) => {
          registeredMiddleware.push({ level, handler, options });
        },
      ) as unknown as ExtensionApi["pipeline"]["register"],
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

function makeMockLlmClient() {
  return {
    chat: vi.fn().mockResolvedValue({ text: "LLM-generated summary of the conversation." }),
  };
}

function makeStepContext(conversation: ConversationState): StepContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation,
    stepNumber: 1,
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
    llm: makeMockLlmClient(),
  };
}

const stubStepResult: StepResult = {
  toolCalls: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CompactionSummarize", () => {
  it("creates an Extension with name 'compaction-summarize'", () => {
    const ext = CompactionSummarize({ threshold: 10 });
    expect(ext.name).toBe("compaction-summarize");
  });

  it("registers step middleware via api.pipeline.register", () => {
    const conversation = makeMockConversationState([]);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    expect(api.pipeline.register).toHaveBeenCalledOnce();
    expect(registeredMiddleware[0].level).toBe("step");
  });

  it("does NOT compact when messages are below threshold", async () => {
    const messages = makeMessages(5);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    expect(conversation.emit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("compacts when messages exceed threshold", async () => {
    const messages = makeMessages(12);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    const emitted = (conversation as ReturnType<typeof makeMockConversationState>).emitted;

    // keepCount = floor(10/2) = 5, removeCount = 12 - 5 = 7
    // Should have 7 remove events + 1 appendSystem event
    const removeEvents = emitted.filter((e) => e.type === "remove");
    const appendEvents = emitted.filter((e) => e.type === "appendSystem");

    expect(removeEvents).toHaveLength(7);
    expect(appendEvents).toHaveLength(1);

    // The appended message should be a system summary
    const appendEvent = appendEvents[0];
    if (appendEvent.type === "appendSystem") {
      expect(appendEvent.message.data.role).toBe("system");
      expect(appendEvent.message.data.content).toContain("[Summary of earlier conversation]:");
      expect(appendEvent.message.metadata?.__createdBy).toBe("compaction-summarize");
    }

    expect(next).toHaveBeenCalledOnce();
  });

  it("removes the oldest messages (not the newest)", async () => {
    const messages = makeMessages(12);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    const emitted = (conversation as ReturnType<typeof makeMockConversationState>).emitted;
    const removeEvents = emitted.filter(
      (e): e is Extract<typeof e, { type: "remove" }> => e.type === "remove",
    );

    // Should remove msg-0 through msg-6 (the oldest 7)
    const removedIds = removeEvents.map((e) => e.messageId);
    expect(removedIds).toContain("msg-0");
    expect(removedIds).toContain("msg-6");
    expect(removedIds).not.toContain("msg-7");
    expect(removedIds).not.toContain("msg-11");
  });

  it("summary content includes text from removed messages", async () => {
    const messages = makeMessages(12);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    // Verify LLM was called for summarization
    expect(ctx.llm.chat).toHaveBeenCalledOnce();

    const emitted = (conversation as ReturnType<typeof makeMockConversationState>).emitted;
    const appendEvent = emitted.find((e) => e.type === "appendSystem");
    if (appendEvent && appendEvent.type === "appendSystem") {
      const content = appendEvent.message.data.content as string;
      // Should include the LLM-generated summary
      expect(content).toContain("LLM-generated summary of the conversation.");
    }
  });

  it("uses custom summarizer when provided", async () => {
    const messages = makeMessages(12);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const summarizer = vi.fn(async (msgs: Message[]) => {
      return `Custom summary of ${msgs.length} messages`;
    });

    const ext = CompactionSummarize({ threshold: 10, summarizer });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    // summarizer should have been called with the 7 removed messages
    expect(summarizer).toHaveBeenCalledOnce();
    expect(summarizer).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-0" }),
        expect.objectContaining({ id: "msg-6" }),
      ]),
    );
    expect(summarizer.mock.calls[0][0]).toHaveLength(7);

    const emitted = (conversation as ReturnType<typeof makeMockConversationState>).emitted;
    const appendEvent = emitted.find((e) => e.type === "appendSystem");
    if (appendEvent && appendEvent.type === "appendSystem") {
      const content = appendEvent.message.data.content as string;
      expect(content).toContain("Custom summary of 7 messages");
    }

    expect(next).toHaveBeenCalledOnce();
  });
});

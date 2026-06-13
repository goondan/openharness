import { describe, it, expect, vi } from "vitest";
import { CompactionSummarize } from "../extensions/compaction-summarize.js";
import type {
  StepMiddleware,
  StepResult,
  Message,
} from "@goondan/openharness-types";
import {
  makeMockApi,
  makeMockConversationState,
  makeStepContext,
  makeMessages,
} from "./helpers.js";

const stubStepResult: StepResult = {
  toolCalls: [],
};

describe("CompactionSummarize", () => {
  it("creates an Extension with name 'compaction-summarize'", () => {
    const ext = CompactionSummarize({ threshold: 10 });
    expect(ext.name).toBe("compaction-summarize");
  });

  it("registers a step middleware in the 'context' phase", () => {
    const conversation = makeMockConversationState([]);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    expect(api.pipeline.register).toHaveBeenCalledOnce();
    expect(registeredMiddleware[0].level).toBe("step");
    expect(registeredMiddleware[0].options?.phase).toBe("context");
  });

  it("does NOT compact when messages are below threshold", async () => {
    const messages = makeMessages(5);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as StepMiddleware;
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

    const middleware = registeredMiddleware[0].handler as StepMiddleware;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    const emitted = conversation.emitted;

    // keepCount = floor(10/2) = 5, removeCount = 12 - 5 = 7
    // Should have 7 remove events + 1 appendSystem event
    const removeEvents = emitted.filter((e) => e.type === "remove");
    const appendEvents = emitted.filter((e) => e.type === "appendSystem");

    expect(removeEvents).toHaveLength(7);
    expect(appendEvents).toHaveLength(1);

    // The appended message should be a system summary tagged with provenance.
    const appendEvent = appendEvents[0];
    if (appendEvent.type === "appendSystem") {
      expect(appendEvent.message.data.role).toBe("system");
      expect(appendEvent.message.data.content).toContain(
        "[Summary of earlier conversation]:",
      );
      // F3: createMessage mirrors createdBy into metadata.__createdBy.
      expect(appendEvent.message.createdBy).toBe("compaction-summarize");
      expect(appendEvent.message.metadata?.__createdBy).toBe(
        "compaction-summarize",
      );
    }

    expect(next).toHaveBeenCalledOnce();
  });

  it("removes the oldest messages (not the newest)", async () => {
    const messages = makeMessages(12);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as StepMiddleware;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    const removeEvents = conversation.emitted.filter(
      (e): e is Extract<typeof e, { type: "remove" }> => e.type === "remove",
    );

    const removedIds = removeEvents.map((e) => e.messageId);
    expect(removedIds).toContain("msg-0");
    expect(removedIds).toContain("msg-6");
    expect(removedIds).not.toContain("msg-7");
    expect(removedIds).not.toContain("msg-11");
  });

  it("never removes system messages (only non-system are compaction candidates)", async () => {
    // 2 leading system messages + 11 user messages = 13 total (> threshold 10).
    const systemMsgs: Message[] = [
      { id: "sys-0", data: { role: "system", content: "system prompt" } },
      { id: "sys-1", data: { role: "system", content: "prior summary" } },
    ];
    const messages = [...systemMsgs, ...makeMessages(11)];
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as StepMiddleware;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    const removedIds = conversation.emitted
      .filter((e): e is Extract<typeof e, { type: "remove" }> => e.type === "remove")
      .map((e) => e.messageId);

    // removable = 11 non-system, keepCount = 5, removeCount = 6 → msg-0..msg-5
    expect(removedIds).not.toContain("sys-0");
    expect(removedIds).not.toContain("sys-1");
    expect(removedIds).toContain("msg-0");
    expect(removedIds).toHaveLength(6);
  });

  it("summary content includes text from removed messages", async () => {
    const messages = makeMessages(12);
    const conversation = makeMockConversationState(messages);
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = CompactionSummarize({ threshold: 10 });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as StepMiddleware;
    const ctx = makeStepContext(conversation);
    ctx.llm.chat = vi
      .fn()
      .mockResolvedValue({ text: "LLM-generated summary of the conversation." });
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    expect(ctx.llm.chat).toHaveBeenCalledOnce();

    const appendEvent = conversation.emitted.find(
      (e) => e.type === "appendSystem",
    );
    if (appendEvent && appendEvent.type === "appendSystem") {
      const content = appendEvent.message.data.content as string;
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

    const middleware = registeredMiddleware[0].handler as StepMiddleware;
    const ctx = makeStepContext(conversation);
    const next = vi.fn(async () => stubStepResult);

    await middleware(ctx, next);

    expect(summarizer).toHaveBeenCalledOnce();
    expect(summarizer).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-0" }),
        expect.objectContaining({ id: "msg-6" }),
      ]),
    );
    expect(summarizer.mock.calls[0][0]).toHaveLength(7);

    const appendEvent = conversation.emitted.find(
      (e) => e.type === "appendSystem",
    );
    if (appendEvent && appendEvent.type === "appendSystem") {
      const content = appendEvent.message.data.content as string;
      expect(content).toContain("Custom summary of 7 messages");
    }

    expect(next).toHaveBeenCalledOnce();
  });
});

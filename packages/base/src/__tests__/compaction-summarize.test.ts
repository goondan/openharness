import { describe, it, expect, vi } from "vitest";
import { CompactionSummarize } from "../extensions/compaction-summarize.js";
import type { Message, StepMiddleware } from "@goondan/openharness-types";
import {
  makeMessages,
  makeMockApi,
  makeMockConversationState,
  makeStepContext,
} from "./_mock-api.js";

const stubStepResult = { toolCalls: [] };

/** Pull the single registered step middleware out of the mock api. */
function registerStep(
  conversation: ReturnType<typeof makeMockConversationState>,
  ext: ReturnType<typeof CompactionSummarize>,
): StepMiddleware {
  const { api, registered } = makeMockApi(conversation);
  ext.register(api);
  expect(registered).toHaveLength(1);
  expect(registered[0].kind).toBe("step");
  return registered[0].handler as StepMiddleware;
}

describe("CompactionSummarize", () => {
  it("creates an AgentExtension with name 'compaction-summarize'", () => {
    expect(CompactionSummarize({ threshold: 10 }).name).toBe(
      "compaction-summarize",
    );
  });

  it("registers step middleware via api.useStep", () => {
    const conversation = makeMockConversationState([]);
    const { api, registered } = makeMockApi(conversation);

    CompactionSummarize({ threshold: 10 }).register(api);

    expect(api.useStep).toHaveBeenCalledOnce();
    expect(registered[0].kind).toBe("step");
  });

  it("does NOT compact when messages are below threshold", async () => {
    const conversation = makeMockConversationState(makeMessages(5));
    const mw = registerStep(conversation, CompactionSummarize({ threshold: 10 }));

    const next = vi.fn(async () => stubStepResult);
    await mw(makeStepContext(conversation), next);

    expect(conversation.append).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("durably removes oldest messages and appends a summary", async () => {
    const conversation = makeMockConversationState(makeMessages(12));
    const mw = registerStep(conversation, CompactionSummarize({ threshold: 10 }));

    const next = vi.fn(async () => stubStepResult);
    await mw(makeStepContext(conversation, "LLM summary"), next);

    // keepCount = floor(10/2) = 5, removeCount = 12 - 5 = 7.
    const removes = conversation.appended.filter((e) => e.type === "remove");
    const appends = conversation.appended.filter(
      (e) => e.type === "appendSystem",
    );
    expect(removes).toHaveLength(7);
    expect(appends).toHaveLength(1);

    const append = appends[0];
    if (append.type === "appendSystem") {
      expect(append.message.data.role).toBe("system");
      expect(append.message.data.content).toContain(
        "[Summary of earlier conversation]:",
      );
      expect(append.message.data.content).toContain("LLM summary");
      expect(append.message.createdBy).toBe("compaction-summarize");
    }
    expect(next).toHaveBeenCalledOnce();
  });

  it("removes the oldest messages, not the newest", async () => {
    const conversation = makeMockConversationState(makeMessages(12));
    const mw = registerStep(conversation, CompactionSummarize({ threshold: 10 }));

    await mw(makeStepContext(conversation), vi.fn(async () => stubStepResult));

    const removedIds = conversation.appended
      .filter((e): e is Extract<typeof e, { type: "remove" }> => e.type === "remove")
      .map((e) => e.messageId);
    expect(removedIds).toContain("msg-0");
    expect(removedIds).toContain("msg-6");
    expect(removedIds).not.toContain("msg-7");
    expect(removedIds).not.toContain("msg-11");
  });

  it("never folds system messages into the summary candidates", async () => {
    const system: Message = {
      id: "sys",
      data: { role: "system", content: "system prompt" },
    };
    const summary: Message = {
      id: "old-summary",
      data: { role: "system", content: "earlier summary" },
    };
    const conversation = makeMockConversationState([
      system,
      summary,
      ...makeMessages(12),
    ]);
    const mw = registerStep(conversation, CompactionSummarize({ threshold: 10 }));

    await mw(makeStepContext(conversation), vi.fn(async () => stubStepResult));

    const removedIds = conversation.appended
      .filter((e): e is Extract<typeof e, { type: "remove" }> => e.type === "remove")
      .map((e) => e.messageId);
    // System messages are excluded from removal even though total count > threshold.
    expect(removedIds).not.toContain("sys");
    expect(removedIds).not.toContain("old-summary");
    // removable = 12 user messages, keepCount = 5 → remove 7 oldest user msgs.
    expect(removedIds).toHaveLength(7);
    expect(removedIds).toContain("msg-0");
    expect(removedIds).not.toContain("msg-7");
  });

  it("invokes the agent LLM to produce the summary", async () => {
    const conversation = makeMockConversationState(makeMessages(12));
    const mw = registerStep(conversation, CompactionSummarize({ threshold: 10 }));

    const ctx = makeStepContext(conversation, "LLM-generated summary");
    await mw(ctx, vi.fn(async () => stubStepResult));

    expect(ctx.llm.chat).toHaveBeenCalledOnce();
    const append = conversation.appended.find((e) => e.type === "appendSystem");
    if (append && append.type === "appendSystem") {
      expect(append.message.data.content).toContain("LLM-generated summary");
    }
  });

  it("uses a custom summarizer when provided", async () => {
    const conversation = makeMockConversationState(makeMessages(12));
    const summarizer = vi.fn(
      async (msgs: Message[]) => `Custom summary of ${msgs.length} messages`,
    );
    const mw = registerStep(
      conversation,
      CompactionSummarize({ threshold: 10, summarizer }),
    );

    const next = vi.fn(async () => stubStepResult);
    await mw(makeStepContext(conversation), next);

    expect(summarizer).toHaveBeenCalledOnce();
    expect(summarizer.mock.calls[0][0]).toHaveLength(7);
    expect(summarizer).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "msg-0" }),
        expect.objectContaining({ id: "msg-6" }),
      ]),
    );

    const append = conversation.appended.find((e) => e.type === "appendSystem");
    if (append && append.type === "appendSystem") {
      expect(append.message.data.content).toContain("Custom summary of 7 messages");
    }
    expect(next).toHaveBeenCalledOnce();
  });

  it("does nothing when removable count is at or below keepCount", async () => {
    // 11 messages but 7 are system → only 4 removable, keepCount = 5.
    const systems: Message[] = Array.from({ length: 7 }, (_, i) => ({
      id: `sys-${i}`,
      data: { role: "system", content: `s${i}` },
    }));
    const conversation = makeMockConversationState([
      ...systems,
      ...makeMessages(4),
    ]);
    const mw = registerStep(conversation, CompactionSummarize({ threshold: 10 }));

    const next = vi.fn(async () => stubStepResult);
    await mw(makeStepContext(conversation), next);

    expect(conversation.append).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  BasicSystemPrompt,
  getSystemPromptText,
} from "../extensions/basic-system-prompt.js";
import type { AgentExtension, Message } from "@goondan/openharness-types";
import {
  applyModelInputs,
  makeMockApi,
  makeMockConversationState,
  makeStepContext,
  makeTurnContext,
} from "./_mock-api.js";

const LEGACY_ID = "sys-basic-system-prompt";
const stubTurnResult = {
  turnId: "turn-1",
  agentName: "test-agent",
  conversationId: "conv-1",
  status: "completed" as const,
  steps: [],
};

describe("BasicSystemPrompt", () => {
  it("creates an AgentExtension with name 'basic-system-prompt'", () => {
    const ext = BasicSystemPrompt("You are helpful.");
    expect(ext.name).toBe("basic-system-prompt");
  });

  it("exposes the prompt text via systemPromptText / getSystemPromptText", () => {
    const ext = BasicSystemPrompt("You are helpful.");
    expect(ext.systemPromptText).toBe("You are helpful.");
    expect(getSystemPromptText(ext)).toBe("You are helpful.");
    expect(getSystemPromptText({ name: "other", register() {} })).toBeUndefined();
  });

  it("registers a model-input projection and a legacy-cleanup turn mw", () => {
    const conversation = makeMockConversationState();
    const { api, registered, modelInputs } = makeMockApi(conversation);

    BasicSystemPrompt("You are helpful.").register(api);

    expect(modelInputs).toHaveLength(1);
    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe("turn");
    expect(registered[0].options).toEqual({ before: "*" });
  });

  it("projection prepends the system message without persisting it", async () => {
    const conversation = makeMockConversationState();
    const { api, modelInputs } = makeMockApi(conversation);

    BasicSystemPrompt("You are helpful.").register(api);

    const ctx = makeStepContext(conversation);
    const view = await applyModelInputs(modelInputs, conversation, ctx);

    expect(view).toHaveLength(1);
    expect(view[0].id).toBe(LEGACY_ID);
    expect(view[0].data.role).toBe("system");
    expect(view[0].data.content).toBe("You are helpful.");
    expect(view[0].createdBy).toBe("basic-system-prompt");

    // Durable log is never mutated by the projection.
    expect(conversation.getMessages()).toHaveLength(0);
    expect(conversation.append).not.toHaveBeenCalled();
  });

  it("projection is idempotent and supersedes any leftover legacy copy", async () => {
    const legacy: Message = {
      id: LEGACY_ID,
      data: { role: "system", content: "stale prompt" },
    };
    const user: Message = {
      id: "u1",
      data: { role: "user", content: "hi" },
    };
    const conversation = makeMockConversationState([legacy, user]);
    const { api, modelInputs } = makeMockApi(conversation);

    BasicSystemPrompt("You are helpful.").register(api);

    const ctx = makeStepContext(conversation);
    const view = await applyModelInputs(modelInputs, conversation, ctx);

    // The stale legacy copy is filtered out; exactly one system message leads.
    expect(view.filter((m) => m.id === LEGACY_ID)).toHaveLength(1);
    expect(view[0].data.content).toBe("You are helpful.");
    expect(view[1].id).toBe("u1");
  });

  it("legacy-cleanup turn mw removes a persisted legacy copy exactly once", async () => {
    const legacy: Message = {
      id: LEGACY_ID,
      data: { role: "system", content: "stale prompt" },
    };
    const conversation = makeMockConversationState([legacy]);
    const { api, registered } = makeMockApi(conversation);

    BasicSystemPrompt("You are helpful.").register(api);

    const turnMw = registered[0].handler as (
      ctx: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const next = vi.fn(async () => stubTurnResult);

    await turnMw(makeTurnContext(conversation), next);

    expect(conversation.append).toHaveBeenCalledOnce();
    expect(conversation.appended[0]).toEqual({
      type: "remove",
      messageId: LEGACY_ID,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("legacy-cleanup turn mw is a no-op when no legacy copy exists", async () => {
    const conversation = makeMockConversationState();
    const { api, registered } = makeMockApi(conversation);

    BasicSystemPrompt("You are helpful.").register(api);

    const turnMw = registered[0].handler as (
      ctx: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
    const next = vi.fn(async () => stubTurnResult);

    await turnMw(makeTurnContext(conversation), next);

    expect(conversation.append).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("is assignable to AgentExtension", () => {
    const ext: AgentExtension = BasicSystemPrompt("x");
    expect(ext.name).toBe("basic-system-prompt");
  });
});

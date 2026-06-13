import { describe, it, expect, vi } from "vitest";
import {
  BasicSystemPrompt,
  getSystemPromptText,
} from "../extensions/basic-system-prompt.js";
import type {
  TurnMiddleware,
  TurnResult,
  Message,
  PromptView,
} from "@goondan/openharness-types";
import {
  makeMockApi,
  makeMockConversationState,
  makeTurnContext,
} from "./helpers.js";

const LEGACY_ID = "sys-basic-system-prompt";

const stubTurnResult: TurnResult = {
  turnId: "turn-1",
  agentName: "test-agent",
  conversationId: "conv-1",
  status: "completed",
  steps: [],
};

describe("BasicSystemPrompt", () => {
  it("creates an Extension with name 'basic-system-prompt'", () => {
    const ext = BasicSystemPrompt("You are helpful.");
    expect(ext.name).toBe("basic-system-prompt");
  });

  it("exposes the prompt text via getSystemPromptText", () => {
    const ext = BasicSystemPrompt("You are helpful.");
    expect(ext.systemPromptText).toBe("You are helpful.");
    expect(getSystemPromptText(ext)).toBe("You are helpful.");
  });

  it("getSystemPromptText returns undefined for an unrelated extension", () => {
    const other = { name: "other", register: () => {} };
    expect(getSystemPromptText(other)).toBeUndefined();
  });

  it("registers a legacy-cleanup turn middleware (observe) and a prompt projection", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware, projections } = makeMockApi(conversation);

    BasicSystemPrompt("You are helpful.").register(api);

    expect(registeredMiddleware).toHaveLength(1);
    expect(registeredMiddleware[0].level).toBe("turn");
    expect(registeredMiddleware[0].options?.phase).toBe("observe");

    expect(projections).toHaveLength(1);
    expect(projections[0].name).toBe("basic-system-prompt");
  });

  it("projection prepends a system message with provenance", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    BasicSystemPrompt("You are helpful.").register(api);

    const view = [
      { id: "u-0", data: { role: "user", content: "hi" } },
    ] as PromptView;
    const ctx = makeTurnContext(conversation);
    // The projection only reads the view; a turn ctx satisfies the step shape it needs here.
    const out = await projections[0].projection(view, ctx as never);

    expect(out).toHaveLength(2);
    const system = out[0];
    expect(system.id).toBe(LEGACY_ID);
    expect(system.data.role).toBe("system");
    expect(system.data.content).toBe("You are helpful.");
    expect(system.createdBy).toBe("basic-system-prompt");
    expect(system.metadata?.__createdBy).toBe("basic-system-prompt");
    expect(out[1].id).toBe("u-0");
    // Pure projection — durable log untouched.
    expect(conversation.emit).not.toHaveBeenCalled();
  });

  it("projection is idempotent: applying twice does not duplicate the system message", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    BasicSystemPrompt("You are helpful.").register(api);

    const ctx = makeTurnContext(conversation);
    const proj = projections[0].projection;

    const once = await proj([{ id: "u-0", data: { role: "user", content: "hi" } }] as PromptView, ctx as never);
    const twice = await proj(once, ctx as never);

    const systemCount = twice.filter((m) => m.id === LEGACY_ID).length;
    expect(systemCount).toBe(1);
    expect(twice[0].id).toBe(LEGACY_ID);
  });

  it("cleanup middleware removes a legacy persisted system message once", async () => {
    const legacy: Message = {
      id: LEGACY_ID,
      data: { role: "system", content: "old persisted prompt" },
    };
    const conversation = makeMockConversationState([legacy]);
    const { api, registeredMiddleware } = makeMockApi(conversation);
    BasicSystemPrompt("You are helpful.").register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe(stubTurnResult);
    const removes = conversation.emitted.filter((e) => e.type === "remove");
    expect(removes).toHaveLength(1);
    if (removes[0].type === "remove") {
      expect(removes[0].messageId).toBe(LEGACY_ID);
    }
  });

  it("cleanup middleware is a no-op when there is no legacy message", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);
    BasicSystemPrompt("You are helpful.").register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await middleware(ctx, next);

    expect(conversation.emit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

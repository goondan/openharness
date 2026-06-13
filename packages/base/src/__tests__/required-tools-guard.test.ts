import { describe, it, expect, vi } from "vitest";
import {
  RequiredToolsGuard,
  REQUIRED_TOOLS_GUARD,
} from "../extensions/required-tools-guard.js";
import type { TurnMiddleware, TurnResult } from "@goondan/openharness-types";
import {
  makeMockApi,
  makeMockConversationState,
  makeTurnContext,
  makeDummyTool,
} from "./helpers.js";

const stubTurnResult: TurnResult = {
  turnId: "turn-1",
  agentName: "test-agent",
  conversationId: "conv-1",
  status: "completed",
  steps: [],
};

describe("RequiredToolsGuard", () => {
  it("creates an Extension with name 'required-tools-guard'", () => {
    const ext = RequiredToolsGuard({ tools: ["my_tool"] });
    expect(ext.name).toBe(REQUIRED_TOOLS_GUARD);
    expect(REQUIRED_TOOLS_GUARD).toBe("required-tools-guard");
  });

  it("registers a turn middleware in the 'guard' phase", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = RequiredToolsGuard({ tools: ["my_tool"] });
    ext.register(api);

    expect(api.pipeline.register).toHaveBeenCalledOnce();
    expect(registeredMiddleware[0].level).toBe("turn");
    expect(registeredMiddleware[0].options?.phase).toBe("guard");
  });

  it("calls next() when all required tools are present", async () => {
    const conversation = makeMockConversationState();
    const tools = [makeDummyTool("tool_a"), makeDummyTool("tool_b")];
    const { api, registeredMiddleware } = makeMockApi(conversation, tools);

    const ext = RequiredToolsGuard({ tools: ["tool_a", "tool_b"] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe(stubTurnResult);
  });

  it("throws error when required tools are missing", async () => {
    const conversation = makeMockConversationState();
    const tools = [makeDummyTool("tool_a")];
    const { api, registeredMiddleware } = makeMockApi(conversation, tools);

    const ext = RequiredToolsGuard({ tools: ["tool_a", "tool_b"] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await expect(middleware(ctx, next)).rejects.toThrow("tool_b");
    expect(next).not.toHaveBeenCalled();
  });

  it("throws when no tools are registered at all", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation, []);

    const ext = RequiredToolsGuard({ tools: ["required_tool"] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await expect(middleware(ctx, next)).rejects.toThrow("required_tool");
  });

  it("passes when no tools are required", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation, []);

    const ext = RequiredToolsGuard({ tools: [] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await expect(middleware(ctx, next)).resolves.toBe(stubTurnResult);
    expect(next).toHaveBeenCalledOnce();
  });

  it("error message lists all missing tools", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation, []);

    const ext = RequiredToolsGuard({ tools: ["tool_x", "tool_y", "tool_z"] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler as TurnMiddleware;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await expect(middleware(ctx, next)).rejects.toThrow(/tool_x.*tool_y.*tool_z/);
  });
});

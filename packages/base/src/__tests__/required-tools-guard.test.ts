import { describe, it, expect, vi } from "vitest";
import {
  RequiredToolsGuard,
  REQUIRED_TOOLS_GUARD,
} from "../extensions/required-tools-guard.js";
import type { TurnMiddleware } from "@goondan/openharness-types";
import {
  makeDummyTool,
  makeMockApi,
  makeMockConversationState,
  makeTurnContext,
} from "./_mock-api.js";

const stubTurnResult = {
  turnId: "turn-1",
  agentName: "test-agent",
  conversationId: "conv-1",
  status: "completed" as const,
  steps: [],
};

function registerGuard(
  conversation: ReturnType<typeof makeMockConversationState>,
  config: { tools: string[] },
  availableTools = [] as ReturnType<typeof makeDummyTool>[],
): TurnMiddleware {
  const { api, registered } = makeMockApi(conversation, availableTools);
  RequiredToolsGuard(config).register(api);
  expect(registered).toHaveLength(1);
  expect(registered[0].kind).toBe("turn");
  return registered[0].handler as TurnMiddleware;
}

describe("RequiredToolsGuard", () => {
  it("exports the marker constant matching the extension name", () => {
    expect(REQUIRED_TOOLS_GUARD).toBe("required-tools-guard");
    expect(RequiredToolsGuard({ tools: [] }).name).toBe(REQUIRED_TOOLS_GUARD);
  });

  it("registers turn middleware with { after: '*' } (innermost band)", () => {
    const conversation = makeMockConversationState();
    const { api, registered } = makeMockApi(conversation);

    RequiredToolsGuard({ tools: ["my_tool"] }).register(api);

    expect(api.useTurn).toHaveBeenCalledOnce();
    expect(registered[0].kind).toBe("turn");
    expect(registered[0].options).toEqual({ after: "*" });
  });

  it("calls next() when all required tools are present", async () => {
    const conversation = makeMockConversationState();
    const mw = registerGuard(conversation, { tools: ["tool_a", "tool_b"] }, [
      makeDummyTool("tool_a"),
      makeDummyTool("tool_b"),
    ]);

    const next = vi.fn(async () => stubTurnResult);
    const result = await mw(makeTurnContext(conversation), next);

    expect(next).toHaveBeenCalledOnce();
    expect(result).toBe(stubTurnResult);
  });

  it("throws when a required tool is missing", async () => {
    const conversation = makeMockConversationState();
    const mw = registerGuard(conversation, { tools: ["tool_a", "tool_b"] }, [
      makeDummyTool("tool_a"),
    ]);

    const next = vi.fn(async () => stubTurnResult);
    await expect(mw(makeTurnContext(conversation), next)).rejects.toThrow(
      "tool_b",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("throws when no tools are registered at all", async () => {
    const conversation = makeMockConversationState();
    const mw = registerGuard(conversation, { tools: ["required_tool"] });

    await expect(
      mw(makeTurnContext(conversation), vi.fn(async () => stubTurnResult)),
    ).rejects.toThrow("required_tool");
  });

  it("passes when no tools are required", async () => {
    const conversation = makeMockConversationState();
    const mw = registerGuard(conversation, { tools: [] });

    const next = vi.fn(async () => stubTurnResult);
    await expect(mw(makeTurnContext(conversation), next)).resolves.toBe(
      stubTurnResult,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("lists all missing tools in the error message", async () => {
    const conversation = makeMockConversationState();
    const mw = registerGuard(conversation, {
      tools: ["tool_x", "tool_y", "tool_z"],
    });

    await expect(
      mw(makeTurnContext(conversation), vi.fn(async () => stubTurnResult)),
    ).rejects.toThrow(/tool_x.*tool_y.*tool_z/);
  });
});

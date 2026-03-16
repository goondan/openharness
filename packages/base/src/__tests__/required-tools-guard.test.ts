import { describe, it, expect, vi } from "vitest";
import { RequiredToolsGuard } from "../extensions/required-tools-guard.js";
import type {
  ExtensionApi,
  TurnMiddleware,
  TurnContext,
  TurnResult,
  ConversationState,
  ToolDefinition,
} from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockConversationState(): ConversationState {
  return {
    messages: [],
    events: [],
    emit: vi.fn(),
    restore: vi.fn(),
  };
}

function makeMockApi(
  conversation: ConversationState,
  availableTools: ToolDefinition[] = [],
): {
  api: ExtensionApi;
  registeredMiddleware: Array<{
    level: string;
    handler: TurnMiddleware;
    options?: { priority?: number };
  }>;
} {
  const registeredMiddleware: Array<{
    level: string;
    handler: TurnMiddleware;
    options?: { priority?: number };
  }> = [];

  const api: ExtensionApi = {
    pipeline: {
      register: vi.fn(
        (level: string, handler: TurnMiddleware, options?: { priority?: number }) => {
          registeredMiddleware.push({ level, handler, options });
        },
      ) as unknown as ExtensionApi["pipeline"]["register"],
    },
    tools: {
      register: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => availableTools as readonly ToolDefinition[]),
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

function makeDummyTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {} },
    handler: async () => ({ type: "text", text: "ok" }),
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

describe("RequiredToolsGuard", () => {
  it("creates an Extension with name 'required-tools-guard'", () => {
    const ext = RequiredToolsGuard({ tools: ["my_tool"] });
    expect(ext.name).toBe("required-tools-guard");
  });

  it("registers turn middleware via api.pipeline.register", () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation);

    const ext = RequiredToolsGuard({ tools: ["my_tool"] });
    ext.register(api);

    expect(api.pipeline.register).toHaveBeenCalledOnce();
    expect(registeredMiddleware[0].level).toBe("turn");
  });

  it("calls next() when all required tools are present", async () => {
    const conversation = makeMockConversationState();
    const tools = [makeDummyTool("tool_a"), makeDummyTool("tool_b")];
    const { api, registeredMiddleware } = makeMockApi(conversation, tools);

    const ext = RequiredToolsGuard({ tools: ["tool_a", "tool_b"] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
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

    const middleware = registeredMiddleware[0].handler;
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

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await expect(middleware(ctx, next)).rejects.toThrow("required_tool");
  });

  it("passes when no tools are required", async () => {
    const conversation = makeMockConversationState();
    const { api, registeredMiddleware } = makeMockApi(conversation, []);

    const ext = RequiredToolsGuard({ tools: [] });
    ext.register(api);

    const middleware = registeredMiddleware[0].handler;
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

    const middleware = registeredMiddleware[0].handler;
    const ctx = makeTurnContext(conversation);
    const next = vi.fn(async () => stubTurnResult);

    await expect(middleware(ctx, next)).rejects.toThrow(/tool_x.*tool_y.*tool_z/);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerExtensions, createExtensionApi } from "../extension-registry.js";
import { EventBus } from "../event-bus.js";
import { MiddlewareRegistry } from "../middleware-chain.js";
import { ModelInputRegistry } from "../model-input.js";
import { createConversationState } from "../conversation-state.js";
import type {
  AgentExtension,
  AgentExtensionApi,
  RuntimeInfo,
  ToolDefinition,
} from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Minimal mock ToolRegistry
// ---------------------------------------------------------------------------
function makeMockToolRegistry() {
  const tools: ToolDefinition[] = [];
  return {
    register: vi.fn((tool: ToolDefinition) => tools.push(tool)),
    remove: vi.fn((name: string) => {
      const idx = tools.findIndex((t) => t.name === name);
      if (idx !== -1) tools.splice(idx, 1);
    }),
    list: vi.fn((): readonly ToolDefinition[] => [...tools]),
  };
}

// ---------------------------------------------------------------------------
// Minimal RuntimeInfo fixture
// ---------------------------------------------------------------------------
const baseRuntimeInfo: RuntimeInfo = {
  agent: {
    name: "test-agent",
    model: { provider: "openai", model: "gpt-4o" },
    extensions: [],
    tools: [],
    maxSteps: 5,
  },
  agents: {},
  connections: {},
};

// ---------------------------------------------------------------------------
// Helper: build default agent-scoped deps
// ---------------------------------------------------------------------------
function makeDeps() {
  return {
    scope: "agent" as const,
    toolRegistry: makeMockToolRegistry(),
    eventBus: new EventBus(),
    middlewareRegistry: new MiddlewareRegistry(["turn", "step", "toolCall"]),
    modelInputRegistry: new ModelInputRegistry(),
    runtimeInfo: baseRuntimeInfo,
    conversationState: createConversationState(),
  };
}

// `createExtensionApi` is typed as the agent/connection union; in these tests the
// scope is always "agent", so narrow once at the call boundary.
function agentApi(deps: ReturnType<typeof makeDeps>, name: string): AgentExtensionApi {
  return createExtensionApi(deps, name) as AgentExtensionApi;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("registerExtensions + createExtensionApi", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  // Test 1: Register extension → extension.register(api) called with AgentExtensionApi
  it("calls extension.register(api) with a valid AgentExtensionApi object", () => {
    const registerFn = vi.fn();
    const ext: AgentExtension = { name: "my-ext", register: registerFn };

    registerExtensions([ext], deps);

    expect(registerFn).toHaveBeenCalledOnce();
    const api: AgentExtensionApi = registerFn.mock.calls[0][0];
    expect(api).toBeDefined();
    expect(typeof api.useTurn).toBe("function");
    expect(typeof api.useStep).toBe("function");
    expect(typeof api.useToolCall).toBe("function");
    expect(typeof api.useModelInput).toBe("function");
    expect(typeof api.tools.register).toBe("function");
    expect(typeof api.tools.remove).toBe("function");
    expect(typeof api.tools.list).toBe("function");
    expect(typeof api.on).toBe("function");
    expect(api.conversation).toBeDefined();
    expect(api.runtime).toBeDefined();
  });

  // Test 2: Duplicate extension name → throws
  it("throws when two extensions share the same name", () => {
    const ext1: AgentExtension = { name: "dup", register: vi.fn() };
    const ext2: AgentExtension = { name: "dup", register: vi.fn() };

    expect(() => registerExtensions([ext1, ext2], deps)).toThrow();

    // Neither extension's register should have been called (validation before registration)
    expect(ext1.register).not.toHaveBeenCalled();
    expect(ext2.register).not.toHaveBeenCalled();
  });

  // Test 3: Extension.register exception → registration fails, no partial state
  it("rolls back all registrations when one extension.register() throws", () => {
    const registered: string[] = [];

    const ext1: AgentExtension = {
      name: "ext1",
      register: (api) => {
        // Register a middleware so we can check if it gets rolled back
        api.useTurn(async (_ctx, next) => next());
        registered.push("ext1");
      },
    };

    const ext2: AgentExtension = {
      name: "ext2",
      register: (_api) => {
        registered.push("ext2");
        throw new Error("ext2 registration failed");
      },
    };

    const ext3: AgentExtension = {
      name: "ext3",
      register: vi.fn(),
    };

    const middlewareSpy = vi.spyOn(deps.middlewareRegistry, "register");

    expect(() => registerExtensions([ext1, ext2, ext3], deps)).toThrow(
      "ext2 registration failed"
    );

    // ext3.register must not have been called
    expect(ext3.register).not.toHaveBeenCalled();

    // Verify execution order up to the failure point
    expect(registered).toEqual(["ext1", "ext2"]);

    // No partial state: the real middlewareRegistry and toolRegistry must have
    // received NO calls — all operations were buffered in the recording layer
    // and discarded when ext2 threw.
    expect(middlewareSpy).not.toHaveBeenCalled();
    expect(deps.toolRegistry.register).not.toHaveBeenCalled();
  });

  // Test 3b: ext1 registers a tool, ext2 throws → tool from ext1 not in deps.toolRegistry
  it("discards tool registrations from earlier extensions when a later one throws", () => {
    const toolA: ToolDefinition = {
      name: "tool-a",
      description: "tool from ext1",
      parameters: {},
      handler: async () => ({ type: "text", text: "a" }),
    };

    const ext1: AgentExtension = {
      name: "ext1-tool",
      register: (api) => {
        api.tools.register(toolA);
      },
    };

    const ext2: AgentExtension = {
      name: "ext2-throw",
      register: () => {
        throw new Error("ext2 boom");
      },
    };

    expect(() => registerExtensions([ext1, ext2], deps)).toThrow("ext2 boom");

    // The real toolRegistry must have received NO calls — ext1's tool was
    // buffered in the recording layer and discarded when ext2 threw.
    expect(deps.toolRegistry.register).not.toHaveBeenCalled();
    expect(deps.toolRegistry.list()).toHaveLength(0);
  });

  // Test 4: useStep/useToolCall add middleware to the correct level
  it("useStep/useToolCall delegate to middlewareRegistry with the correct level", async () => {
    const spy = vi.spyOn(deps.middlewareRegistry, "register");

    const ext: AgentExtension = {
      name: "pipeline-ext",
      register: (api) => {
        api.useStep(async (_ctx, next) => next());
        api.useToolCall(async (_ctx, next) => next(), { after: "*" });
      },
    };

    registerExtensions([ext], deps);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe("step");
    expect(spy.mock.calls[1][0]).toBe("toolCall");
    // Options are forwarded
    expect(spy.mock.calls[1][2]).toEqual({ after: "*" });
  });

  // Test 5: ExtensionApi.tools delegates to ToolRegistry
  it("api.tools.register/remove/list delegate to toolRegistry", () => {
    const ext: AgentExtension = {
      name: "tools-ext",
      register: (api) => {
        const tool: ToolDefinition = {
          name: "my-tool",
          description: "does stuff",
          parameters: {},
          handler: async () => ({ type: "text", text: "ok" }),
        };
        api.tools.register(tool);
        api.tools.list();
        api.tools.remove("my-tool");
      },
    };

    registerExtensions([ext], deps);

    expect(deps.toolRegistry.register).toHaveBeenCalledOnce();
    expect(deps.toolRegistry.list).toHaveBeenCalled();
    expect(deps.toolRegistry.remove).toHaveBeenCalledWith("my-tool");
  });

  // Test 5b: useModelInput delegates to modelInputRegistry
  it("api.useModelInput delegates to modelInputRegistry", () => {
    const spy = vi.spyOn(deps.modelInputRegistry, "register");

    const ext: AgentExtension = {
      name: "model-input-ext",
      register: (api) => {
        api.useModelInput((messages) => messages);
      },
    };

    registerExtensions([ext], deps);

    expect(spy).toHaveBeenCalledOnce();
  });

  // Test 6: ExtensionApi.on delegates to EventBus
  it("api.on delegates to eventBus.on", () => {
    const spy = vi.spyOn(deps.eventBus, "on");

    const listener = vi.fn();
    const ext: AgentExtension = {
      name: "event-ext",
      register: (api) => {
        api.on("turn.start", listener);
      },
    };

    registerExtensions([ext], deps);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe("turn.start");
  });

  // Test 7: ExtensionApi.runtime returns correct agent info
  it("api.runtime returns the runtimeInfo passed in deps", () => {
    let capturedRuntime: RuntimeInfo | undefined;

    const ext: AgentExtension = {
      name: "runtime-ext",
      register: (api) => {
        capturedRuntime = api.runtime;
      },
    };

    registerExtensions([ext], deps);

    expect(capturedRuntime).toBeDefined();
    expect(capturedRuntime!.agent.name).toBe("test-agent");
    expect(capturedRuntime!.agent.model.provider).toBe("openai");
    expect(capturedRuntime!.agent.maxSteps).toBe(5);
  });

  // Test 7b: runtime is a readonly snapshot (mutations to original don't leak in)
  it("api.runtime is a readonly snapshot — external mutation does not affect the snapshot", () => {
    let capturedRuntime: RuntimeInfo | undefined;

    const ext: AgentExtension = {
      name: "snapshot-ext",
      register: (api) => {
        capturedRuntime = api.runtime;
      },
    };

    registerExtensions([ext], deps);

    const originalName = capturedRuntime!.agent.name;
    // Attempting to mutate the snapshot should either throw (strict) or be ignored
    try {
      (capturedRuntime!.agent as { name: string }).name = "mutated";
    } catch {
      // frozen object — that's fine
    }
    // The captured snapshot stays stable
    expect(capturedRuntime!.agent.name).toBe(originalName);
  });

  // Test 8: Declaration order preserved across multiple extensions
  it("calls extension.register() in declaration order", () => {
    const order: string[] = [];

    const extA: AgentExtension = {
      name: "alpha",
      register: () => order.push("alpha"),
    };
    const extB: AgentExtension = {
      name: "beta",
      register: () => order.push("beta"),
    };
    const extC: AgentExtension = {
      name: "gamma",
      register: () => order.push("gamma"),
    };

    registerExtensions([extA, extB, extC], deps);

    expect(order).toEqual(["alpha", "beta", "gamma"]);
  });

  // Extra: conversation property is the same reference as conversationState
  it("api.conversation is the conversationState reference from deps", () => {
    let capturedConversation: AgentExtensionApi["conversation"] | undefined;

    const ext: AgentExtension = {
      name: "conv-ext",
      register: (api) => {
        capturedConversation = api.conversation;
      },
    };

    registerExtensions([ext], deps);

    expect(capturedConversation).toBe(deps.conversationState);
  });
});

describe("createExtensionApi", () => {
  it("returns a well-formed AgentExtensionApi without calling register", () => {
    const deps = makeDeps();
    const api = agentApi(deps, "standalone");

    expect(typeof api.useTurn).toBe("function");
    expect(typeof api.tools.register).toBe("function");
    expect(typeof api.on).toBe("function");
    expect(api.conversation).toBe(deps.conversationState);
    expect(api.runtime).toMatchObject({ agent: { name: "test-agent" } });
  });
});

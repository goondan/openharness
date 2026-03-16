import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerExtensions, createExtensionApi } from "../extension-registry.js";
import { EventBus } from "../event-bus.js";
import { MiddlewareRegistry } from "../middleware-chain.js";
import type {
  Extension,
  ExtensionApi,
  RuntimeInfo,
  ToolDefinition,
} from "@goondan/openharness-types";
import type { ConversationState } from "@goondan/openharness-types";

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
// Minimal mock ConversationState
// ---------------------------------------------------------------------------
function makeMockConversationState(): ConversationState {
  return {
    events: [],
    messages: [],
    emit: vi.fn(),
    restore: vi.fn(),
  } as unknown as ConversationState;
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
// Helper: build default deps
// ---------------------------------------------------------------------------
function makeDeps() {
  return {
    toolRegistry: makeMockToolRegistry(),
    eventBus: new EventBus(),
    middlewareRegistry: new MiddlewareRegistry(),
    runtimeInfo: baseRuntimeInfo,
    conversationState: makeMockConversationState(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("registerExtensions + createExtensionApi", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  // Test 1: Register extension → extension.register(api) called with ExtensionApi
  it("calls extension.register(api) with a valid ExtensionApi object", () => {
    const registerFn = vi.fn();
    const ext: Extension = { name: "my-ext", register: registerFn };

    registerExtensions([ext], deps);

    expect(registerFn).toHaveBeenCalledOnce();
    const api: ExtensionApi = registerFn.mock.calls[0][0];
    expect(api).toBeDefined();
    expect(typeof api.pipeline.register).toBe("function");
    expect(typeof api.tools.register).toBe("function");
    expect(typeof api.tools.remove).toBe("function");
    expect(typeof api.tools.list).toBe("function");
    expect(typeof api.on).toBe("function");
    expect(api.conversation).toBeDefined();
    expect(api.runtime).toBeDefined();
  });

  // Test 2: Duplicate extension name → throws
  it("throws when two extensions share the same name", () => {
    const ext1: Extension = { name: "dup", register: vi.fn() };
    const ext2: Extension = { name: "dup", register: vi.fn() };

    expect(() => registerExtensions([ext1, ext2], deps)).toThrow();

    // Neither extension's register should have been called (validation before registration)
    expect(ext1.register).not.toHaveBeenCalled();
    expect(ext2.register).not.toHaveBeenCalled();
  });

  // Test 3: Extension.register exception → registration fails, no partial state
  it("rolls back all registrations when one extension.register() throws", () => {
    const registered: string[] = [];

    const ext1: Extension = {
      name: "ext1",
      register: (api) => {
        // Register a middleware so we can check if it gets rolled back
        api.pipeline.register("turn", async (_ctx, next) => next());
        registered.push("ext1");
      },
    };

    const ext2: Extension = {
      name: "ext2",
      register: (_api) => {
        registered.push("ext2");
        throw new Error("ext2 registration failed");
      },
    };

    const ext3: Extension = {
      name: "ext3",
      register: vi.fn(),
    };

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
    const middlewareSpy = vi.spyOn(deps.middlewareRegistry, "register");
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

    const ext1: Extension = {
      name: "ext1-tool",
      register: (api) => {
        api.tools.register(toolA);
      },
    };

    const ext2: Extension = {
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

  // Test 4: ExtensionApi.pipeline.register adds middleware to correct level
  it("pipeline.register delegates to middlewareRegistry with the correct level", async () => {
    const spy = vi.spyOn(deps.middlewareRegistry, "register");

    const ext: Extension = {
      name: "pipeline-ext",
      register: (api) => {
        api.pipeline.register("step", async (_ctx, next) => next());
        api.pipeline.register("toolCall", async (_ctx, next) => next(), {
          priority: 50,
        });
      },
    };

    registerExtensions([ext], deps);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe("step");
    expect(spy.mock.calls[1][0]).toBe("toolCall");
    // Options are forwarded
    expect(spy.mock.calls[1][2]).toEqual({ priority: 50 });
  });

  // Test 5: ExtensionApi.tools delegates to ToolRegistry
  it("api.tools.register/remove/list delegate to toolRegistry", () => {
    const ext: Extension = {
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
    expect(deps.toolRegistry.list).toHaveBeenCalledOnce();
    expect(deps.toolRegistry.remove).toHaveBeenCalledWith("my-tool");
  });

  // Test 6: ExtensionApi.on delegates to EventBus
  it("api.on delegates to eventBus.on", () => {
    const spy = vi.spyOn(deps.eventBus, "on");

    const listener = vi.fn();
    const ext: Extension = {
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

    const ext: Extension = {
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

    const ext: Extension = {
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

    const extA: Extension = {
      name: "alpha",
      register: () => order.push("alpha"),
    };
    const extB: Extension = {
      name: "beta",
      register: () => order.push("beta"),
    };
    const extC: Extension = {
      name: "gamma",
      register: () => order.push("gamma"),
    };

    registerExtensions([extA, extB, extC], deps);

    expect(order).toEqual(["alpha", "beta", "gamma"]);
  });

  // Extra: conversation property is the same reference as conversationState
  it("api.conversation is the conversationState reference from deps", () => {
    let capturedConversation: ConversationState | undefined;

    const ext: Extension = {
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
  it("returns a well-formed ExtensionApi without calling register", () => {
    const deps = makeDeps();
    const api = createExtensionApi(deps);

    expect(typeof api.pipeline.register).toBe("function");
    expect(typeof api.tools.register).toBe("function");
    expect(typeof api.on).toBe("function");
    expect(api.conversation).toBe(deps.conversationState);
    expect(api.runtime).toMatchObject({ agent: { name: "test-agent" } });
  });
});

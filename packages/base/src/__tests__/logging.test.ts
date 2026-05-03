import { describe, it, expect, vi } from "vitest";
import { Logging } from "../extensions/logging.js";
import type { ExtensionApi, ConversationState } from "@goondan/openharness-types";

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

function makeMockApi(conversation: ConversationState): {
  api: ExtensionApi;
  eventListeners: Map<string, Array<(payload: unknown) => void>>;
} {
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();

  const api: ExtensionApi = {
    pipeline: {
      register: vi.fn() as unknown as ExtensionApi["pipeline"]["register"],
    },
    tools: {
      register: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => []),
    },
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(listener);
    }),
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

  return { api, eventListeners };
}

function emit(
  eventListeners: Map<string, Array<(payload: unknown) => void>>,
  event: string,
  payload: unknown,
) {
  eventListeners.get(event)?.forEach((l) => {
    l(payload);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Logging", () => {
  it("creates an Extension with name 'logging'", () => {
    const ext = Logging();
    expect(ext.name).toBe("logging");
  });

  it("subscribes to all core events on register", () => {
    const conversation = makeMockConversationState();
    const { api } = makeMockApi(conversation);

    const ext = Logging();
    ext.register(api);

    expect(api.on).toHaveBeenCalledWith("turn.start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("turn.done", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("turn.error", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("step.start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("step.done", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("tool.start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("tool.done", expect.any(Function));
  });

  it("logs turn.start event with custom logger", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const logger = vi.fn();

    const ext = Logging({ logger });
    ext.register(api);

    emit(eventListeners, "turn.start", { turnId: "t1" });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("turn.start");
  });

  it("logs turn.done event", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const logger = vi.fn();

    const ext = Logging({ logger });
    ext.register(api);

    emit(eventListeners, "turn.done", { turnId: "t1", status: "completed" });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("turn.done");
  });

  it("logs turn.error event", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const logger = vi.fn();

    const ext = Logging({ logger });
    ext.register(api);

    emit(eventListeners, "turn.error", { error: "oops" });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("turn.error");
  });

  it("uses console.log as default logger", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const ext = Logging();
    ext.register(api);

    emit(eventListeners, "turn.start", { turnId: "t1" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("logs step.start event with custom logger", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const logger = vi.fn();

    const ext = Logging({ logger });
    ext.register(api);

    emit(eventListeners, "step.start", { stepIndex: 0 });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("step.start");
    expect(logger.mock.calls[0][0]).toContain("stepIndex");
  });

  it("logs step.done event with custom logger", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const logger = vi.fn();

    const ext = Logging({ logger });
    ext.register(api);

    emit(eventListeners, "step.done", { stepIndex: 0, toolCallCount: 2 });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("step.done");
  });

  it("logs tool.start and tool.done events with custom logger", () => {
    const conversation = makeMockConversationState();
    const { api, eventListeners } = makeMockApi(conversation);
    const logger = vi.fn();

    const ext = Logging({ logger });
    ext.register(api);

    emit(eventListeners, "tool.start", { toolName: "bash", toolCallId: "tc-1" });
    emit(eventListeners, "tool.done", { toolName: "bash", toolCallId: "tc-1", result: { type: "text", text: "ok" } });

    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls[0][0]).toContain("tool.start");
    expect(logger.mock.calls[0][0]).toContain("bash");
    expect(logger.mock.calls[1][0]).toContain("tool.done");
  });

  it("does NOT call pipeline.register (event-based, no middleware)", () => {
    const conversation = makeMockConversationState();
    const { api } = makeMockApi(conversation);

    const ext = Logging();
    ext.register(api);

    expect(api.pipeline.register).not.toHaveBeenCalled();
  });
});

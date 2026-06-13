import { describe, it, expect, vi } from "vitest";
import { Logging } from "../extensions/logging.js";
import { emitEvent, makeMockApi } from "./_mock-api.js";

describe("Logging", () => {
  it("creates an AgentExtension with name 'logging'", () => {
    expect(Logging().name).toBe("logging");
  });

  it("subscribes to all core events on register", () => {
    const { api } = makeMockApi();
    Logging().register(api);

    expect(api.on).toHaveBeenCalledWith("turn.start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("turn.done", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("turn.error", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("step.start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("step.done", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("tool.start", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("tool.done", expect.any(Function));
  });

  it("logs turn.start with a custom logger", () => {
    const { api, eventListeners } = makeMockApi();
    const logger = vi.fn();

    Logging({ logger }).register(api);
    emitEvent(eventListeners, "turn.start", { turnId: "t1" });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("turn.start");
  });

  it("logs turn.done", () => {
    const { api, eventListeners } = makeMockApi();
    const logger = vi.fn();

    Logging({ logger }).register(api);
    emitEvent(eventListeners, "turn.done", { turnId: "t1", status: "completed" });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("turn.done");
  });

  it("logs turn.error", () => {
    const { api, eventListeners } = makeMockApi();
    const logger = vi.fn();

    Logging({ logger }).register(api);
    emitEvent(eventListeners, "turn.error", { error: "oops" });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("turn.error");
  });

  it("uses console.log as the default logger", () => {
    const { api, eventListeners } = makeMockApi();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    Logging().register(api);
    emitEvent(eventListeners, "turn.start", { turnId: "t1" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("logs step.start with payload detail", () => {
    const { api, eventListeners } = makeMockApi();
    const logger = vi.fn();

    Logging({ logger }).register(api);
    emitEvent(eventListeners, "step.start", { stepIndex: 0 });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("step.start");
    expect(logger.mock.calls[0][0]).toContain("stepIndex");
  });

  it("logs step.done", () => {
    const { api, eventListeners } = makeMockApi();
    const logger = vi.fn();

    Logging({ logger }).register(api);
    emitEvent(eventListeners, "step.done", { stepIndex: 0, toolCallCount: 2 });

    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toContain("step.done");
  });

  it("logs tool.start and tool.done", () => {
    const { api, eventListeners } = makeMockApi();
    const logger = vi.fn();

    Logging({ logger }).register(api);
    emitEvent(eventListeners, "tool.start", {
      toolName: "bash",
      toolCallId: "tc-1",
    });
    emitEvent(eventListeners, "tool.done", {
      toolName: "bash",
      toolCallId: "tc-1",
      result: { type: "text", text: "ok" },
    });

    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls[0][0]).toContain("tool.start");
    expect(logger.mock.calls[0][0]).toContain("bash");
    expect(logger.mock.calls[1][0]).toContain("tool.done");
  });

  it("registers no middleware (event-based only)", () => {
    const { api, registered } = makeMockApi();
    Logging().register(api);

    expect(registered).toHaveLength(0);
    expect(api.useTurn).not.toHaveBeenCalled();
    expect(api.useStep).not.toHaveBeenCalled();
  });
});

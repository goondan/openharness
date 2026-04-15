import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../event-bus.js";
import type { EventPayload } from "@goondan/openharness-types";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // Test 1: Listener receives emitted event with correct payload
  it("listener receives emitted event with correct payload", () => {
    const received: EventPayload[] = [];
    bus.on("turn.start", (payload) => {
      received.push(payload);
    });

    const event: EventPayload = {
      type: "turn.start",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
    };
    bus.emit("turn.start", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  // Test 2: Multiple listeners all receive the same event
  it("multiple listeners all receive the same event", () => {
    const calls: number[] = [];
    bus.on("turn.done", () => calls.push(1));
    bus.on("turn.done", () => calls.push(2));
    bus.on("turn.done", () => calls.push(3));

    bus.emit("turn.done", {
      type: "turn.done",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
      result: {
        turnId: "t1",
        agentName: "agent",
        conversationId: "c1",
        status: "completed",
        steps: [],
      },
    });

    expect(calls).toEqual([1, 2, 3]);
  });

  // Test 3: Listener that throws does NOT affect other listeners
  it("listener that throws does not affect other listeners", () => {
    const calls: number[] = [];
    bus.on("step.start", () => { throw new Error("listener error"); });
    bus.on("step.start", () => calls.push(2));
    bus.on("step.start", () => calls.push(3));

    bus.emit("step.start", {
      type: "step.start",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
      stepNumber: 1,
    });

    expect(calls).toEqual([2, 3]);
  });

  // Test 4: Listener that throws does NOT affect the emitter (fire-and-forget)
  it("listener that throws does not affect the emitter", () => {
    bus.on("tool.start", () => { throw new Error("boom"); });

    // emit must not throw
    expect(() => {
      bus.emit("tool.start", {
        type: "tool.start",
        turnId: "t1",
        agentName: "agent",
        conversationId: "c1",
        stepNumber: 1,
        toolCallId: "tc1",
        toolName: "my_tool",
        args: {},
      });
    }).not.toThrow();
  });

  // Test 4b: Listener errors are console.warn'd, not silently swallowed
  it("listener errors are reported via console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error("listener exploded");
    bus.on("ingress.received", () => { throw err; });

    bus.emit("ingress.received", {
      type: "ingress.received",
      connectionName: "http",
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  // Test 5: Unsubscribe removes listener
  it("unsubscribe removes the listener", () => {
    const calls: number[] = [];
    const unsub = bus.on("turn.error", () => calls.push(1));

    const event: EventPayload = {
      type: "turn.error",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
      status: "error",
      error: new Error("oops"),
    };

    bus.emit("turn.error", event);
    expect(calls).toHaveLength(1);

    unsub();
    bus.emit("turn.error", event);
    expect(calls).toHaveLength(1); // still 1, listener was removed
  });

  // Test 5b: Unsubscribe only removes the specific listener, not others
  it("unsubscribe only removes the specific listener", () => {
    const callsA: number[] = [];
    const callsB: number[] = [];
    const unsubA = bus.on("step.done", () => callsA.push(1));
    bus.on("step.done", () => callsB.push(1));

    const event: EventPayload = {
      type: "step.done",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
      stepNumber: 1,
      result: { toolCalls: [] },
    };

    unsubA();
    bus.emit("step.done", event);

    expect(callsA).toHaveLength(0);
    expect(callsB).toHaveLength(1);
  });

  // Test 6: emit returns void (fire-and-forget, no awaiting)
  it("emit returns void", () => {
    const result = bus.emit("turn.start", {
      type: "turn.start",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
    });

    expect(result).toBeUndefined();
  });

  // Test 7: listeners for different event types do not cross-fire
  it("listeners for different event types do not cross-fire", () => {
    const turnCalls: EventPayload[] = [];
    const stepCalls: EventPayload[] = [];

    bus.on("turn.start", (p) => turnCalls.push(p));
    bus.on("step.start", (p) => stepCalls.push(p));

    bus.emit("turn.start", {
      type: "turn.start",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
    });

    expect(turnCalls).toHaveLength(1);
    expect(stepCalls).toHaveLength(0);
  });

  it("tap receives every emitted event regardless of type", () => {
    const received: EventPayload[] = [];

    bus.tap((payload) => {
      received.push(payload);
    });

    bus.emit("turn.start", {
      type: "turn.start",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
    });
    bus.emit("step.start", {
      type: "step.start",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
      stepNumber: 1,
    });

    expect(received.map((payload) => payload.type)).toEqual(["turn.start", "step.start"]);
  });
});

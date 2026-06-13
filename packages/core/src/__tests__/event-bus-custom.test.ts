import { describe, it, expect, vi, afterEach } from "vitest";
import { EventBus } from "../event-bus.js";

// F5: an extension declares its own typed events by augmenting CustomHarnessEvents.
// Once declared, `emit`/`on`/`tap` carry the payload type through to the listener,
// and the bus routes the custom name exactly like a core event.
declare module "@goondan/openharness-types" {
  interface CustomHarnessEvents {
    "myext.cacheWarmed": { type: "myext.cacheWarmed"; keys: number };
  }
}

describe("EventBus — custom events (F5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a declared custom event to its typed listener", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on("myext.cacheWarmed", (p) => {
      // p is typed as { type: "myext.cacheWarmed"; keys: number }.
      seen.push(p.keys);
    });
    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 7 });
    expect(seen).toEqual([7]);
  });

  it("delivers core and custom events through the same bus", () => {
    const bus = new EventBus();
    const names: string[] = [];
    bus.on("step.start", (p) => names.push(p.type));
    bus.on("myext.cacheWarmed", (p) => names.push(p.type));

    bus.emit("step.start", {
      type: "step.start",
      turnId: "t",
      agentName: "a",
      conversationId: "c",
      stepNumber: 1,
    });
    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 1 });
    expect(names).toEqual(["step.start", "myext.cacheWarmed"]);
  });

  it("tap receives every payload regardless of name, including custom ones", () => {
    const bus = new EventBus();
    const tapped: string[] = [];
    bus.tap((p) => tapped.push(p.type));

    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 2 });
    bus.emit("step.error", {
      type: "step.error",
      turnId: "t",
      agentName: "a",
      conversationId: "c",
      stepNumber: 1,
      error: new Error("x"),
    });
    expect(tapped).toEqual(["myext.cacheWarmed", "step.error"]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on("myext.cacheWarmed", (p) => seen.push(p.keys));
    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 1 });
    off();
    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 2 });
    expect(seen).toEqual([1]);
  });

  it("removes a tap listener after unsubscribe", () => {
    const bus = new EventBus();
    const tapped: number[] = [];
    const off = bus.tap((p) => {
      if (p.type === "myext.cacheWarmed") tapped.push(p.keys);
    });
    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 1 });
    off();
    bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 2 });
    expect(tapped).toEqual([1]);
  });

  it("catches a throwing listener and warns instead of breaking emit", () => {
    const bus = new EventBus();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const after: number[] = [];

    bus.on("myext.cacheWarmed", () => {
      throw new Error("listener boom");
    });
    bus.on("myext.cacheWarmed", (p) => after.push(p.keys));

    expect(() =>
      bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 9 }),
    ).not.toThrow();
    // The second listener still ran despite the first throwing.
    expect(after).toEqual([9]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/myext\.cacheWarmed/);
  });

  it("catches a throwing tap listener and warns", () => {
    const bus = new EventBus();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    bus.tap(() => {
      throw new Error("tap boom");
    });
    expect(() =>
      bus.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 1 }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

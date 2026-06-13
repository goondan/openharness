import { describe, it, expect } from "vitest";
import {
  PromptProjectionRegistry,
  planProjectionOrder,
  validateView,
} from "../prompt-projection.js";
import { PromptProjectionError } from "../errors.js";
import type { Message, PromptView, StepContext } from "@goondan/openharness-types";

const CTX = {} as StepContext;

function user(id: string, text = "hi"): Message {
  return { id, data: { role: "user", content: text } };
}
function system(id: string, text = "sys"): Message {
  return { id, data: { role: "system", content: text } };
}
function assistantCall(id: string, toolCallId: string): Message {
  return {
    id,
    data: {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName: "t", input: {} },
      ],
    } as Message["data"],
  };
}
function toolResult(id: string, toolCallId: string): Message {
  return {
    id,
    data: {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId, toolName: "t", output: { type: "text", value: "ok" } },
      ],
    } as Message["data"],
  };
}

describe("PromptProjectionRegistry.apply", () => {
  it("returns a frozen copy of the input when no projections are registered", async () => {
    const reg = new PromptProjectionRegistry();
    expect(reg.isEmpty).toBe(true);
    const input = [system("s"), user("u")];
    const out = await reg.apply(input, CTX);
    expect(Object.isFrozen(out)).toBe(true);
    expect(out).toEqual(input);
    expect(out).not.toBe(input); // a copy, not the same array
  });

  it("runs an async projection and reflects its output in the frozen view", async () => {
    const reg = new PromptProjectionRegistry();
    reg.transform("drop-first-user", async (view) =>
      view.filter((m) => m.data.role !== "user"),
    );
    const out = await reg.apply([system("s"), user("u")], CTX);
    expect(out.map((m) => m.id)).toEqual(["s"]);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("runs projections in before/after pipeline order (A before B ⇒ A earlier)", async () => {
    const reg = new PromptProjectionRegistry();
    const ran: string[] = [];
    reg.transform(
      "b",
      async (view) => {
        ran.push("b");
        return view;
      },
      { after: "a" },
    );
    reg.transform("a", async (view) => {
      ran.push("a");
      return view;
    });
    await reg.apply([user("u")], CTX);
    expect(ran).toEqual(["a", "b"]);
  });

  it("wraps a throwing projection in PromptProjectionError preserving the cause", async () => {
    const reg = new PromptProjectionRegistry();
    const boom = new Error("hydration failed");
    reg.transform("explode", async () => {
      throw boom;
    });
    await expect(reg.apply([user("u")], CTX)).rejects.toMatchObject({
      name: "PromptProjectionError",
      cause: boom,
    });
  });

  it("validates each stage's output, not just the final view", async () => {
    const reg = new PromptProjectionRegistry();
    // This stage introduces a duplicate id — must be caught immediately.
    reg.transform("dup", async (view) => [...view, view[0]]);
    await expect(reg.apply([user("u")], CTX)).rejects.toThrow(
      /duplicate message id/,
    );
  });
});

describe("validateView invariants", () => {
  it("accepts a well-formed view with a leading system message and a whole tool pair", () => {
    const view: PromptView = [
      system("s"),
      user("u"),
      assistantCall("a", "call-1"),
      toolResult("r", "call-1"),
    ];
    expect(() => validateView(view, "input")).not.toThrow();
  });

  it("rejects a duplicate message id", () => {
    expect(() => validateView([user("u"), user("u")], "input")).toThrow(
      /duplicate message id/,
    );
  });

  it("rejects a system message after a non-system message", () => {
    expect(() =>
      validateView([user("u"), system("s")], "input"),
    ).toThrow(/System messages must lead/);
  });

  it("rejects an orphan tool result with no matching call", () => {
    expect(() =>
      validateView([user("u"), toolResult("r", "call-x")], "input"),
    ).toThrow(/orphan tool result/);
  });

  it("rejects an unanswered tool-call (severed pair)", () => {
    expect(() =>
      validateView([assistantCall("a", "call-1")], "input"),
    ).toThrow(/unanswered tool-call/);
  });

  it("rejects a tool result that precedes its call", () => {
    expect(() =>
      validateView(
        [toolResult("r", "call-1"), assistantCall("a", "call-1")],
        "input",
      ),
    ).toThrow(/orphan tool result|before its/);
  });
});

describe("planProjectionOrder (pure)", () => {
  function entry(name: string, opts: { before?: string[]; after?: string[]; order: number }) {
    return {
      name,
      projection: (async (v: PromptView) => v) as never,
      before: opts.before ?? [],
      after: opts.after ?? [],
      order: opts.order,
    };
  }

  it("returns a single entry unchanged", () => {
    const e = entry("only", { order: 0 });
    expect(planProjectionOrder([e])).toEqual([e]);
  });

  it("breaks ties by registration order", () => {
    const ordered = planProjectionOrder([
      entry("first", { order: 0 }),
      entry("second", { order: 1 }),
      entry("third", { order: 2 }),
    ]).map((e) => e.name);
    expect(ordered).toEqual(["first", "second", "third"]);
  });

  it("throws on an unknown before/after reference", () => {
    expect(() =>
      planProjectionOrder([entry("a", { before: ["ghost"], order: 0 }), entry("b", { order: 1 })]),
    ).toThrow(/unknown projection/);
  });

  it("throws on a cycle, naming the trapped projections", () => {
    expect(() =>
      planProjectionOrder([
        entry("a", { before: ["b"], order: 0 }),
        entry("b", { before: ["a"], order: 1 }),
      ]),
    ).toThrow(/cycle/);
  });
});

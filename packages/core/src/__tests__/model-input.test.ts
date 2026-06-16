import { describe, it, expect } from "vitest";
import type { Message, ModelInput, StepContext } from "@goondan/openharness-types";
import { ModelInputRegistry } from "../model-input.js";

function makeMessage(id: string, text: string): Message {
  return { id, data: { role: "user", content: text } };
}

// A minimal StepContext stand-in; the registry only forwards it to transforms.
const ctx = { stepNumber: 0 } as unknown as StepContext;

describe("ModelInputRegistry", () => {
  it("is empty until a transform is registered", () => {
    const registry = new ModelInputRegistry();
    expect(registry.isEmpty).toBe(true);
    registry.register((m) => m);
    expect(registry.isEmpty).toBe(false);
  });

  it("returns the input unchanged when no transform is registered", async () => {
    const registry = new ModelInputRegistry();
    const input = [makeMessage("1", "a"), makeMessage("2", "b")];
    const out = await registry.apply(input, ctx);
    expect(out).toBe(input);
  });

  it("applies transforms in registration order", async () => {
    const registry = new ModelInputRegistry();
    const trace: string[] = [];

    registry.register((m) => {
      trace.push("first");
      return [...m, makeMessage("first", "first")];
    });
    registry.register((m) => {
      trace.push("second");
      return [...m, makeMessage("second", "second")];
    });

    const out = await registry.apply([makeMessage("0", "base")], ctx);

    expect(trace).toEqual(["first", "second"]);
    expect(out.map((m) => m.id)).toEqual(["0", "first", "second"]);
  });

  it("awaits async transforms", async () => {
    const registry = new ModelInputRegistry();
    registry.register(async (m): Promise<ModelInput> => {
      await Promise.resolve();
      return m.slice(1);
    });

    const out = await registry.apply(
      [makeMessage("0", "a"), makeMessage("1", "b")],
      ctx,
    );

    expect(out.map((m) => m.id)).toEqual(["1"]);
  });

  it("does not mutate the input snapshot", async () => {
    const registry = new ModelInputRegistry();
    registry.register((m) => [...m, makeMessage("added", "added")]);

    const input = Object.freeze([makeMessage("0", "a")]);
    const out = await registry.apply(input, ctx);

    // The frozen input is untouched; the transform produced a fresh array.
    expect(input).toHaveLength(1);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(input);
  });
});

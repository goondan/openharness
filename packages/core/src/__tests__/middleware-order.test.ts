import { describe, it, expect } from "vitest";
import {
  MiddlewareRegistry,
  planMiddlewareOrder,
  type NormalizedPlacement,
} from "../middleware-chain.js";
import { MiddlewareOrderError, SlotWiringError } from "../errors.js";
import { createSlot } from "@goondan/openharness-types";
import type { MiddlewareOptions } from "@goondan/openharness-types";

// A handler that records its entry into `log`, runs the rest of the chain, then
// records its exit. Entry order is what before/after/phase govern.
function recorder(name: string, log: string[]) {
  return (async (_ctx: unknown, next: () => Promise<unknown>) => {
    log.push(`${name}:in`);
    const res = await next();
    log.push(`${name}:out`);
    return res;
  }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;
}

async function runLevel(
  registry: MiddlewareRegistry,
  level: string,
): Promise<string[]> {
  const log: string[] = [];
  // Re-register recorders is not possible after the fact; callers build the
  // registry with recorders that share `log`. Here we just drive the chain.
  const chain = registry.buildChain<unknown, { ok: true }>(level, async () => {
    log.push("core");
    return { ok: true };
  });
  await chain({});
  return log;
}

describe("middleware ordering — phase + before/after (F1)", () => {
  it("orders by phase band when no edges are given (observe→context→guard)", async () => {
    const log: string[] = [];
    const registry = new MiddlewareRegistry(["turn"]);
    // Register out of phase order on purpose.
    registry.register("turn", recorder("g", log), { phase: "guard" });
    registry.register("turn", recorder("o", log), { phase: "observe" });
    registry.register("turn", recorder("c", log), { phase: "context" });

    const chain = registry.buildChain<unknown, { ok: true }>("turn", async () => {
      log.push("core");
      return { ok: true };
    });
    await chain({});

    expect(log).toEqual([
      "o:in",
      "c:in",
      "g:in",
      "core",
      "g:out",
      "c:out",
      "o:out",
    ]);
  });

  it("breaks ties within a phase by registration order", async () => {
    const log: string[] = [];
    const registry = new MiddlewareRegistry(["turn"]);
    registry.register("turn", recorder("first", log), { phase: "context" });
    registry.register("turn", recorder("second", log), { phase: "context" });
    registry.register("turn", recorder("third", log), { phase: "context" });

    const chain = registry.buildChain<unknown, { ok: true }>("turn", async () => {
      log.push("core");
      return { ok: true };
    });
    await chain({});

    expect(log.slice(0, 3)).toEqual(["first:in", "second:in", "third:in"]);
  });

  it('"A after B" makes B enter before A (entry-order semantics)', async () => {
    const log: string[] = [];
    const registry = new MiddlewareRegistry(["turn"]);
    // "inner" registered first but declares it runs after "outer".
    registry.register("turn", recorder("inner", log), {
      name: "inner",
      after: "outer",
    });
    registry.register("turn", recorder("outer", log), { name: "outer" });

    const chain = registry.buildChain<unknown, { ok: true }>("turn", async () => {
      log.push("core");
      return { ok: true };
    });
    await chain({});

    expect(log).toEqual([
      "outer:in",
      "inner:in",
      "core",
      "inner:out",
      "outer:out",
    ]);
  });

  it("resolves a phase: reference to every member of that phase", async () => {
    const log: string[] = [];
    const registry = new MiddlewareRegistry(["turn"]);
    // A guard-phase mw that must enter before the whole context phase — an
    // unusual but legal cross-phase edge expressed via "phase:".
    registry.register("turn", recorder("c1", log), {
      name: "c1",
      phase: "context",
    });
    registry.register("turn", recorder("c2", log), {
      name: "c2",
      phase: "context",
    });
    registry.register("turn", recorder("early-guard", log), {
      name: "early-guard",
      phase: "guard",
      before: "phase:context",
    });

    const chain = registry.buildChain<unknown, { ok: true }>("turn", async () => {
      log.push("core");
      return { ok: true };
    });
    await chain({});

    expect(log.slice(0, 3)).toEqual(["early-guard:in", "c1:in", "c2:in"]);
  });

  it("drops an *Optional reference to an absent middleware, throws on a hard one", () => {
    // Ref resolution only runs when there are 2+ entries (a single entry is
    // trivially ordered), so each registry carries a real second middleware.
    const optional = new MiddlewareRegistry(["turn"]);
    optional.register("turn", recorder("a", []), {
      name: "a",
      afterOptional: "ghost",
    });
    optional.register("turn", recorder("b", []), { name: "b" });
    expect(() => optional.validate()).not.toThrow();

    const hard = new MiddlewareRegistry(["turn"]);
    hard.register("turn", recorder("a", []), { name: "a", after: "ghost" });
    hard.register("turn", recorder("b", []), { name: "b" });
    expect(() => hard.validate()).toThrow(MiddlewareOrderError);
    expect(() => hard.validate()).toThrow(/unknown middleware/);
  });
});

describe("middleware ordering — boot validation (F1)", () => {
  it("throws on a duplicate name at the same level, naming the extension", () => {
    const registry = new MiddlewareRegistry(["toolCall"]);
    registry.register("toolCall", recorder("x", []), { name: "dup" }, "my-ext");
    registry.register("toolCall", recorder("y", []), { name: "dup" }, "my-ext");
    expect(() => registry.validate()).toThrow(MiddlewareOrderError);
    expect(() => registry.validate()).toThrow(/Duplicate middleware name "dup"/);
  });

  it('rejects the "model" phase outside the step level', () => {
    const registry = new MiddlewareRegistry(["turn", "step"]);
    registry.register("turn", recorder("m", []), {
      name: "m",
      phase: "model",
    });
    expect(() => registry.validate()).toThrow(/phase "model".*step level/s);
  });

  it("rejects registering at a level outside allowedLevels", () => {
    const registry = new MiddlewareRegistry(["turn", "step", "toolCall"]);
    expect(() =>
      registry.register("ingress", recorder("i", [])),
    ).toThrow(/Cannot register middleware at level "ingress"/);
  });

  it("reports a cycle with the offending edge reasons", () => {
    const registry = new MiddlewareRegistry(["turn"]);
    registry.register("turn", recorder("a", []), {
      name: "a",
      before: "b",
    });
    registry.register("turn", recorder("b", []), {
      name: "b",
      before: "a",
    });
    expect(() => registry.validate()).toThrow(/cycle/);
    expect(() => registry.validate()).toThrow(/--before-->/);
  });

  it("validates the whole registry, not just the latest batch", () => {
    // Two separate register calls that only conflict when considered together.
    const registry = new MiddlewareRegistry(["step"]);
    registry.register("step", recorder("x", []), { name: "same" });
    registry.validate(); // fine so far
    registry.register("step", recorder("y", []), { name: "same" });
    expect(() => registry.validate()).toThrow(/Duplicate middleware name "same"/);
  });
});

describe("middleware ordering — slot wiring (F6)", () => {
  const TOKEN = createSlot<string>("auth.token");

  it("accepts an always-provider read with consumes/get and orders provider first", async () => {
    const log: string[] = [];
    const registry = new MiddlewareRegistry(["turn"]);
    registry.register("turn", recorder("consumer", log), {
      name: "consumer",
      consumes: TOKEN,
    });
    registry.register("turn", recorder("provider", log), {
      name: "provider",
      provides: { slot: TOKEN, always: true },
    });

    expect(() => registry.validate()).not.toThrow();
    const chain = registry.buildChain<unknown, { ok: true }>("turn", async () => {
      log.push("core");
      return { ok: true };
    });
    await chain({});
    // provider→consumer slot edge means provider enters first.
    expect(log.slice(0, 2)).toEqual(["provider:in", "consumer:in"]);
  });

  it("rejects consumes/get against a conditional provider", () => {
    const registry = new MiddlewareRegistry(["turn"]);
    registry.register("turn", recorder("consumer", []), {
      name: "consumer",
      consumes: TOKEN,
    });
    registry.register("turn", recorder("provider", []), {
      name: "provider",
      provides: TOKEN, // bare key ⇒ conditional
    });
    expect(() => registry.validate()).toThrow(SlotWiringError);
    expect(() => registry.validate()).toThrow(/conditional/);
  });

  it("rejects a required consume with no provider", () => {
    const registry = new MiddlewareRegistry(["turn"]);
    registry.register("turn", recorder("consumer", []), {
      name: "consumer",
      consumes: TOKEN,
    });
    expect(() => registry.validate()).toThrow(/no middleware provides it/);
  });

  it("rejects two providers for one slot id", () => {
    const registry = new MiddlewareRegistry(["turn", "step"]);
    registry.register("turn", recorder("p1", []), {
      name: "p1",
      provides: { slot: TOKEN, always: true },
    });
    registry.register("step", recorder("p2", []), {
      name: "p2",
      provides: { slot: TOKEN, always: true },
    });
    expect(() => registry.validate()).toThrow(/more than one provider/);
  });

  it("rejects a provider at a level inner to its consumer", () => {
    const registry = new MiddlewareRegistry(["turn", "step"]);
    // provider at step (inner), consumer at turn (outer) — illegal.
    registry.register("step", recorder("provider", []), {
      name: "provider",
      provides: { slot: TOKEN, always: true },
    });
    registry.register("turn", recorder("consumer", []), {
      name: "consumer",
      consumes: TOKEN,
    });
    expect(() => registry.validate()).toThrow(/outer-or-equal/);
  });

  it("rejects slot declarations at ingress/route", () => {
    const registry = new MiddlewareRegistry(["ingress"]);
    registry.register("ingress", recorder("p", []), {
      name: "p",
      provides: { slot: TOKEN, always: true },
    });
    expect(() => registry.validate()).toThrow(SlotWiringError);
    expect(() => registry.validate()).toThrow(/only available at turn\/step\/toolCall/);
  });

  it("allows consumesOptional against a conditional provider (tryGet path)", () => {
    const registry = new MiddlewareRegistry(["turn"]);
    registry.register("turn", recorder("consumer", []), {
      name: "consumer",
      consumesOptional: TOKEN,
    });
    registry.register("turn", recorder("provider", []), {
      name: "provider",
      provides: TOKEN,
    });
    expect(() => registry.validate()).not.toThrow();
  });
});

describe("planMiddlewareOrder (pure)", () => {
  function placement(
    name: string,
    opts: Partial<NormalizedPlacement> = {},
  ): NormalizedPlacement {
    return {
      name,
      phase: "context",
      before: [],
      after: [],
      beforeOptional: [],
      afterOptional: [],
      provides: [],
      consumes: [],
      consumesOptional: [],
      level: "turn",
      order: 0,
      declaration: {
        gettable: new Set(),
        readable: new Set(),
        writable: new Set(),
      },
      ...opts,
    };
  }

  it("returns the single entry unchanged", () => {
    const a = placement("a");
    expect(planMiddlewareOrder([a])).toEqual([a]);
  });

  it("sorts by phase then registration order deterministically", () => {
    const entries = [
      placement("g", { phase: "guard", order: 0 }),
      placement("o", { phase: "observe", order: 1 }),
      placement("c1", { phase: "context", order: 2 }),
      placement("c2", { phase: "context", order: 3 }),
    ];
    const ordered = planMiddlewareOrder(entries).map((e) => e.name);
    expect(ordered).toEqual(["o", "c1", "c2", "g"]);
  });
});

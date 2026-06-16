import { describe, it, expect, vi } from "vitest";
import {
  buildChain,
  MiddlewareRegistry,
  planMiddlewareOrder,
  type ChainEntry,
  type NormalizedPlacement,
} from "../middleware-chain.js";
import { MiddlewareOrderError } from "../errors.js";

// Helper: a simple context type
interface Ctx {
  value: number;
}

// Helper: a simple result type
interface Res {
  result: number;
}

type Handler = (ctx: Ctx, next: (override?: Partial<Ctx>) => Promise<Res>) => Promise<Res>;

describe("buildChain", () => {
  it("empty middleware list runs core handler directly", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value * 2 });
    const chain = buildChain<Ctx, Res>([], core);

    const result = await chain({ value: 5 });
    expect(result).toEqual({ result: 10 });
  });

  it("single middleware wraps core handler with before/after hooks", async () => {
    const log: string[] = [];

    const core = async (ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: ctx.value };
    };

    const mw: Handler = async (_ctx, next) => {
      log.push("before");
      const res = await next();
      log.push("after");
      return res;
    };

    const chain = buildChain<Ctx, Res>([mw], core);
    await chain({ value: 1 });

    expect(log).toEqual(["before", "core", "after"]);
  });

  it("wraps handlers outermost-first (index 0 is outermost)", async () => {
    const log: string[] = [];

    const core = async (_ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: 0 };
    };

    const makeMw = (name: string): Handler => async (_ctx, next) => {
      log.push(`${name}:before`);
      const res = await next();
      log.push(`${name}:after`);
      return res;
    };

    const chain = buildChain<Ctx, Res>([makeMw("A"), makeMw("B"), makeMw("C")], core);
    await chain({ value: 1 });

    expect(log).toEqual([
      "A:before",
      "B:before",
      "C:before",
      "core",
      "C:after",
      "B:after",
      "A:after",
    ]);
  });

  it("middleware that skips next() prevents core handler from running", async () => {
    const coreRan = vi.fn();

    const core = async (_ctx: Ctx): Promise<Res> => {
      coreRan();
      return { result: 99 };
    };

    const shortCircuit: Handler = async () => ({ result: 42 });

    const chain = buildChain<Ctx, Res>([shortCircuit], core);
    const result = await chain({ value: 1 });

    expect(result).toEqual({ result: 42 });
    expect(coreRan).not.toHaveBeenCalled();
  });

  it("middleware that throws propagates the error to the caller", async () => {
    const core = async (_ctx: Ctx): Promise<Res> => ({ result: 0 });

    const throwing: Handler = async () => {
      throw new Error("middleware-error");
    };

    const chain = buildChain<Ctx, Res>([throwing], core);

    await expect(chain({ value: 1 })).rejects.toThrow("middleware-error");
  });

  it("middleware can modify context before calling next()", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value });

    const modifier: Handler = async (ctx, next) => {
      ctx.value = ctx.value + 10;
      return next();
    };

    const chain = buildChain<Ctx, Res>([modifier], core);
    const result = await chain({ value: 5 });

    expect(result).toEqual({ result: 15 });
  });

  it("middleware can pass a partial context override to downstream handlers", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value });
    const originalCtx = { value: 5 };
    const innerObservedValues: number[] = [];

    const outer: Handler = async (ctx, next) => next({ value: ctx.value + 10 });
    const inner: Handler = async (ctx, next) => {
      innerObservedValues.push(ctx.value);
      return next();
    };

    const chain = buildChain<Ctx, Res>([outer, inner], core);
    const result = await chain(originalCtx);

    expect(innerObservedValues).toEqual([15]);
    expect(result).toEqual({ result: 15 });
    expect(originalCtx).toEqual({ value: 5 });
  });

  it("middleware can modify the result after next() returns", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value });

    const resultModifier: Handler = async (_ctx, next) => {
      const res = await next();
      return { result: res.result * 3 };
    };

    const chain = buildChain<Ctx, Res>([resultModifier], core);
    const result = await chain({ value: 7 });

    expect(result).toEqual({ result: 21 });
  });

  it("applies a per-layer wrapCtx transform to the handler and downstream", async () => {
    const observed: number[] = [];
    const core = async (ctx: Ctx): Promise<Res> => {
      observed.push(ctx.value);
      return { result: ctx.value };
    };

    const entry: ChainEntry<Ctx, Res> = {
      handler: async (ctx, next) => {
        observed.push(ctx.value);
        return next();
      },
      wrapCtx: (ctx) => ({ ...ctx, value: ctx.value + 100 }),
    };

    const chain = buildChain<Ctx, Res>([entry], core);
    await chain({ value: 1 });

    // The handler and the core both see the wrapped (101) value.
    expect(observed).toEqual([101, 101]);
  });
});

describe("MiddlewareRegistry", () => {
  it("builds a working chain for a registered level", async () => {
    const registry = new MiddlewareRegistry();

    const log: string[] = [];
    registry.register("turn", (async (_ctx: Ctx, next: () => Promise<Res>) => {
      log.push("mw:before");
      const res = await next();
      log.push("mw:after");
      return res;
    }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>);

    const core = async (ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: ctx.value };
    };

    const chain = registry.buildChain<Ctx, Res>("turn", core);
    const result = await chain({ value: 3 });

    expect(result).toEqual({ result: 3 });
    expect(log).toEqual(["mw:before", "core", "mw:after"]);
  });

  it("orders by registration when no before/after is given", async () => {
    const registry = new MiddlewareRegistry();
    const log: string[] = [];

    const makeMw = (name: string) =>
      (async (_ctx: Ctx, next: () => Promise<Res>) => {
        log.push(`${name}:before`);
        const res = await next();
        log.push(`${name}:after`);
        return res;
      }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;

    registry.register("turn", makeMw("A"), { name: "A" });
    registry.register("turn", makeMw("B"), { name: "B" });

    const core = async (_ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: 0 };
    };
    const chain = registry.buildChain<Ctx, Res>("turn", core);
    await chain({ value: 1 });

    expect(log).toEqual(["A:before", "B:before", "core", "B:after", "A:after"]);
  });

  it("honors before/after edges over registration order", async () => {
    const registry = new MiddlewareRegistry();
    const log: string[] = [];

    const makeMw = (name: string) =>
      (async (_ctx: Ctx, next: () => Promise<Res>) => {
        log.push(name);
        return next();
      }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;

    // Registered B then A, but A declares before:B → A enters first.
    registry.register("turn", makeMw("B"), { name: "B" });
    registry.register("turn", makeMw("A"), { name: "A", before: "B" });

    const core = async (_ctx: Ctx): Promise<Res> => ({ result: 0 });
    const chain = registry.buildChain<Ctx, Res>("turn", core);
    await chain({ value: 1 });

    expect(log).toEqual(["A", "B"]);
  });

  it("'*' band: before:'*' enters outermost, after:'*' enters innermost", async () => {
    const registry = new MiddlewareRegistry();
    const log: string[] = [];

    const makeMw = (name: string) =>
      (async (_ctx: Ctx, next: () => Promise<Res>) => {
        log.push(name);
        return next();
      }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;

    // Registration order deliberately scrambled relative to desired order.
    registry.register("turn", makeMw("mid"), { name: "mid" });
    registry.register("turn", makeMw("last"), { name: "last", after: "*" });
    registry.register("turn", makeMw("first"), { name: "first", before: "*" });

    const core = async (_ctx: Ctx): Promise<Res> => ({ result: 0 });
    const chain = registry.buildChain<Ctx, Res>("turn", core);
    await chain({ value: 1 });

    expect(log).toEqual(["first", "mid", "last"]);
  });

  it("throws a boot error on an unknown before/after reference", () => {
    const registry = new MiddlewareRegistry();
    registry.register(
      "turn",
      (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
        c: unknown,
        n: () => Promise<unknown>,
      ) => Promise<unknown>,
      { name: "A", before: "ghost" },
    );

    expect(() => registry.validate()).toThrow(MiddlewareOrderError);
    expect(() => registry.validate()).toThrow(/unknown middleware/);
  });

  it("throws a boot error on a cycle", () => {
    const registry = new MiddlewareRegistry();
    const noop = (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
      c: unknown,
      n: () => Promise<unknown>,
    ) => Promise<unknown>;

    registry.register("turn", noop, { name: "A", before: "B" });
    registry.register("turn", noop, { name: "B", before: "A" });

    expect(() => registry.validate()).toThrow(MiddlewareOrderError);
    expect(() => registry.validate()).toThrow(/cycle/);
  });

  it("throws a boot error on a duplicate name at one level", () => {
    const registry = new MiddlewareRegistry();
    const noop = (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
      c: unknown,
      n: () => Promise<unknown>,
    ) => Promise<unknown>;

    registry.register("turn", noop, { name: "dup" });
    registry.register("turn", noop, { name: "dup" });

    expect(() => registry.validate()).toThrow(MiddlewareOrderError);
    expect(() => registry.validate()).toThrow(/Duplicate middleware name/);
  });

  it("rejects '*' as a middleware name", () => {
    const registry = new MiddlewareRegistry();
    const noop = (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
      c: unknown,
      n: () => Promise<unknown>,
    ) => Promise<unknown>;

    registry.register("turn", noop, { name: "*" });

    expect(() => registry.validate()).toThrow(MiddlewareOrderError);
  });

  it("rejects registration at a disallowed level (scope enforcement)", () => {
    const registry = new MiddlewareRegistry(["turn", "step", "toolCall"]);
    const noop = (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
      c: unknown,
      n: () => Promise<unknown>,
    ) => Promise<unknown>;

    expect(() => registry.register("ingress", noop)).toThrow(MiddlewareOrderError);
  });

  it("warns once per level when multiple unordered middleware coexist", () => {
    const warnings: string[] = [];
    const registry = new MiddlewareRegistry(undefined, (m) => warnings.push(m));
    const noop = (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
      c: unknown,
      n: () => Promise<unknown>,
    ) => Promise<unknown>;

    registry.register("turn", noop, { name: "A" });
    registry.register("turn", noop, { name: "B" });
    registry.register("turn", noop, { name: "C" });

    registry.validate();

    const turnWarnings = warnings.filter((w) => w.includes('Level "turn"'));
    expect(turnWarnings).toHaveLength(1);
    expect(turnWarnings[0]).toMatch(/no before\/after placement/);
  });

  it("does not warn when unordered middleware are placed with before/after", () => {
    const warnings: string[] = [];
    const registry = new MiddlewareRegistry(undefined, (m) => warnings.push(m));
    const noop = (async (_c: unknown, n: () => Promise<unknown>) => n()) as (
      c: unknown,
      n: () => Promise<unknown>,
    ) => Promise<unknown>;

    registry.register("turn", noop, { name: "A", before: "*" });
    registry.register("turn", noop, { name: "B", after: "A" });

    registry.validate();

    expect(warnings.filter((w) => w.includes('Level "turn"'))).toHaveLength(0);
  });

  it("injects a per-layer scoped ctx via wrapCtxFor", async () => {
    const registry = new MiddlewareRegistry();
    const seen: Array<string | undefined> = [];

    interface ScopedCtx {
      scope?: string;
    }
    registry.register(
      "turn",
      (async (ctx: ScopedCtx, next: () => Promise<Res>) => {
        seen.push(ctx.scope);
        return next();
      }) as (c: unknown, n: () => Promise<unknown>) => Promise<unknown>,
      { name: "A" },
      "ext-a",
    );

    const core = async (_ctx: ScopedCtx): Promise<Res> => ({ result: 0 });
    const chain = registry.buildChain<ScopedCtx, Res>("turn", core, {
      wrapCtxFor: (extensionName) => (ctx) => ({ ...ctx, scope: extensionName }),
    });
    await chain({});

    expect(seen).toEqual(["ext-a"]);
  });

  it("unregistered level builds chain with no middlewares (core only)", async () => {
    const registry = new MiddlewareRegistry();
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value * 2 });

    const chain = registry.buildChain<Ctx, Res>("unknown-level", core);
    const result = await chain({ value: 4 });

    expect(result).toEqual({ result: 8 });
  });
});

describe("planMiddlewareOrder", () => {
  const place = (
    name: string,
    order: number,
    opts: Partial<NormalizedPlacement> = {},
  ): NormalizedPlacement => ({
    name,
    before: [],
    after: [],
    bandBefore: false,
    bandAfter: false,
    level: "turn",
    order,
    ...opts,
  });

  it("returns registration order with no edges", () => {
    const plan = planMiddlewareOrder([place("A", 0), place("B", 1), place("C", 2)]);
    expect(plan.map((p) => p.name)).toEqual(["A", "B", "C"]);
  });

  it("resolves a before edge regardless of registration order", () => {
    const plan = planMiddlewareOrder([
      place("B", 0),
      place("A", 1, { before: ["B"] }),
    ]);
    expect(plan.map((p) => p.name)).toEqual(["A", "B"]);
  });

  it("bandBefore precedes all non-band, bandAfter follows all non-band", () => {
    const plan = planMiddlewareOrder([
      place("mid", 0),
      place("last", 1, { bandAfter: true }),
      place("first", 2, { bandBefore: true }),
    ]);
    expect(plan.map((p) => p.name)).toEqual(["first", "mid", "last"]);
  });
});

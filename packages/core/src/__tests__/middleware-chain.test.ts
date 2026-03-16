import { describe, it, expect, vi } from "vitest";
import { buildChain, MiddlewareRegistry } from "../middleware-chain.js";

// Helper: a simple context type
interface Ctx {
  value: number;
}

// Helper: a simple result type
interface Res {
  result: number;
}

describe("buildChain", () => {
  // Test 1: Empty chain → core handler runs directly
  it("empty middleware list runs core handler directly", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value * 2 });
    const chain = buildChain([], core);

    const result = await chain({ value: 5 });
    expect(result).toEqual({ result: 10 });
  });

  // Test 2: Single middleware wraps core handler (before/after)
  it("single middleware wraps core handler with before/after hooks", async () => {
    const log: string[] = [];

    const core = async (ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: ctx.value };
    };

    const mw = {
      handler: async (ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        log.push("before");
        const res = await next();
        log.push("after");
        return res;
      },
      priority: 100,
      order: 0,
    };

    const chain = buildChain([mw], core);
    await chain({ value: 1 });

    expect(log).toEqual(["before", "core", "after"]);
  });

  // Test 3: Multiple middlewares execute in priority order (50 → 100 → 200)
  it("multiple middlewares execute in ascending priority order", async () => {
    const log: string[] = [];

    const core = async (_ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: 0 };
    };

    const makeMw = (name: string, priority: number, order: number) => ({
      handler: async (_ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        log.push(`${name}:before`);
        const res = await next();
        log.push(`${name}:after`);
        return res;
      },
      priority,
      order,
    });

    const chain = buildChain(
      [makeMw("p200", 200, 2), makeMw("p50", 50, 0), makeMw("p100", 100, 1)],
      core
    );
    await chain({ value: 1 });

    expect(log).toEqual([
      "p50:before",
      "p100:before",
      "p200:before",
      "core",
      "p200:after",
      "p100:after",
      "p50:after",
    ]);
  });

  // Test 4: Same priority → declaration (registration) order
  it("same priority respects registration (declaration) order", async () => {
    const log: string[] = [];

    const core = async (_ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: 0 };
    };

    const makeMw = (name: string, order: number) => ({
      handler: async (_ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        log.push(`${name}:before`);
        const res = await next();
        log.push(`${name}:after`);
        return res;
      },
      priority: 100,
      order,
    });

    // Registered in order: A(0), B(1), C(2) — all same priority
    const chain = buildChain(
      [makeMw("A", 0), makeMw("B", 1), makeMw("C", 2)],
      core
    );
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

  // Test 5: Middleware that doesn't call next() → core handler NOT executed
  it("middleware that skips next() prevents core handler from running", async () => {
    const coreRan = vi.fn();

    const core = async (_ctx: Ctx): Promise<Res> => {
      coreRan();
      return { result: 99 };
    };

    const shortCircuit = {
      handler: async (_ctx: Ctx, _next: () => Promise<Res>): Promise<Res> => {
        // Do NOT call next
        return { result: 42 };
      },
      priority: 100,
      order: 0,
    };

    const chain = buildChain([shortCircuit], core);
    const result = await chain({ value: 1 });

    expect(result).toEqual({ result: 42 });
    expect(coreRan).not.toHaveBeenCalled();
  });

  // Test 6: Middleware that throws → error propagates to caller
  it("middleware that throws propagates the error to the caller", async () => {
    const core = async (_ctx: Ctx): Promise<Res> => ({ result: 0 });

    const throwing = {
      handler: async (_ctx: Ctx, _next: () => Promise<Res>): Promise<Res> => {
        throw new Error("middleware-error");
      },
      priority: 100,
      order: 0,
    };

    const chain = buildChain([throwing], core);

    await expect(chain({ value: 1 })).rejects.toThrow("middleware-error");
  });

  // Test 7: Middleware can modify context before next()
  it("middleware can modify context before calling next()", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value });

    const modifier = {
      handler: async (ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        ctx.value = ctx.value + 10;
        return next();
      },
      priority: 100,
      order: 0,
    };

    const chain = buildChain([modifier], core);
    const result = await chain({ value: 5 });

    expect(result).toEqual({ result: 15 });
  });

  // Test 8: Middleware can modify result after next()
  it("middleware can modify the result after next() returns", async () => {
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value });

    const resultModifier = {
      handler: async (ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        const res = await next();
        return { result: res.result * 3 };
      },
      priority: 100,
      order: 0,
    };

    const chain = buildChain([resultModifier], core);
    const result = await chain({ value: 7 });

    expect(result).toEqual({ result: 21 });
  });

  // Test 9: Extension isolation (NFR-003): middleware A throws → middleware B (lower priority) still functions in subsequent calls
  it("NFR-003: one middleware throwing does not break other middlewares in subsequent calls", async () => {
    let callCount = 0;
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value });

    // mwA has priority 50 (runs outermost) and throws on first call
    const mwA = {
      handler: async (ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient error from mwA");
        }
        return next();
      },
      priority: 50,
      order: 0,
    };

    // mwB has priority 100 (runs inside mwA)
    const mwBRan = vi.fn();
    const mwB = {
      handler: async (ctx: Ctx, next: () => Promise<Res>): Promise<Res> => {
        mwBRan();
        return next();
      },
      priority: 100,
      order: 1,
    };

    const chain = buildChain([mwA, mwB], core);

    // First call: mwA throws — chain invocation fails
    await expect(chain({ value: 1 })).rejects.toThrow("transient error from mwA");

    // mwB should NOT have been called on first invocation (mwA threw before calling next)
    expect(mwBRan).not.toHaveBeenCalled();

    // Second call: mwA no longer throws, mwB should run fine
    const result = await chain({ value: 5 });
    expect(result).toEqual({ result: 5 });
    expect(mwBRan).toHaveBeenCalledOnce();
  });
});

describe("MiddlewareRegistry", () => {
  it("builds a working chain for a registered level", async () => {
    const registry = new MiddlewareRegistry();

    const log: string[] = [];
    registry.register("turn", (async (ctx: Ctx, next: () => Promise<Res>) => {
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

  it("respects priority option when registering", async () => {
    const registry = new MiddlewareRegistry();
    const log: string[] = [];

    registry.register(
      "turn",
      (async (_ctx: Ctx, next: () => Promise<Res>) => {
        log.push("p200:before");
        const res = await next();
        log.push("p200:after");
        return res;
      }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      { priority: 200 }
    );

    registry.register(
      "turn",
      (async (_ctx: Ctx, next: () => Promise<Res>) => {
        log.push("p50:before");
        const res = await next();
        log.push("p50:after");
        return res;
      }) as (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      { priority: 50 }
    );

    const core = async (_ctx: Ctx): Promise<Res> => {
      log.push("core");
      return { result: 0 };
    };

    const chain = registry.buildChain<Ctx, Res>("turn", core);
    await chain({ value: 1 });

    expect(log).toEqual([
      "p50:before",
      "p200:before",
      "core",
      "p200:after",
      "p50:after",
    ]);
  });

  it("unregistered level builds chain with no middlewares (core only)", async () => {
    const registry = new MiddlewareRegistry();
    const core = async (ctx: Ctx): Promise<Res> => ({ result: ctx.value * 2 });

    const chain = registry.buildChain<Ctx, Res>("unknown-level", core);
    const result = await chain({ value: 4 });

    expect(result).toEqual({ result: 8 });
  });
});

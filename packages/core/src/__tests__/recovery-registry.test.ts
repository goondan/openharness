import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecoveryRegistry, type RecoveryRunHooks } from "../recovery-registry.js";
import { ConfigError } from "../errors.js";
import type { StepContext } from "@goondan/openharness-types";

// A minimal StepContext stand-in. The registry only forwards it to matcher
// predicates and recover hooks; the unit tests that need fields set them.
const CTX = {} as StepContext;

// Build a hooks object with spies. `events` lets a test simulate the
// conversation growing during an attempt (drives the retry-safety guard).
function makeHooks(
  overrides: Partial<RecoveryRunHooks> = {},
): RecoveryRunHooks & {
  onRetry: ReturnType<typeof vi.fn>;
  onExhausted: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    eventCount: () => 0,
    onRetry: vi.fn(),
    onExhausted: vi.fn(),
    sleep: vi.fn(async () => {}),
    isBypass: () => false,
    ...overrides,
  } as RecoveryRunHooks & {
    onRetry: ReturnType<typeof vi.fn>;
    onExhausted: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
  };
}

class FlakyError extends Error {
  constructor(msg = "flaky") {
    super(msg);
    this.name = "FlakyError";
  }
}

describe("RecoveryRegistry — registration", () => {
  it("rejects a non-integer or < 1 attempts count at claim time", () => {
    const reg = new RecoveryRegistry();
    const api = reg.apiFor("ext");
    expect(() => api.claim(FlakyError, { attempts: 0 })).toThrow(ConfigError);
    expect(() => api.claim(FlakyError, { attempts: 1.5 })).toThrow(
      /attempts must be an integer/,
    );
    expect(() =>
      api.claim(FlakyError, { attempts: Number.NaN }),
    ).toThrow(ConfigError);
  });

  it("starts empty and reports isEmpty until a claim lands", () => {
    const reg = new RecoveryRegistry();
    expect(reg.isEmpty).toBe(true);
    reg.apiFor("ext").claim(FlakyError, { attempts: 2 });
    expect(reg.isEmpty).toBe(false);
  });
});

describe("RecoveryRegistry — default retry (no recover)", () => {
  it("retries up to the cap, emits attempt-numbered onRetry, then rethrows the original", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, { attempts: 3 });
    const hooks = makeHooks();

    const err = new FlakyError();
    const task = vi.fn(async () => {
      throw err;
    });

    await expect(reg.run(task, CTX, hooks)).rejects.toBe(err);
    // 3 attempts total = original + 2 retries.
    expect(task).toHaveBeenCalledTimes(3);
    expect(hooks.onRetry).toHaveBeenCalledTimes(2);
    expect(hooks.onRetry.mock.calls[0][0]).toMatchObject({ attempt: 2 });
    expect(hooks.onRetry.mock.calls[1][0]).toMatchObject({ attempt: 3 });
    expect(hooks.onExhausted).toHaveBeenCalledTimes(1);
    expect(hooks.onExhausted.mock.calls[0][0]).toMatchObject({
      attempts: 3,
      error: err,
      claimName: "ext",
    });
  });

  it("returns the task result and emits nothing once it succeeds on retry", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, { attempts: 5 });
    const hooks = makeHooks();

    let n = 0;
    const task = vi.fn(async () => {
      if (++n < 3) throw new FlakyError();
      return "ok";
    });

    await expect(reg.run(task, CTX, hooks)).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(3);
    expect(hooks.onRetry).toHaveBeenCalledTimes(2);
    expect(hooks.onExhausted).not.toHaveBeenCalled();
  });

  it("refuses a default retry when the conversation grew during the attempt", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, { attempts: 5 });

    // eventCount returns 0 at snapshot, 1 after the task ran (turn half-applied).
    let count = 0;
    const hooks = makeHooks({ eventCount: () => count });

    const err = new FlakyError();
    const task = vi.fn(async () => {
      count = 1; // simulate an event appended mid-attempt
      throw err;
    });

    await expect(reg.run(task, CTX, hooks)).rejects.toBe(err);
    // Guard tripped on the first failure — no retry.
    expect(task).toHaveBeenCalledTimes(1);
    expect(hooks.onRetry).not.toHaveBeenCalled();
    expect(hooks.onExhausted).toHaveBeenCalledTimes(1);
  });
});

describe("RecoveryRegistry — recover outcomes", () => {
  it('"retry" re-runs and opts out of the conversation-grew guard', async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, {
      attempts: 3,
      recover: () => ({ action: "retry" }),
    });

    // Conversation grows every attempt; a default retry would refuse, but a
    // recover-driven retry presumes the mutation was intentional.
    let count = 0;
    const hooks = makeHooks({ eventCount: () => count });

    let n = 0;
    const task = vi.fn(async () => {
      count++;
      if (++n < 3) throw new FlakyError();
      return "ok";
    });

    await expect(reg.run(task, CTX, hooks)).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(3);
    expect(hooks.onRetry).toHaveBeenCalledTimes(2);
  });

  it('"fail" stops and propagates the original error', async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, {
      attempts: 5,
      recover: () => ({ action: "fail" }),
    });
    const hooks = makeHooks();

    const err = new FlakyError();
    const task = vi.fn(async () => {
      throw err;
    });

    await expect(reg.run(task, CTX, hooks)).rejects.toBe(err);
    expect(task).toHaveBeenCalledTimes(1); // no retry
    expect(hooks.onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ error: err }),
    );
  });

  it('"fail" with throw propagates the transformed error (429 → RateLimitExhausted pattern)', async () => {
    const reg = new RecoveryRegistry();
    const transformed = new Error("rate-limit-exhausted");
    reg.apiFor("ext").claim(FlakyError, {
      attempts: 5,
      recover: () => ({ action: "fail", throw: transformed }),
    });
    const hooks = makeHooks();

    const task = vi.fn(async () => {
      throw new FlakyError();
    });

    await expect(reg.run(task, CTX, hooks)).rejects.toBe(transformed);
    expect(hooks.onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ error: transformed }),
    );
  });

  it('"unhandled" declines so the next matching claim takes over', async () => {
    const reg = new RecoveryRegistry();
    const api = reg.apiFor("first");
    api.claim(FlakyError, {
      attempts: 5,
      recover: () => ({ action: "unhandled" }),
    });
    reg.apiFor("second").claim(FlakyError, {
      attempts: 5,
      recover: () => ({ action: "fail" }),
    });
    const hooks = makeHooks();

    const err = new FlakyError();
    await expect(
      reg.run(
        async () => {
          throw err;
        },
        CTX,
        hooks,
      ),
    ).rejects.toBe(err);
    // The second claim owned it and chose fail → no retry, onExhausted by "second".
    expect(hooks.onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ claimName: "second" }),
    );
  });

  it("propagates the original error when no claim matches", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, { attempts: 5 });
    const hooks = makeHooks();

    const other = new TypeError("unrelated");
    await expect(
      reg.run(
        async () => {
          throw other;
        },
        CTX,
        hooks,
      ),
    ).rejects.toBe(other);
    expect(hooks.onExhausted).not.toHaveBeenCalled();
  });
});

describe("RecoveryRegistry — matchers and precedence", () => {
  it("matches via a predicate that reads the StepContext", async () => {
    const reg = new RecoveryRegistry();
    const seen: StepContext[] = [];
    reg.apiFor("ext").claim(
      (error, ctx) => {
        seen.push(ctx);
        return error instanceof Error && error.message.includes("retryable");
      },
      { attempts: 2 },
    );
    const hooks = makeHooks();
    const ctx = { stepNumber: 7 } as StepContext;

    await expect(
      reg.run(
        async () => {
          throw new Error("retryable boom");
        },
        ctx,
        hooks,
      ),
    ).rejects.toThrow("retryable boom");
    expect(hooks.onRetry).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe(ctx);
  });

  it("honours registration order — the first matching claim wins", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("winner").claim(Error, {
      attempts: 1,
      recover: () => ({ action: "fail" }),
    });
    reg.apiFor("loser").claim(FlakyError, {
      attempts: 1,
      recover: () => ({ action: "fail", throw: new Error("should not run") }),
    });
    const hooks = makeHooks();

    const err = new FlakyError();
    await expect(
      reg.run(
        async () => {
          throw err;
        },
        CTX,
        hooks,
      ),
    ).rejects.toBe(err); // winner's "fail" propagates the original
  });

  it("rethrows a bypass error untouched without consulting any claim", async () => {
    const reg = new RecoveryRegistry();
    const recover = vi.fn(() => ({ action: "fail" }) as const);
    reg.apiFor("ext").claim(Error, { attempts: 5, recover });
    const bypass = new Error("approval-pending");
    const hooks = makeHooks({ isBypass: (e) => e === bypass });

    await expect(
      reg.run(
        async () => {
          throw bypass;
        },
        CTX,
        hooks,
      ),
    ).rejects.toBe(bypass);
    expect(recover).not.toHaveBeenCalled();
    expect(hooks.onExhausted).not.toHaveBeenCalled();
  });
});

describe("RecoveryRegistry — backoff", () => {
  it("sleeps a fixed backoffMs before each retry", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, { attempts: 3, backoffMs: 50 });
    const hooks = makeHooks();

    await expect(
      reg.run(
        async () => {
          throw new FlakyError();
        },
        CTX,
        hooks,
      ),
    ).rejects.toThrow();
    expect(hooks.sleep).toHaveBeenCalledTimes(2);
    expect(hooks.sleep).toHaveBeenNthCalledWith(1, 50);
  });

  it("computes backoff from a function of the next attempt number", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, {
      attempts: 3,
      backoffMs: (attempt) => attempt * 100,
    });
    const hooks = makeHooks();

    await expect(
      reg.run(
        async () => {
          throw new FlakyError();
        },
        CTX,
        hooks,
      ),
    ).rejects.toThrow();
    // nextAttempt is 2 then 3.
    expect(hooks.sleep).toHaveBeenNthCalledWith(1, 200);
    expect(hooks.sleep).toHaveBeenNthCalledWith(2, 300);
  });

  it("lets a recover retry override the backoff via afterMs", async () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("ext").claim(FlakyError, {
      attempts: 2,
      backoffMs: 9999,
      recover: () => ({ action: "retry", afterMs: 5 }),
    });
    const hooks = makeHooks();

    await expect(
      reg.run(
        async () => {
          throw new FlakyError();
        },
        CTX,
        hooks,
      ),
    ).rejects.toThrow();
    expect(hooks.sleep).toHaveBeenCalledWith(5);
  });
});

describe("RecoveryRegistry — validate()", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("warns when a broad error class claim shadows a later subclass claim", () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("broad").claim(Error, { attempts: 1 });
    reg.apiFor("narrow").claim(FlakyError, { attempts: 1 });
    reg.validate();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/shadows it/);
  });

  it("does not warn when the subclass claim is registered first", () => {
    const reg = new RecoveryRegistry();
    reg.apiFor("narrow").claim(FlakyError, { attempts: 1 });
    reg.apiFor("broad").claim(Error, { attempts: 1 });
    reg.validate();
    expect(warn).not.toHaveBeenCalled();
  });
});

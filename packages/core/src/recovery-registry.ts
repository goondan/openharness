/**
 * Error-ownership registry (F4).
 *
 * Extensions used to wrap the LLM/tool loop in their own try/catch — the
 * convention that produced Karby's non-local, order-dependent error handling.
 * Here an extension instead *claims* a class of error via `api.recovery.claim`
 * and the dispatcher owns one retry loop on its behalf. The claim decides
 * *what* to do; the registry decides *when* and *how often*.
 *
 * Precedence is registration order: the first claim whose matcher matches wins,
 * unless its `recover` returns `{ action: "unhandled" }`, in which case the next
 * matching claim is tried, and if none remain the error propagates.
 *
 * The registry is deliberately decoupled from the harness: it takes injected
 * hooks ({@link RecoveryRunHooks}) for the conversation-length snapshot, event
 * emission, abortable backoff, and the bypass predicate. That keeps the retry
 * semantics unit-testable without standing up a full agent.
 */
import type {
  ErrorClass,
  RecoveryClaimOptions,
  RecoveryClaimMeta,
  RecoveryMatcher,
  RecoveryOutcome,
  RecoveryApi,
  StepContext,
} from "@goondan/openharness-types";
import { ConfigError } from "./errors.js";

interface RegisteredClaim {
  matcher: RecoveryMatcher;
  attempts: number;
  backoffMs?: number | ((attempt: number, error: unknown) => number);
  recover?: RecoveryClaimOptions["recover"];
  /** Defaults to the registering extension's name. */
  name?: string;
}

/**
 * A {@link RecoveryMatcher} is an error class when it is a constructor whose
 * prototype chain reaches `Error`. A predicate is any other function — arrow
 * functions have no `prototype`, and a plain `function` predicate's prototype
 * is not an `Error`. This is what lets `claim(SomeError, …)` and
 * `claim((e, ctx) => …, …)` share one parameter slot.
 */
function isErrorClass(matcher: RecoveryMatcher): matcher is ErrorClass {
  return (
    typeof matcher === "function" &&
    matcher.prototype != null &&
    (matcher.prototype instanceof Error || matcher.prototype === Error.prototype)
  );
}

function matcherMatches(
  matcher: RecoveryMatcher,
  error: unknown,
  ctx: StepContext,
): boolean {
  if (isErrorClass(matcher)) return error instanceof matcher;
  return matcher(error, ctx);
}

/**
 * Side effects the dispatcher injects so the registry can run a retry loop
 * without knowing about the event bus, the conversation, or the abort signal.
 */
export interface RecoveryRunHooks {
  /**
   * Current `conversation.events.length`. Sampled before each attempt; the
   * retry-safety guard refuses a *default* retry if it changed during the
   * attempt (a half-applied turn must not be blindly replayed).
   */
  eventCount(): number;
  /** Emitted just before a retry actually re-runs the task. */
  onRetry(info: { attempt: number; error: Error; claimName?: string }): void;
  /** Emitted when a claim owned the error but the dispatcher is giving up. */
  onExhausted(info: {
    attempts: number;
    error: Error;
    claimName?: string;
  }): void;
  /** Abortable delay before a retry. Rejects if the turn aborts mid-backoff. */
  sleep(ms: number): Promise<void>;
  /**
   * Errors that must never be retried — the human-approval barrier and abort.
   * Injected so the registry need not depend on tool-call / abort types.
   */
  isBypass(error: unknown): boolean;
}

/** Internal: a matched claim plus the action the dispatcher should take. */
type Decision =
  | { kind: "default"; claim: RegisteredClaim }
  | { kind: "outcome"; claim: RegisteredClaim; outcome: RecoveryOutcome };

export class RecoveryRegistry {
  private readonly _claims: RegisteredClaim[] = [];

  /** True when no claims are registered (the common no-op fast path). */
  get isEmpty(): boolean {
    return this._claims.length === 0;
  }

  /**
   * Build the `api.recovery` surface for one extension. `meta.name` defaults to
   * the extension's name so diagnostics name the owner without ceremony.
   */
  apiFor(extensionName: string): RecoveryApi {
    return {
      claim: (
        matcher: RecoveryMatcher,
        options: RecoveryClaimOptions,
        meta?: RecoveryClaimMeta,
      ): void => {
        this._register(matcher, options, meta?.name ?? extensionName);
      },
    };
  }

  private _register(
    matcher: RecoveryMatcher,
    options: RecoveryClaimOptions,
    name: string,
  ): void {
    if (!Number.isInteger(options.attempts) || options.attempts < 1) {
      throw new ConfigError(
        `recovery.claim "${name}" has attempts=${String(options.attempts)}; ` +
          `attempts must be an integer >= 1 (it is the hard retry cap).`,
      );
    }
    this._claims.push({
      matcher,
      attempts: options.attempts,
      backoffMs: options.backoffMs,
      recover: options.recover,
      name,
    });
  }

  /**
   * Boot-time check (non-fatal): warn when a broad error-class claim is
   * registered before a claim for one of its subclasses. The broad claim wins
   * first and, unless it returns `unhandled`, the narrower claim never runs.
   */
  validate(): void {
    const classClaims = this._claims.filter((c) => isErrorClass(c.matcher));
    for (let a = 0; a < classClaims.length; a++) {
      const broad = classClaims[a].matcher as ErrorClass;
      for (let b = a + 1; b < classClaims.length; b++) {
        const narrow = classClaims[b].matcher as ErrorClass;
        if (narrow.prototype instanceof broad) {
          console.warn(
            `[openharness] recovery.claim "${classClaims[a].name}" for ` +
              `${broad.name} is registered before "${classClaims[b].name}" for ` +
              `its subclass ${narrow.name}; the broader claim shadows it unless ` +
              `it returns { action: "unhandled" }.`,
          );
        }
      }
    }
  }

  /**
   * Run `task` under the registered claims. On the first attempt — and on every
   * retry — `task` is invoked fresh; a thrown error is matched against the
   * claims and the resulting decision is honoured (retry with backoff, fail with
   * the original error, fail with a transformed error, or fall through).
   *
   * `attempt` is 1-based: attempt 1 is the original run. A claim's `attempts` is
   * a hard ceiling on total runs.
   */
  async run<T>(
    task: () => Promise<T>,
    ctx: StepContext,
    hooks: RecoveryRunHooks,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      attempt++;
      const snapshot = hooks.eventCount();
      try {
        return await task();
      } catch (err) {
        // The human-approval barrier and abort are never recoverable: they are
        // control flow, not failure. Surface them untouched.
        if (hooks.isBypass(err)) throw err;
        const error = err instanceof Error ? err : new Error(String(err));

        const decision = await this._decide(error, ctx, attempt);
        if (decision === null) throw error; // no claim owns it

        const claimName = decision.claim.name;
        const cap = decision.claim.attempts;

        if (decision.kind === "default") {
          // No `recover`: retry up to the cap, then rethrow the original.
          if (attempt >= cap) {
            hooks.onExhausted({ attempts: attempt, error, claimName });
            throw error;
          }
          // Retry-safety guard: a default retry must replay a clean slate. If
          // the conversation grew during this attempt, a blind replay would
          // duplicate work — refuse and propagate.
          if (hooks.eventCount() !== snapshot) {
            hooks.onExhausted({ attempts: attempt, error, claimName });
            throw error;
          }
          await this._backoff(hooks, decision.claim, attempt + 1, error);
          hooks.onRetry({ attempt: attempt + 1, error, claimName });
          continue;
        }

        // `recover` returned an explicit outcome (never `unhandled` here —
        // _decide consumes those by falling through to the next claim).
        const outcome = decision.outcome;
        if (outcome.action === "retry") {
          if (attempt >= cap) {
            hooks.onExhausted({ attempts: attempt, error, claimName });
            throw error;
          }
          // recover-driven retries opt out of the guard: the hook is presumed
          // to have mutated the conversation on purpose. The next iteration
          // re-snapshots, so the guard tracks the post-recover state.
          await this._backoff(
            hooks,
            decision.claim,
            attempt + 1,
            error,
            outcome.afterMs,
          );
          hooks.onRetry({ attempt: attempt + 1, error, claimName });
          continue;
        }

        // action === "fail": stop. Propagate the transformed error if given,
        // otherwise the original.
        const finalError =
          "throw" in outcome && outcome.throw ? outcome.throw : error;
        hooks.onExhausted({ attempts: attempt, error: finalError, claimName });
        throw finalError;
      }
    }
  }

  /**
   * Walk claims in registration order; the first matcher that matches decides.
   * A `recover` returning `unhandled` declines, so we keep walking. Returns
   * `null` when no claim owns the error.
   */
  private async _decide(
    error: Error,
    ctx: StepContext,
    attempt: number,
  ): Promise<Decision | null> {
    for (const claim of this._claims) {
      if (!matcherMatches(claim.matcher, error, ctx)) continue;
      if (!claim.recover) return { kind: "default", claim };
      const outcome = await claim.recover(error, ctx, { attempt });
      if (outcome.action === "unhandled") continue;
      return { kind: "outcome", claim, outcome };
    }
    return null;
  }

  private async _backoff(
    hooks: RecoveryRunHooks,
    claim: RegisteredClaim,
    nextAttempt: number,
    error: unknown,
    override?: number,
  ): Promise<void> {
    const ms =
      override !== undefined
        ? override
        : typeof claim.backoffMs === "function"
          ? claim.backoffMs(nextAttempt, error)
          : (claim.backoffMs ?? 0);
    if (ms > 0) await hooks.sleep(ms);
  }
}

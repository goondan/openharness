import type { StepContext } from "./middleware.js";

// -----------------------------------------------------------------------
// Error ownership — recovery.claim (F4)
//
// Instead of every extension wrapping the LLM/tool loop in its own try/catch
// (the convention that produced Karby's non-local error handling), an
// extension *claims* a class of error and declares how the core dispatcher
// should recover. The dispatcher owns the retry loop; the claim owns the
// decision.
// -----------------------------------------------------------------------

/** Constructor side of an error class, for `matcher = SomeError`. */
// biome-ignore lint/suspicious/noExplicitAny: error constructors are variadic
export type ErrorClass = new (...args: any[]) => Error;

/**
 * Selects which errors a claim handles.
 *
 * - An error class matches by `instanceof`.
 * - A predicate gets the live {@link StepContext}, so a claim can match on
 *   conversation state as well as the error (e.g. "429 *and* we already
 *   retried this conversation twice").
 */
export type RecoveryMatcher =
  | ErrorClass
  | ((error: unknown, ctx: StepContext) => boolean);

/** Per-attempt info passed to `recover`. `attempt` is 1-based. */
export interface RecoveryInfo {
  attempt: number;
}

/**
 * What `recover` tells the dispatcher to do next.
 *
 * - `retry` — the recover hook has (optionally) mutated the conversation;
 *   run the LLM/tool loop again. `afterMs` overrides backoff for this attempt.
 * - `fail` — stop; rethrow the original error (exhausted / unrecoverable).
 * - `fail` with `throw` — stop; propagate a *transformed* error instead of the
 *   original (e.g. 429 → `RateLimitExhaustedError` for a downstream consumer).
 * - `unhandled` — this claim declines; control passes to the next matching
 *   claim, or propagates if none remain.
 */
export type RecoveryOutcome =
  | { action: "retry"; afterMs?: number }
  | { action: "fail" }
  | { action: "fail"; throw: Error }
  | { action: "unhandled" };

export interface RecoveryClaimOptions {
  /**
   * Maximum attempts (including the first). Always visible — there is no
   * hidden default. Required unless `recover` is supplied and drives the loop
   * itself via `retry`/`fail`.
   */
  attempts: number;
  /**
   * Delay before a retry. A function receives the upcoming 1-based attempt and
   * the error. Backoff is abortable via the turn's abort signal.
   */
  backoffMs?: number | ((attempt: number, error: unknown) => number);
  /**
   * Decide what to do with a matched error. Omit to get the default behaviour:
   * retry up to `attempts`, then rethrow the original error. The dispatcher
   * refuses a *default* retry if the conversation changed during the attempt
   * (see the retry-safety guard); a `recover` that intentionally mutates and
   * returns `retry` opts out of that guard.
   */
  recover?: (
    error: unknown,
    ctx: StepContext,
    info: RecoveryInfo,
  ) => RecoveryOutcome | Promise<RecoveryOutcome>;
}

export interface RecoveryClaimMeta {
  /** Distinguishes claims in diagnostics; defaults to the extension name. */
  name?: string;
}

/**
 * Extension-facing surface for claiming errors. Registration order decides
 * precedence: the first claim whose matcher matches wins, unless it returns
 * `unhandled`, in which case the next matching claim is tried.
 *
 * Only available on the agent-scoped extension API — connection-level claims
 * are a registration error (there is no LLM/tool loop to recover).
 */
export interface RecoveryApi {
  claim(
    matcher: RecoveryMatcher,
    options: RecoveryClaimOptions,
    meta?: RecoveryClaimMeta,
  ): void;
}

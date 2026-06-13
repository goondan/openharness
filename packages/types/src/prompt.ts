import type { Message } from "./conversation.js";
import type { StepContext } from "./middleware.js";

// -----------------------------------------------------------------------
// Durable log / prompt view separation (F2)
//
// The conversation event log is the durable truth. The *prompt view* is a
// per-step, throwaway rendering of that truth for the model — windowing,
// hydration, redaction, reordering. A projection never persists; if a
// projection ran zero times the durable log would still be correct. (If it
// wouldn't be, that transform is a `conversation.emit` mutation, not a
// projection.)
// -----------------------------------------------------------------------

/**
 * The messages handed to the model for one step. Frozen and non-persistable
 * by construction — it is derived from `conversation.messages`, never the
 * other way around.
 */
export type PromptView = readonly Message[];

/**
 * Transforms the prompt view for a single step.
 *
 * Re-run on *every* step, including recovery retries, so it MUST be
 * idempotent and side-effect-free with respect to durable state. Expensive
 * work (S3 hydration, network) should be memoized in the `transform()`
 * closure, not redone per call. Async is required because hydration is the
 * representative case.
 *
 * Throwing fails the step loudly — a projection is never silently skipped.
 */
export type PromptProjection = (
  view: PromptView,
  ctx: StepContext,
) => PromptView | Promise<PromptView>;

/**
 * Ordering for a projection relative to others. Semantics match middleware
 * before/after: "A before B" means A runs earlier in the projection pipe.
 * References are projection names; unknown references are a boot error.
 */
export interface PromptTransformOptions {
  before?: string | string[];
  after?: string | string[];
}

/**
 * Extension-facing surface for prompt projections (`api.prompt`).
 *
 * `transform` registers a projection. `apply` computes the current projected
 * view for an arbitrary message set outside a step (compaction / prewarm need
 * the rendered view without running a turn) — it runs the same registered
 * pipeline and enforces the same view invariants.
 */
export interface PromptApi {
  transform(
    name: string,
    projection: PromptProjection,
    options?: PromptTransformOptions,
  ): void;
  apply(
    messages: readonly Message[],
    ctx: StepContext,
  ): Promise<PromptView>;
}

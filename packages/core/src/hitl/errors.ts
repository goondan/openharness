/**
 * Marker error thrown by `executeStep()` when a chained-HITL spawn (§8.5 step 12.1)
 * succeeds but the post-spawn child preparation (peer tool execution / atomic
 * `markBatchWaitingForHuman` exposure) fails before the child is exposed for human
 * input. After a successful `spawnChildBatch()` the parent has been atomically
 * `completed(spawnedChild)` with its lease released, so `_recordHitlBatchFailure()`
 * MUST NOT re-fail the parent — instead it surfaces the child's current terminal
 * state to the caller.
 *
 * This error is *only* emitted for failures that happened during child
 * preparation. Post-exposure failures (e.g., listener exceptions on
 * `eventBus.emit("hitl.batch.requested")`) must surface unchanged so listener
 * bugs are not silently swallowed.
 */
export class ChainedChildPrepFailureError extends Error {
  readonly cause: Error;

  constructor(cause: Error) {
    super(cause.message);
    this.name = "ChainedChildPrepFailureError";
    this.cause = cause;
  }
}

export function isChainedChildPrepFailureError(
  error: unknown,
): error is ChainedChildPrepFailureError {
  return error instanceof ChainedChildPrepFailureError;
}

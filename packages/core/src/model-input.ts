/**
 * Model-input assembly registry (`useModelInput`).
 *
 * `useModelInput` is a single throwaway pipe applied once per step, immediately
 * before the model call, to the `getMessages()` snapshot. It is pure with
 * respect to durable state and never touches `conversation`. Unlike the onion
 * middleware, it has no before/after topology — there is one ordered pipe and
 * registration order is application order. So there is no cycle to detect and no
 * validation beyond running it.
 */
import type {
  Message,
  ModelInput,
  ModelInputMiddleware,
  StepContext,
} from "@goondan/openharness-types";

export class ModelInputRegistry {
  private readonly _fns: ModelInputMiddleware[] = [];

  /** Register a model-input transform. Registration order = application order. */
  register(fn: ModelInputMiddleware): void {
    this._fns.push(fn);
  }

  /** True when no transform is registered — callers can skip the apply pass. */
  get isEmpty(): boolean {
    return this._fns.length === 0;
  }

  /**
   * Apply every registered transform in order, once. Runs at the end of the step
   * onion, immediately before the model call. Pure and non-persisting — the
   * input is the frozen `getMessages()` snapshot and `conversation` is never
   * touched.
   */
  async apply(messages: readonly Message[], ctx: StepContext): Promise<ModelInput> {
    let view: ModelInput = messages;
    for (const fn of this._fns) {
      view = await fn(view, ctx);
    }
    return view;
  }
}

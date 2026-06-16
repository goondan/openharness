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
import type { WrapCtxFor } from "./execution/store-injection.js";

interface ModelInputEntry {
  fn: ModelInputMiddleware;
  /** The registering extension's name — used to scope this transform's `ctx.store`. */
  owner: string | undefined;
}

export class ModelInputRegistry {
  private readonly _entries: ModelInputEntry[] = [];

  /**
   * Register a model-input transform. Registration order = application order.
   * `owner` is the registering extension's name; it scopes the transform's
   * `ctx.store` so two `useModelInput` extensions never collide on store keys.
   */
  register(fn: ModelInputMiddleware, owner?: string): void {
    this._entries.push({ fn, owner });
  }

  /** True when no transform is registered — callers can skip the apply pass. */
  get isEmpty(): boolean {
    return this._entries.length === 0;
  }

  /**
   * Apply every registered transform in order, once. Runs at the end of the step
   * onion, immediately before the model call. Pure and non-persisting — the input
   * is the frozen `getMessages()` snapshot and `conversation` is read-only
   * (`ModelInputContext`). Each transform receives a `ctx.store` scoped to *its*
   * registering extension via `wrapCtxFor`, matching the onion middleware.
   */
  async apply(
    messages: readonly Message[],
    ctx: StepContext,
    wrapCtxFor?: WrapCtxFor<StepContext>,
  ): Promise<ModelInput> {
    let view: ModelInput = messages;
    for (const { fn, owner } of this._entries) {
      const transform = wrapCtxFor?.(owner, owner ?? "");
      const fnCtx: StepContext = transform ? transform(ctx) : ctx;
      view = await fn(view, fnCtx);
    }
    return view;
  }
}

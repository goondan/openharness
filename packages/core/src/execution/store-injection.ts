/**
 * Per-layer `ctx.store` injection for middleware chains.
 *
 * `store` is conversation-scoped, but extensions register once at boot. The
 * core bridges the gap: each middleware layer is wrapped with a `ctx.store`
 * view scoped to `(registering extension × conversationId)`. A layer with no
 * registering extension (or the core handler itself) gets the conversation's
 * default scoped store.
 *
 * This reuses the middleware-chain `wrapCtxFor` hook — the same per-layer ctx
 * transform mechanism the contracts draft used for slot facades, minus the slot
 * declarations.
 */
import type { ExtensionStore } from "@goondan/openharness-types";
import type { StoreBacking } from "../store.js";
import { createScopedStore } from "../store.js";

/** A per-layer ctx transform keyed by the registering extension's identity. */
export type WrapCtxFor<Ctx> = (
  extensionName: string | undefined,
  name: string,
) => ((ctx: Ctx) => Ctx) | undefined;

const DEFAULT_STORE_OWNER = "core";

/**
 * Build a `wrapCtxFor` that injects a `store` scoped to the registering
 * extension. Scoped stores are memoized per extension name for the
 * conversation's lifetime so repeated chain builds reuse one view.
 */
export function makeStoreWrapCtxFor<Ctx extends { store: ExtensionStore }>(
  backing: StoreBacking,
  conversationId: string,
): WrapCtxFor<Ctx> {
  const cache = new Map<string, ExtensionStore>();
  const storeFor = (owner: string): ExtensionStore => {
    let scoped = cache.get(owner);
    if (!scoped) {
      scoped = createScopedStore(backing, owner, conversationId);
      cache.set(owner, scoped);
    }
    return scoped;
  };

  return (extensionName, name) => {
    const owner = extensionName ?? name ?? DEFAULT_STORE_OWNER;
    const store = storeFor(owner);
    return (ctx: Ctx): Ctx => ({ ...ctx, store });
  };
}

/**
 * The default conversation-scoped store, owned by `"core"`. Used to seed
 * `ctx.store` on the base context before any per-layer wrapping, so the core
 * handler and unscoped layers always have a usable store.
 */
export function createDefaultStore(
  backing: StoreBacking,
  conversationId: string,
): ExtensionStore {
  return createScopedStore(backing, DEFAULT_STORE_OWNER, conversationId);
}

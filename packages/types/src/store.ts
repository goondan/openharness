// -----------------------------------------------------------------------
// ExtensionStore — conversation-scoped persistent KV
//
// Automatically namespaced by (extension name × conversationId): the core
// scopes every key, so extensions only ever pass plain keys. Reachable only
// through `ctx.store` (never captured at register time) — `store` is
// conversation-scoped while `register` runs once at boot, and the type keeps
// those timelines from being conflated. The host injects the backing
// (memory / Redis / MySQL); the core enforces the namespace.
//
// Non-goal (by design): global/tenant storage. Scope stops at the conversation.
// -----------------------------------------------------------------------

export interface ExtensionStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/**
 * Host-injected backing for {@link ExtensionStore}. The core flattens
 * `(extension × conversation × key)` into a single namespaced key before
 * calling it, so a backing implementation only ever sees opaque namespaced
 * strings. The host wires a memory / Redis / MySQL implementation via
 * `HarnessConfig.store.backing`; the default is in-memory.
 */
export interface StoreBacking {
  get(namespacedKey: string): Promise<unknown>;
  set(namespacedKey: string, value: unknown): Promise<void>;
  delete(namespacedKey: string): Promise<void>;
  /** Return every stored key that begins with `prefix` (prefix included). */
  keysWithPrefix(prefix: string): Promise<readonly string[]>;
}

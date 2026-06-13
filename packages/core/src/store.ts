/**
 * Conversation-scoped persistent KV store.
 *
 * The host injects a {@link StoreBacking} (memory / Redis / MySQL). The core
 * scopes every access by `(extension name × conversationId × key)` so an
 * extension only ever passes a plain key — it can never reach another
 * extension's data or another conversation's data.
 *
 * Non-goal (by design): global/tenant storage. Scope stops at the conversation.
 */
import type { ExtensionStore, StoreBacking } from "@goondan/openharness-types";

// `StoreBacking` is the host-facing injection contract; it lives in the types
// package (alongside `HarnessConfig.store`). Re-export it here so core consumers
// can import it from `@goondan/openharness-core` too.
export type { StoreBacking } from "@goondan/openharness-types";

const SEP = "::";

/**
 * Build the namespace prefix `${extensionName}::${conversationId}::`.
 *
 * The components are percent-encoded so a `::` inside an extension name or a
 * conversation id can't shift the namespace boundary (e.g. ext "a" / conv "b::c"
 * would otherwise collide with ext "a::b" / conv "c"). The trailing key is
 * appended raw and recovered by slicing this fixed prefix, so it needs no encoding.
 */
function prefixFor(extensionName: string, conversationId: string): string {
  return `${encodeURIComponent(extensionName)}${SEP}${encodeURIComponent(conversationId)}${SEP}`;
}

/** In-memory backing — the default when the host injects none. */
export function createMemoryStoreBacking(): StoreBacking {
  const map = new Map<string, unknown>();
  return {
    get(namespacedKey: string): Promise<unknown> {
      return Promise.resolve(map.get(namespacedKey));
    },
    set(namespacedKey: string, value: unknown): Promise<void> {
      map.set(namespacedKey, value);
      return Promise.resolve();
    },
    delete(namespacedKey: string): Promise<void> {
      map.delete(namespacedKey);
      return Promise.resolve();
    },
    keysWithPrefix(prefix: string): Promise<readonly string[]> {
      const out: string[] = [];
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) out.push(key);
      }
      return Promise.resolve(out);
    },
  };
}

/**
 * Create an {@link ExtensionStore} view scoped to `(extensionName,
 * conversationId)`. Built at ctx-injection time, since the conversationId is
 * only known per turn. `keys()` returns plain (de-namespaced) keys.
 */
export function createScopedStore(
  backing: StoreBacking,
  extensionName: string,
  conversationId: string,
): ExtensionStore {
  const prefix = prefixFor(extensionName, conversationId);
  const ns = (key: string): string => `${prefix}${key}`;

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const value = await backing.get(ns(key));
      return value as T | undefined;
    },
    set<T = unknown>(key: string, value: T): Promise<void> {
      return backing.set(ns(key), value);
    },
    delete(key: string): Promise<void> {
      return backing.delete(ns(key));
    },
    async keys(): Promise<readonly string[]> {
      const namespaced = await backing.keysWithPrefix(prefix);
      return namespaced.map((k) => k.slice(prefix.length));
    },
  };
}

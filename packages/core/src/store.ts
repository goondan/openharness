/**
 * Conversation-scoped persistent KV store.
 *
 * The host injects a {@link StoreBacking} (memory / Redis / MySQL). The core
 * scopes every access by `(agent name × extension name × conversationId × key)`
 * so an extension only ever passes a plain key — it can never reach another
 * extension's data, another conversation's data, or another agent's data. The
 * agent name matters because the runtime keeps conversation *state* separate per
 * `(agentName × conversationId)`, so two agents on the same conversation must not
 * share an extension's store either.
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
 * Build the namespace prefix `${agentName}::${extensionName}::${conversationId}::`.
 *
 * The components are percent-encoded so a `::` inside any component can't shift
 * the namespace boundary. The trailing key is appended raw and recovered by
 * slicing this fixed prefix, so it needs no encoding.
 */
function prefixFor(agentName: string, extensionName: string, conversationId: string): string {
  return `${encodeURIComponent(agentName)}${SEP}${encodeURIComponent(extensionName)}${SEP}${encodeURIComponent(conversationId)}${SEP}`;
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
 * Create an {@link ExtensionStore} view scoped to `(agentName, extensionName,
 * conversationId)`. Built at ctx-injection time, since the agentName/conversationId
 * are only known per turn. `keys()` returns plain (de-namespaced) keys.
 */
export function createScopedStore(
  backing: StoreBacking,
  agentName: string,
  extensionName: string,
  conversationId: string,
): ExtensionStore {
  const prefix = prefixFor(agentName, extensionName, conversationId);
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

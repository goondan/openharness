import { describe, it, expect } from "vitest";
import { createMemoryStoreBacking, createScopedStore } from "../store.js";

describe("scoped store", () => {
  it("round-trips values under a plain key", async () => {
    const backing = createMemoryStoreBacking();
    const store = createScopedStore(backing, "ext", "conv-1");

    expect(await store.get("k")).toBeUndefined();
    await store.set("k", { n: 1 });
    expect(await store.get<{ n: number }>("k")).toEqual({ n: 1 });

    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("isolates by extension name", async () => {
    const backing = createMemoryStoreBacking();
    const a = createScopedStore(backing, "ext-a", "conv-1");
    const b = createScopedStore(backing, "ext-b", "conv-1");

    await a.set("shared", "from-a");
    expect(await b.get("shared")).toBeUndefined();
    expect(await a.get("shared")).toBe("from-a");
  });

  it("isolates by conversationId", async () => {
    const backing = createMemoryStoreBacking();
    const c1 = createScopedStore(backing, "ext", "conv-1");
    const c2 = createScopedStore(backing, "ext", "conv-2");

    await c1.set("k", "v1");
    expect(await c2.get("k")).toBeUndefined();
    expect(await c1.get("k")).toBe("v1");
  });

  it("keys() returns plain (de-namespaced) keys within scope", async () => {
    const backing = createMemoryStoreBacking();
    const store = createScopedStore(backing, "ext", "conv-1");
    const other = createScopedStore(backing, "ext", "conv-2");

    await store.set("a", 1);
    await store.set("b", 2);
    await other.set("c", 3);

    const keys = [...(await store.keys())].sort();
    expect(keys).toEqual(["a", "b"]);
  });
});

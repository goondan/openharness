import { describe, it, expect } from "vitest";
import {
  SlotBackingStore,
  EMPTY_SLOT_DECLARATION,
  emptySlotStore,
  type SlotDeclaration,
} from "../slot-store.js";
import { SlotAccessError, SlotUnsetError } from "../errors.js";
import { createSlot } from "@goondan/openharness-types";

const TOKEN = createSlot<string>("auth.token");
const COUNT = createSlot<number>("retry.count");

// Build a declaration that mirrors how normalize() derives one from a
// middleware's provides/consumes/consumesOptional.
function decl(parts: Partial<SlotDeclaration>): SlotDeclaration {
  return {
    gettable: parts.gettable ?? new Set(),
    readable: parts.readable ?? new Set(),
    writable: parts.writable ?? new Set(),
  };
}

describe("SlotStore facade — declaration gate (F6)", () => {
  it("get() returns the value for a declared, set slot", () => {
    const backing = new SlotBackingStore();
    const provider = backing.facadeFor(decl({ writable: new Set([TOKEN.id]) }));
    const consumer = backing.facadeFor(decl({ gettable: new Set([TOKEN.id]) }));

    provider.set(TOKEN, "secret");
    expect(consumer.get(TOKEN)).toBe("secret");
  });

  it("get() on an undeclared slot throws SlotAccessError", () => {
    const backing = new SlotBackingStore();
    backing.facadeFor(decl({ writable: new Set([TOKEN.id]) })).set(TOKEN, "x");
    const stranger = backing.facadeFor(EMPTY_SLOT_DECLARATION);
    expect(() => stranger.get(TOKEN)).toThrow(SlotAccessError);
    expect(() => stranger.get(TOKEN)).toThrow(/not declared/);
  });

  it("get() on a declared but unset slot throws SlotUnsetError with a set-before-get hint", () => {
    const backing = new SlotBackingStore();
    const consumer = backing.facadeFor(decl({ gettable: new Set([TOKEN.id]) }));
    expect(() => consumer.get(TOKEN)).toThrow(SlotUnsetError);
    expect(() => consumer.get(TOKEN)).toThrow(/BEFORE calling next/);
  });

  it("tryGet() returns the value when set and undefined when unset, for a readable slot", () => {
    const backing = new SlotBackingStore();
    const reader = backing.facadeFor(decl({ readable: new Set([TOKEN.id]) }));
    expect(reader.tryGet(TOKEN)).toBeUndefined();

    backing.facadeFor(decl({ writable: new Set([TOKEN.id]) })).set(TOKEN, "v");
    expect(reader.tryGet(TOKEN)).toBe("v");
  });

  it("tryGet() on an undeclared slot throws SlotAccessError", () => {
    const backing = new SlotBackingStore();
    const stranger = backing.facadeFor(EMPTY_SLOT_DECLARATION);
    expect(() => stranger.tryGet(TOKEN)).toThrow(SlotAccessError);
    expect(() => stranger.tryGet(TOKEN)).toThrow(
      /consumes.*consumesOptional/s,
    );
  });

  it("set() on an undeclared slot throws SlotAccessError", () => {
    const backing = new SlotBackingStore();
    const consumer = backing.facadeFor(decl({ gettable: new Set([TOKEN.id]) }));
    // gettable, not writable → cannot set.
    expect(() => consumer.set(TOKEN, "nope")).toThrow(SlotAccessError);
    expect(() => consumer.set(TOKEN, "nope")).toThrow(/provides/);
  });

  it("a gettable slot is not implicitly readable-only; the gate is per-operation", () => {
    const backing = new SlotBackingStore();
    // Declared gettable but NOT readable: tryGet must still be gated by readable.
    const consumer = backing.facadeFor(decl({ gettable: new Set([TOKEN.id]) }));
    expect(() => consumer.tryGet(TOKEN)).toThrow(SlotAccessError);
  });
});

describe("SlotStore facade — backing store sharing", () => {
  it("propagates a value written by one facade to another over the same backing", () => {
    const backing = new SlotBackingStore();
    const writer = backing.facadeFor(decl({ writable: new Set([COUNT.id]) }));
    const reader = backing.facadeFor(decl({ gettable: new Set([COUNT.id]) }));

    expect(backing.has(COUNT.id)).toBe(false);
    writer.set(COUNT, 3);
    expect(backing.has(COUNT.id)).toBe(true);
    expect(reader.get(COUNT)).toBe(3);
  });

  it("isolates separate backing stores", () => {
    const a = new SlotBackingStore();
    const b = new SlotBackingStore();
    a.facadeFor(decl({ writable: new Set([TOKEN.id]) })).set(TOKEN, "a-only");
    expect(b.has(TOKEN.id)).toBe(false);
  });
});

describe("emptySlotStore", () => {
  it("denies every operation", () => {
    const store = emptySlotStore();
    expect(() => store.get(TOKEN)).toThrow(SlotAccessError);
    expect(() => store.tryGet(TOKEN)).toThrow(SlotAccessError);
    expect(() => store.set(TOKEN, "x")).toThrow(SlotAccessError);
  });
});

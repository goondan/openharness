import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { Message, MessageEvent } from "@goondan/openharness-types";
import {
  CREATED_BY_METADATA_KEY,
  CORE_CREATED_BY,
  UNKNOWN_CREATED_BY,
  getCreatedBy,
  isSynthetic,
} from "@goondan/openharness-types";
import { createConversationState } from "../index.js";

// ---------------------------------------------------------------------------
// 0.5 legacy event-log replay (persisted read-compat).
//
// The fixture is a checked-in 0.5 log: every message carries provenance only in
// `metadata.__createdBy` — there is no first-class `createdBy` field (one orphan
// message has neither, modelling pre-provenance 0.5 data). Replaying it through
// the 1.0 ConversationState must:
//   1. lift `createdBy` onto the *derived* `getMessages()` view, and
//   2. keep `getEventLog()` byte-identical to the original on-disk log
//      (lifting touches only the derived view, never `_events`).
// ---------------------------------------------------------------------------

const FIXTURE_URL = new URL("./fixtures/legacy-0.5-event-log.json", import.meta.url);
const FIXTURE_PATH = fileURLToPath(FIXTURE_URL);
const RAW_FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

function loadLegacyEvents(): MessageEvent[] {
  return JSON.parse(RAW_FIXTURE) as MessageEvent[];
}

describe("0.5 legacy event-log replay", () => {
  it("the fixture itself has no createdBy field — provenance lives only in metadata", () => {
    const events = loadLegacyEvents();
    for (const event of events) {
      if (event.type === "appendSystem" || event.type === "appendMessage") {
        expect(event.message.createdBy).toBeUndefined();
      }
    }
  });

  it("lifts createdBy from metadata.__createdBy into the derived getMessages() view", () => {
    const state = createConversationState();
    state.restore(loadLegacyEvents());

    const byId = new Map(state.getMessages().map((m) => [m.id, m] as const));

    expect(byId.get("sys-basic-system-prompt")?.createdBy).toBe("basic-system-prompt");
    expect(byId.get("u1")?.createdBy).toBe(CORE_CREATED_BY);
    expect(byId.get("a1")?.createdBy).toBe(CORE_CREATED_BY);
    expect(byId.get("t1")?.createdBy).toBe(CORE_CREATED_BY);
    expect(byId.get("compaction-1")?.createdBy).toBe("compaction-summarize");

    // getCreatedBy agrees with the lifted field.
    expect(getCreatedBy(byId.get("compaction-1") as Message)).toBe("compaction-summarize");
  });

  it("a pre-provenance message (no field, no metadata) resolves to unknown / non-synthetic", () => {
    const state = createConversationState();
    state.restore(loadLegacyEvents());

    const orphan = state.getMessages().find((m) => m.id === "orphan-1") as Message;
    expect(orphan.createdBy).toBeUndefined();
    expect(getCreatedBy(orphan)).toBe(UNKNOWN_CREATED_BY);
    // unknown counts as non-synthetic — a safe default so old logs are never
    // mistakenly stripped by synthetic-message filters.
    expect(isSynthetic(orphan)).toBe(false);
  });

  it("classifies synthetic vs. core messages from lifted legacy provenance", () => {
    const state = createConversationState();
    state.restore(loadLegacyEvents());

    const byId = new Map(state.getMessages().map((m) => [m.id, m] as const));

    // Extension-authored messages are synthetic.
    expect(isSynthetic(byId.get("sys-basic-system-prompt") as Message)).toBe(true);
    expect(isSynthetic(byId.get("compaction-1") as Message)).toBe(true);
    // Core conversational flow is NOT synthetic.
    expect(isSynthetic(byId.get("u1") as Message)).toBe(false);
    expect(isSynthetic(byId.get("a1") as Message)).toBe(false);
  });

  it("keeps getEventLog() bytes invariant — _events match the original 0.5 log", () => {
    const state = createConversationState();
    state.restore(loadLegacyEvents());

    const log = state.getEventLog();

    // No event-log message ever gains a createdBy field from lifting.
    for (const event of log) {
      if (event.type === "appendSystem" || event.type === "appendMessage") {
        expect(event.message.createdBy).toBeUndefined();
        // The mirror metadata is untouched too.
        if (event.message.id !== "orphan-1") {
          expect(event.message.metadata?.[CREATED_BY_METADATA_KEY]).toBeDefined();
        }
      }
    }

    // Round-tripping the *parsed* fixture through replay and re-serializing
    // yields the same structure the parsed fixture had: lifting never leaks
    // into the persisted log. (We compare parsed structures rather than raw
    // text so insignificant on-disk whitespace is not load-bearing.)
    expect(JSON.parse(JSON.stringify(log))).toEqual(loadLegacyEvents());
  });

  it("getEventLog() is byte-identical to the parsed-then-restringified original", () => {
    const original = loadLegacyEvents();
    const before = JSON.stringify(original);

    const state = createConversationState();
    state.restore(original);

    // Serializing the event log reproduces the original 0.5 bytes exactly.
    expect(JSON.stringify(state.getEventLog())).toBe(before);
  });

  it("derived messages are a distinct, frozen snapshot — source events stay shared & unlifted", () => {
    const events = loadLegacyEvents();
    const state = createConversationState();
    state.restore(events);

    const derived = state.getMessages();
    expect(Object.isFrozen(derived)).toBe(true);

    const loggedSys = state.getEventLog()[0] as Extract<
      MessageEvent,
      { type: "appendSystem" }
    >;
    const derivedSys = derived.find((m) => m.id === "sys-basic-system-prompt") as Message;

    // The derived (lifted) object is a different identity from the logged one.
    expect(loggedSys.message).not.toBe(derivedSys);
    expect(loggedSys.message.createdBy).toBeUndefined();
    expect(derivedSys.createdBy).toBe("basic-system-prompt");
  });
});

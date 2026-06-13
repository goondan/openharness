import { describe, it, expect } from "vitest";
import {
  createMessage,
  getCreatedBy,
  isCreatedBy,
  isSynthetic,
  CORE_CREATED_BY,
  UNKNOWN_CREATED_BY,
  CREATED_BY_METADATA_KEY,
  type Message,
  type MessageEvent,
} from "@goondan/openharness-types";
import { ConversationStateImpl, replay } from "../conversation-state.js";

describe("createMessage (F3)", () => {
  it("sets the createdBy field and mirrors it into metadata.__createdBy", () => {
    const m = createMessage({
      id: "m1",
      data: { role: "user", content: "hi" },
      createdBy: "my-ext",
    });
    expect(m.createdBy).toBe("my-ext");
    expect(m.metadata?.[CREATED_BY_METADATA_KEY]).toBe("my-ext");
  });

  it("ignores an incoming metadata.__createdBy — the explicit argument wins", () => {
    const m = createMessage({
      data: { role: "user", content: "hi" },
      createdBy: "real-author",
      metadata: { [CREATED_BY_METADATA_KEY]: "spoofed", keep: 1 },
    });
    expect(m.createdBy).toBe("real-author");
    expect(m.metadata?.[CREATED_BY_METADATA_KEY]).toBe("real-author");
    expect(m.metadata?.keep).toBe(1); // other metadata preserved
  });

  it("generates a UUID id when none is supplied", () => {
    const m = createMessage({
      data: { role: "user", content: "hi" },
      createdBy: "x",
    });
    expect(typeof m.id).toBe("string");
    expect(m.id.length).toBeGreaterThan(0);
  });
});

describe("getCreatedBy / isCreatedBy", () => {
  it("prefers the field", () => {
    const m: Message = {
      id: "m",
      data: { role: "user", content: "hi" },
      createdBy: "field-author",
      metadata: { [CREATED_BY_METADATA_KEY]: "meta-author" },
    };
    expect(getCreatedBy(m)).toBe("field-author");
  });

  it("falls back to the mirrored metadata when the field is absent", () => {
    const m: Message = {
      id: "m",
      data: { role: "user", content: "hi" },
      metadata: { [CREATED_BY_METADATA_KEY]: "meta-author" },
    };
    expect(getCreatedBy(m)).toBe("meta-author");
  });

  it("returns UNKNOWN_CREATED_BY for a legacy message with no provenance", () => {
    const m: Message = { id: "m", data: { role: "user", content: "hi" } };
    expect(getCreatedBy(m)).toBe(UNKNOWN_CREATED_BY);
  });

  it("isCreatedBy compares the resolved author", () => {
    const m = createMessage({
      data: { role: "user", content: "hi" },
      createdBy: "ext",
    });
    expect(isCreatedBy(m, "ext")).toBe(true);
    expect(isCreatedBy(m, "other")).toBe(false);
  });
});

describe("isSynthetic", () => {
  it("treats an extension-authored message as synthetic", () => {
    const m = createMessage({
      data: { role: "user", content: "hi" },
      createdBy: "compaction",
    });
    expect(isSynthetic(m)).toBe(true);
  });

  it("treats core-authored messages as non-synthetic", () => {
    const m = createMessage({
      data: { role: "assistant", content: "hi" },
      createdBy: CORE_CREATED_BY,
    });
    expect(isSynthetic(m)).toBe(false);
  });

  it("treats legacy (unknown) messages as non-synthetic — the safe default", () => {
    const m: Message = { id: "m", data: { role: "user", content: "hi" } };
    expect(isSynthetic(m)).toBe(false);
  });
});

describe("0.5 legacy log replay (read-compatibility)", () => {
  // A pre-F3 event log: messages carry no createdBy field and no mirrored
  // metadata. The 1.0 runtime must replay these byte-for-byte and treat their
  // authorship as unknown — never injecting provenance into persisted events.
  const legacyEvents: MessageEvent[] = [
    {
      type: "appendSystem",
      message: { id: "s1", data: { role: "system", content: "You are a bot." } },
    },
    {
      type: "appendMessage",
      message: { id: "u1", data: { role: "user", content: "hello" } },
    },
    {
      type: "appendMessage",
      message: { id: "a1", data: { role: "assistant", content: "hi there" } },
    },
  ];

  it("replays legacy events without mutating their bytes", () => {
    const before = JSON.stringify(legacyEvents);
    const state = new ConversationStateImpl();
    state.restore(legacyEvents);

    // The persisted events are unchanged — no createdBy lifted into _events.
    expect(JSON.stringify(state.events)).toBe(before);
    for (const ev of state.events) {
      if (ev.type === "appendSystem" || ev.type === "appendMessage") {
        expect("createdBy" in ev.message).toBe(false);
        expect(ev.message.metadata).toBeUndefined();
      }
    }
  });

  it("resolves legacy message authorship as unknown and non-synthetic", () => {
    const messages = replay(legacyEvents);
    expect(messages.map((m) => getCreatedBy(m))).toEqual([
      UNKNOWN_CREATED_BY,
      UNKNOWN_CREATED_BY,
      UNKNOWN_CREATED_BY,
    ]);
    expect(messages.every((m) => !isSynthetic(m))).toBe(true);
  });
});

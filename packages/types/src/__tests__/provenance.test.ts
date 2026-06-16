import { describe, it, expect } from "vitest";
import type { Message } from "../conversation.js";
import {
  CORE_CREATED_BY,
  CREATED_BY_METADATA_KEY,
  UNKNOWN_CREATED_BY,
  createMessage,
  getCreatedBy,
  isCreatedBy,
  isSynthetic,
} from "../conversation.js";

// ---------------------------------------------------------------------------
// Provenance helpers — createMessage / getCreatedBy / isCreatedBy / isSynthetic.
//
// `createdBy` is a first-class field; through 1.x it is mirrored into
// `metadata.__createdBy`. The field is authoritative on conflict. `isSynthetic`
// treats `unknown` (legacy) as non-synthetic — a safe default.
// ---------------------------------------------------------------------------

describe("createMessage", () => {
  it("sets the createdBy field and mirrors it into metadata.__createdBy", () => {
    const m = createMessage({
      data: { role: "user", content: "hi" },
      createdBy: "my-ext",
    });

    expect(m.createdBy).toBe("my-ext");
    expect(m.metadata?.[CREATED_BY_METADATA_KEY]).toBe("my-ext");
  });

  it("generates a UUID id when none is given, and honors an explicit id", () => {
    const generated = createMessage({
      data: { role: "user", content: "x" },
      createdBy: "ext",
    });
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/);

    const explicit = createMessage({
      id: "fixed-id",
      data: { role: "user", content: "x" },
      createdBy: "ext",
    });
    expect(explicit.id).toBe("fixed-id");
  });

  it("preserves caller metadata while force-mirroring createdBy", () => {
    const m = createMessage({
      data: { role: "user", content: "x" },
      createdBy: "ext",
      metadata: { trace: "abc", stepNumber: 3 },
    });

    expect(m.metadata).toEqual({
      trace: "abc",
      stepNumber: 3,
      [CREATED_BY_METADATA_KEY]: "ext",
    });
  });

  it("the explicit createdBy argument overrides a conflicting metadata.__createdBy", () => {
    const m = createMessage({
      data: { role: "user", content: "x" },
      createdBy: "winner",
      metadata: { [CREATED_BY_METADATA_KEY]: "loser" },
    });

    expect(m.createdBy).toBe("winner");
    expect(m.metadata?.[CREATED_BY_METADATA_KEY]).toBe("winner");
  });

  it("does not mutate the caller's metadata object", () => {
    const metadata = { trace: "abc" };
    createMessage({
      data: { role: "user", content: "x" },
      createdBy: "ext",
      metadata,
    });
    expect(metadata).toEqual({ trace: "abc" });
    expect(CREATED_BY_METADATA_KEY in metadata).toBe(false);
  });
});

describe("getCreatedBy", () => {
  it("prefers the first-class field", () => {
    const m: Message = {
      id: "1",
      data: { role: "user", content: "x" },
      createdBy: "field",
      metadata: { [CREATED_BY_METADATA_KEY]: "mirror" },
    };
    expect(getCreatedBy(m)).toBe("field");
  });

  it("falls back to the mirrored metadata key when the field is absent (legacy)", () => {
    const m: Message = {
      id: "1",
      data: { role: "user", content: "x" },
      metadata: { [CREATED_BY_METADATA_KEY]: "legacy-ext" },
    };
    expect(getCreatedBy(m)).toBe("legacy-ext");
  });

  it("returns the unknown sentinel when neither field nor metadata is present", () => {
    const m: Message = { id: "1", data: { role: "user", content: "x" } };
    expect(getCreatedBy(m)).toBe(UNKNOWN_CREATED_BY);
  });

  it("ignores a non-string mirrored metadata value", () => {
    const m: Message = {
      id: "1",
      data: { role: "user", content: "x" },
      metadata: { [CREATED_BY_METADATA_KEY]: 42 },
    };
    expect(getCreatedBy(m)).toBe(UNKNOWN_CREATED_BY);
  });
});

describe("isCreatedBy", () => {
  it("matches on the resolved author", () => {
    const core = createMessage({
      data: { role: "user", content: "x" },
      createdBy: CORE_CREATED_BY,
    });
    expect(isCreatedBy(core, CORE_CREATED_BY)).toBe(true);
    expect(isCreatedBy(core, "other")).toBe(false);
  });

  it("matches a legacy message via its mirrored author", () => {
    const m: Message = {
      id: "1",
      data: { role: "user", content: "x" },
      metadata: { [CREATED_BY_METADATA_KEY]: "legacy-ext" },
    };
    expect(isCreatedBy(m, "legacy-ext")).toBe(true);
  });
});

describe("isSynthetic", () => {
  it("is true for extension-authored messages", () => {
    const m = createMessage({
      data: { role: "system", content: "prompt" },
      createdBy: "basic-system-prompt",
    });
    expect(isSynthetic(m)).toBe(true);
  });

  it("is false for core-authored messages", () => {
    const m = createMessage({
      data: { role: "assistant", content: "answer" },
      createdBy: CORE_CREATED_BY,
    });
    expect(isSynthetic(m)).toBe(false);
  });

  it("is false for unknown (legacy) provenance — a safe non-stripping default", () => {
    const m: Message = { id: "1", data: { role: "user", content: "x" } };
    expect(getCreatedBy(m)).toBe(UNKNOWN_CREATED_BY);
    expect(isSynthetic(m)).toBe(false);
  });

  it("classifies a legacy synthetic message via its mirrored author", () => {
    const m: Message = {
      id: "1",
      data: { role: "system", content: "x" },
      metadata: { [CREATED_BY_METADATA_KEY]: "compaction-summarize" },
    };
    expect(isSynthetic(m)).toBe(true);
  });
});

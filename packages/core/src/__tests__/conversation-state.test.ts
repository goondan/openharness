import { describe, it, expect } from "vitest";
import type { Message, MessageEvent } from "@goondan/openharness-types";
import { createConversationState } from "../index.js";

// Helper to create a simple message
function makeMessage(id: string, text: string, role: Message["role"] = "user"): Message {
  return { id, role, content: text };
}

describe("ConversationState", () => {
  // Test 1: append 3 events → messages returns 3 messages in order
  it("append 3 events produces 3 messages in correct order", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "hello");
    const m2 = makeMessage("2", "world");
    const m3 = makeMessage("3", "foo");

    state.emit({ type: "append", message: m1 });
    state.emit({ type: "append", message: m2 });
    state.emit({ type: "append", message: m3 });

    expect(state.messages).toHaveLength(3);
    expect(state.messages[0]).toEqual(m1);
    expect(state.messages[1]).toEqual(m2);
    expect(state.messages[2]).toEqual(m3);
    expect(state.events).toHaveLength(3);
  });

  // Test 2: append 3 + replace 1 → replaced message reflects change
  it("replace event replaces the correct message", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "first");
    const m2 = makeMessage("2", "second");
    const m3 = makeMessage("3", "third");
    const m2replaced = makeMessage("2", "second-replaced");

    state.emit({ type: "append", message: m1 });
    state.emit({ type: "append", message: m2 });
    state.emit({ type: "append", message: m3 });
    state.emit({ type: "replace", messageId: "2", message: m2replaced });

    expect(state.messages).toHaveLength(3);
    expect(state.messages[0]).toEqual(m1);
    expect(state.messages[1]).toEqual(m2replaced);
    expect(state.messages[2]).toEqual(m3);
    expect(state.events).toHaveLength(4);
  });

  // Test 3: append 5 + truncate(keepLast: 3) → only last 3 messages
  it("truncate keeps only last N messages", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    for (let i = 1; i <= 5; i++) {
      state.emit({ type: "append", message: makeMessage(String(i), `msg ${i}`) });
    }
    state.emit({ type: "truncate", keepLast: 3 });

    expect(state.messages).toHaveLength(3);
    expect(state.messages[0].id).toBe("3");
    expect(state.messages[1].id).toBe("4");
    expect(state.messages[2].id).toBe("5");
  });

  // Test 4: remove event removes the correct message
  it("remove event removes the correct message", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "first");
    const m2 = makeMessage("2", "second");
    const m3 = makeMessage("3", "third");

    state.emit({ type: "append", message: m1 });
    state.emit({ type: "append", message: m2 });
    state.emit({ type: "append", message: m3 });
    state.emit({ type: "remove", messageId: "2" });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual(m1);
    expect(state.messages[1]).toEqual(m3);
    expect(state.events).toHaveLength(4);
  });

  // Test 5: invalid reference (replace non-existent ID) → throws error, events unchanged
  it("replace with non-existent ID throws error and leaves events unchanged", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "first");
    state.emit({ type: "append", message: m1 });

    const eventsBefore = state.events.length;

    expect(() => {
      state.emit({ type: "replace", messageId: "nonexistent", message: makeMessage("nonexistent", "new") });
    }).toThrow();

    // Events should be unchanged — no new event was appended
    expect(state.events).toHaveLength(eventsBefore);
    // Messages should be unchanged
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(m1);
  });

  // Test 5b: remove with non-existent ID → throws error, events unchanged
  it("remove with non-existent ID throws error and leaves events unchanged", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "first");
    state.emit({ type: "append", message: m1 });

    const eventsBefore = state.events.length;

    expect(() => {
      state.emit({ type: "remove", messageId: "nonexistent" });
    }).toThrow();

    // Events should be unchanged — no new event was appended
    expect(state.events).toHaveLength(eventsBefore);
    // Messages should be unchanged
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(m1);
  });

  // Test 6: restore(events) replays to correct messages
  it("restore replays events to produce correct messages", () => {
    const stateA = createConversationState();
    stateA["_turnActive"] = true;

    const m1 = makeMessage("1", "msg1");
    const m2 = makeMessage("2", "msg2");
    const m2replaced = makeMessage("2", "msg2-replaced");

    stateA.emit({ type: "append", message: m1 });
    stateA.emit({ type: "append", message: m2 });
    stateA.emit({ type: "replace", messageId: "2", message: m2replaced });

    const savedEvents = [...stateA.events];

    // Create a new state and restore
    const stateB = createConversationState();
    stateB.restore(savedEvents);

    expect(stateB.events).toHaveLength(savedEvents.length);
    expect(stateB.messages).toHaveLength(2);
    expect(stateB.messages[0]).toEqual(m1);
    expect(stateB.messages[1]).toEqual(m2replaced);
  });

  // Test 7: restore with empty array → empty state
  it("restore with empty array produces empty state", () => {
    const state = createConversationState();
    state["_turnActive"] = true;
    state.emit({ type: "append", message: makeMessage("1", "existing") });

    state.restore([]);

    expect(state.events).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
  });

  // Test 7b: restore() with invalid event stream throws and preserves existing state
  it("restore with invalid event stream throws and preserves original state", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "original");
    state.emit({ type: "append", message: m1 });

    const originalEvents = [...state.events];
    const originalMessages = [...state.messages];

    // This event stream is invalid: replace references id "999" which was never appended
    const badEvents: MessageEvent[] = [
      { type: "append", message: makeMessage("a", "new-msg") },
      { type: "replace", messageId: "999", message: makeMessage("999", "ghost") },
    ];

    expect(() => {
      state.restore(badEvents);
    }).toThrow();

    // Original state must be preserved
    expect(state.events).toHaveLength(originalEvents.length);
    expect(state.events[0]).toEqual(originalEvents[0]);
    expect(state.messages).toHaveLength(originalMessages.length);
    expect(state.messages[0]).toEqual(originalMessages[0]);
  });

  // Test 8: restore overwrites existing state
  it("restore overwrites existing state completely", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    // Add some events first
    state.emit({ type: "append", message: makeMessage("1", "old-msg-1") });
    state.emit({ type: "append", message: makeMessage("2", "old-msg-2") });

    expect(state.messages).toHaveLength(2);

    // Now restore with new events
    const newEvents: MessageEvent[] = [
      { type: "append", message: makeMessage("a", "new-msg-a") },
      { type: "append", message: makeMessage("b", "new-msg-b") },
      { type: "append", message: makeMessage("c", "new-msg-c") },
    ];
    state.restore(newEvents);

    expect(state.events).toHaveLength(3);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0].id).toBe("a");
    expect(state.messages[1].id).toBe("b");
    expect(state.messages[2].id).toBe("c");
  });

  // Test 8b: truncate with keepLast < 0 throws error and leaves events unchanged
  it("truncate with keepLast < 0 throws error and leaves events unchanged", () => {
    const state = createConversationState();
    state["_turnActive"] = true;

    const m1 = makeMessage("1", "first");
    state.emit({ type: "append", message: m1 });

    const eventsBefore = state.events.length;

    expect(() => {
      state.emit({ type: "truncate", keepLast: -1 });
    }).toThrow();

    // Events should be unchanged — no new event was appended
    expect(state.events).toHaveLength(eventsBefore);
    // Messages should be unchanged
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(m1);
  });

  // Test 9: same events replayed twice → identical messages (determinism)
  it("replaying same events twice produces identical messages (determinism)", () => {
    const events: MessageEvent[] = [
      { type: "append", message: makeMessage("1", "first") },
      { type: "append", message: makeMessage("2", "second") },
      { type: "append", message: makeMessage("3", "third") },
      { type: "replace", messageId: "2", message: makeMessage("2", "second-v2") },
      { type: "remove", messageId: "1" },
      { type: "truncate", keepLast: 2 },
    ];

    const stateA = createConversationState();
    stateA.restore(events);

    const stateB = createConversationState();
    stateB.restore(events);

    expect(stateA.messages).toEqual(stateB.messages);
    expect(stateA.events).toEqual(stateB.events);

    // Concrete expected final state:
    // After append 1,2,3 → replace 2 with "second-v2" → remove 1 → truncate(2)
    // Result: [{ id:"2", content:"second-v2" }, { id:"3", content:"third" }]
    expect(stateA.messages).toHaveLength(2);
    expect(stateA.messages[0]).toEqual(makeMessage("2", "second-v2"));
    expect(stateA.messages[1]).toEqual(makeMessage("3", "third"));
  });

  // Test 10: emit outside Turn context → throws error
  it("emit outside Turn context throws error", () => {
    const state = createConversationState();
    // Do NOT set _turnActive = true

    expect(() => {
      state.emit({ type: "append", message: makeMessage("1", "hello") });
    }).toThrow();

    // No events should be added
    expect(state.events).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
  });
});

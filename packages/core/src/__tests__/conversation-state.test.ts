import { describe, it, expect } from "vitest";
import type { Message, MessageEvent } from "@goondan/openharness-types";
import { CREATED_BY_METADATA_KEY, getCreatedBy } from "@goondan/openharness-types";
import { createConversationState } from "../index.js";

// Helper to create a simple message
function makeMessage(id: string, text: string, role: Message["data"]["role"] = "user"): Message {
  return { id, data: { role, content: text } as Message["data"] };
}

function appendEvent(message: Message): MessageEvent {
  if (message.data.role === "system") {
    return {
      type: "appendSystem",
      message: message as Extract<MessageEvent, { type: "appendSystem" }>["message"],
    };
  }
  return {
    type: "appendMessage",
    message: message as Extract<MessageEvent, { type: "appendMessage" }>["message"],
  };
}

describe("ConversationState", () => {
  it("append 3 events produces 3 messages in correct order", () => {
    const state = createConversationState();

    const m1 = makeMessage("1", "hello");
    const m2 = makeMessage("2", "world");
    const m3 = makeMessage("3", "foo");

    state.append(appendEvent(m1));
    state.append(appendEvent(m2));
    state.append(appendEvent(m3));

    expect(state.getMessages()).toHaveLength(3);
    expect(state.getMessages()[0]).toEqual(m1);
    expect(state.getMessages()[1]).toEqual(m2);
    expect(state.getMessages()[2]).toEqual(m3);
    expect(state.getEventLog()).toHaveLength(3);
  });

  it("replace event replaces the correct message", () => {
    const state = createConversationState();

    const m1 = makeMessage("1", "first");
    const m2 = makeMessage("2", "second");
    const m3 = makeMessage("3", "third");
    const m2replaced = makeMessage("2", "second-replaced");

    state.append(appendEvent(m1));
    state.append(appendEvent(m2));
    state.append(appendEvent(m3));
    state.append({ type: "replace", messageId: "2", message: m2replaced });

    expect(state.getMessages()).toHaveLength(3);
    expect(state.getMessages()[0]).toEqual(m1);
    expect(state.getMessages()[1]).toEqual(m2replaced);
    expect(state.getMessages()[2]).toEqual(m3);
    expect(state.getEventLog()).toHaveLength(4);
  });

  it("truncate keeps only last N messages", () => {
    const state = createConversationState();

    for (let i = 1; i <= 5; i++) {
      state.append(appendEvent(makeMessage(String(i), `msg ${i}`)));
    }
    state.append({ type: "truncate", keepLast: 3 });

    expect(state.getMessages()).toHaveLength(3);
    expect(state.getMessages()[0].id).toBe("3");
    expect(state.getMessages()[1].id).toBe("4");
    expect(state.getMessages()[2].id).toBe("5");
  });

  it("remove event removes the correct message", () => {
    const state = createConversationState();

    const m1 = makeMessage("1", "first");
    const m2 = makeMessage("2", "second");
    const m3 = makeMessage("3", "third");

    state.append(appendEvent(m1));
    state.append(appendEvent(m2));
    state.append(appendEvent(m3));
    state.append({ type: "remove", messageId: "2" });

    expect(state.getMessages()).toHaveLength(2);
    expect(state.getMessages()[0]).toEqual(m1);
    expect(state.getMessages()[1]).toEqual(m3);
    expect(state.getEventLog()).toHaveLength(4);
  });

  // Robustness: remove/replace against a missing id is an idempotent no-op, NOT
  // a throw. The event is still recorded (it is a valid event), and the derived
  // messages are unchanged.
  it("replace with non-existent ID is an idempotent no-op", () => {
    const state = createConversationState();

    const m1 = makeMessage("1", "first");
    state.append(appendEvent(m1));

    expect(() => {
      state.append({
        type: "replace",
        messageId: "nonexistent",
        message: makeMessage("nonexistent", "new"),
      });
    }).not.toThrow();

    expect(state.getMessages()).toHaveLength(1);
    expect(state.getMessages()[0]).toEqual(m1);
  });

  it("remove with non-existent ID is an idempotent no-op", () => {
    const state = createConversationState();

    const m1 = makeMessage("1", "first");
    state.append(appendEvent(m1));

    expect(() => {
      state.append({ type: "remove", messageId: "nonexistent" });
    }).not.toThrow();

    expect(state.getMessages()).toHaveLength(1);
    expect(state.getMessages()[0]).toEqual(m1);
  });

  it("restore replays events to produce correct messages", () => {
    const stateA = createConversationState();

    const m1 = makeMessage("1", "msg1");
    const m2 = makeMessage("2", "msg2");
    const m2replaced = makeMessage("2", "msg2-replaced");

    stateA.append(appendEvent(m1));
    stateA.append(appendEvent(m2));
    stateA.append({ type: "replace", messageId: "2", message: m2replaced });

    const savedEvents = [...stateA.getEventLog()];

    const stateB = createConversationState();
    stateB.restore(savedEvents);

    expect(stateB.getEventLog()).toHaveLength(savedEvents.length);
    expect(stateB.getMessages()).toHaveLength(2);
    expect(stateB.getMessages()[0]).toEqual(m1);
    expect(stateB.getMessages()[1]).toEqual(m2replaced);
  });

  it("restore with empty array produces empty state", () => {
    const state = createConversationState();
    state.append(appendEvent(makeMessage("1", "existing")));

    state.restore([]);

    expect(state.getEventLog()).toHaveLength(0);
    expect(state.getMessages()).toHaveLength(0);
  });

  it("restore overwrites existing state completely", () => {
    const state = createConversationState();

    state.append(appendEvent(makeMessage("1", "old-msg-1")));
    state.append(appendEvent(makeMessage("2", "old-msg-2")));

    expect(state.getMessages()).toHaveLength(2);

    const newEvents: MessageEvent[] = [
      appendEvent(makeMessage("a", "new-msg-a")),
      appendEvent(makeMessage("b", "new-msg-b")),
      appendEvent(makeMessage("c", "new-msg-c")),
    ];
    state.restore(newEvents);

    expect(state.getEventLog()).toHaveLength(3);
    expect(state.getMessages()).toHaveLength(3);
    expect(state.getMessages()[0].id).toBe("a");
    expect(state.getMessages()[1].id).toBe("b");
    expect(state.getMessages()[2].id).toBe("c");
  });

  it("truncate with keepLast < 0 throws error and leaves events unchanged", () => {
    const state = createConversationState();

    const m1 = makeMessage("1", "first");
    state.append(appendEvent(m1));

    const eventsBefore = state.getEventLog().length;

    expect(() => {
      state.append({ type: "truncate", keepLast: -1 });
    }).toThrow();

    expect(state.getEventLog()).toHaveLength(eventsBefore);
    expect(state.getMessages()).toHaveLength(1);
    expect(state.getMessages()[0]).toEqual(m1);
  });

  it("replaying same events twice produces identical messages (determinism)", () => {
    const events: MessageEvent[] = [
      appendEvent(makeMessage("1", "first")),
      appendEvent(makeMessage("2", "second")),
      appendEvent(makeMessage("3", "third")),
      { type: "replace", messageId: "2", message: makeMessage("2", "second-v2") },
      { type: "remove", messageId: "1" },
      { type: "truncate", keepLast: 2 },
    ];

    const stateA = createConversationState();
    stateA.restore(events);

    const stateB = createConversationState();
    stateB.restore(events);

    expect(stateA.getMessages()).toEqual(stateB.getMessages());
    expect(stateA.getEventLog()).toEqual(stateB.getEventLog());

    expect(stateA.getMessages()).toHaveLength(2);
    expect(stateA.getMessages()[0]).toEqual(makeMessage("2", "second-v2"));
    expect(stateA.getMessages()[1]).toEqual(makeMessage("3", "third"));
  });

  it("keeps a system message at the front even when appended after user messages", () => {
    const state = createConversationState();

    state.append(appendEvent(makeMessage("u1", "hello", "user")));
    state.append(appendEvent(makeMessage("s1", "system prompt", "system")));
    state.append(appendEvent(makeMessage("u2", "follow-up", "user")));

    expect(state.getMessages().map((m) => m.id)).toEqual(["s1", "u1", "u2"]);
    expect(state.getMessages()[0]?.data.role).toBe("system");
  });

  it("rejects replace when the new message changes role", () => {
    const state = createConversationState();

    state.append(appendEvent(makeMessage("u1", "hello", "user")));
    state.append(appendEvent(makeMessage("u2", "world", "user")));

    expect(() => {
      state.append({
        type: "replace",
        messageId: "u2",
        message: makeMessage("u2", "systemized", "system"),
      });
    }).toThrow(/cannot change role/);

    expect(state.getMessages().map((m) => `${m.id}:${m.data.role}`)).toEqual([
      "u1:user",
      "u2:user",
    ]);
  });

  it("keeps non-system replacements in their original slot", () => {
    const state = createConversationState();

    state.append(appendEvent(makeMessage("s1", "system", "system")));
    state.append(appendEvent(makeMessage("u1", "first", "user")));
    state.append(appendEvent(makeMessage("u2", "second", "user")));
    state.append({
      type: "replace",
      messageId: "u1",
      message: makeMessage("u1", "first-replaced", "user"),
    });

    expect(state.getMessages().map((m) => m.id)).toEqual(["s1", "u1", "u2"]);
    expect(state.getMessages()[1]?.data.content).toBe("first-replaced");
  });

  it("rejects replace when a system message is changed to a non-system role", () => {
    const state = createConversationState();

    state.append(appendEvent(makeMessage("s1", "system-1", "system")));
    state.append(appendEvent(makeMessage("s2", "system-2", "system")));
    state.append(appendEvent(makeMessage("u1", "first", "user")));

    expect(() => {
      state.append({
        type: "replace",
        messageId: "s2",
        message: makeMessage("s2", "now-user", "user"),
      });
    }).toThrow(/cannot change role/);

    expect(state.getMessages().map((m) => `${m.id}:${m.data.role}`)).toEqual([
      "s1:system",
      "s2:system",
      "u1:user",
    ]);
  });

  it("rejects appendSystem when role is not system", () => {
    const state = createConversationState();

    expect(() => {
      state.append({
        type: "appendSystem",
        message: makeMessage("u1", "hello", "user"),
      } as MessageEvent);
    }).toThrow(/requires role "system"/);

    expect(state.getEventLog()).toHaveLength(0);
    expect(state.getMessages()).toHaveLength(0);
  });

  it("rejects appendMessage when role is system", () => {
    const state = createConversationState();

    expect(() => {
      state.append({
        type: "appendMessage",
        message: makeMessage("s1", "system", "system"),
      } as MessageEvent);
    }).toThrow(/does not accept role "system"/);

    expect(state.getEventLog()).toHaveLength(0);
    expect(state.getMessages()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // New 1.0 behaviors
  // -------------------------------------------------------------------------

  it("getMessages() returns a frozen snapshot", () => {
    const state = createConversationState();
    state.append(appendEvent(makeMessage("1", "hello")));

    const snapshot = state.getMessages();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as Message[]).push(makeMessage("2", "world"));
    }).toThrow();
  });

  it("getEventLog() bytes are invariant under getMessages() lifting (0.5 read-compat)", () => {
    // A legacy 0.5 event: createdBy lives only in metadata.__createdBy.
    const legacyMessage: Message = {
      id: "legacy-1",
      data: { role: "user", content: "legacy" },
      metadata: { [CREATED_BY_METADATA_KEY]: "legacy-ext" },
    };
    const events: MessageEvent[] = [
      { type: "appendMessage", message: legacyMessage as Extract<MessageEvent, { type: "appendMessage" }>["message"] },
    ];
    const before = JSON.stringify(events);

    const state = createConversationState();
    state.restore(events);

    // Event log serializes byte-identically to the original 0.5 log.
    expect(JSON.stringify(state.getEventLog())).toBe(before);
    // The event-log message object still has NO createdBy field.
    const loggedEvent = state.getEventLog()[0] as Extract<MessageEvent, { type: "appendMessage" }>;
    expect(loggedEvent.message.createdBy).toBeUndefined();
  });

  it("getMessages() lifts createdBy from legacy metadata into the derived view", () => {
    const legacyMessage: Message = {
      id: "legacy-1",
      data: { role: "user", content: "legacy" },
      metadata: { [CREATED_BY_METADATA_KEY]: "legacy-ext" },
    };
    const state = createConversationState();
    state.restore([
      { type: "appendMessage", message: legacyMessage as Extract<MessageEvent, { type: "appendMessage" }>["message"] },
    ]);

    const derived = state.getMessages()[0];
    // The derived (lifted) copy carries createdBy as a first-class field.
    expect(derived.createdBy).toBe("legacy-ext");
    expect(getCreatedBy(derived)).toBe("legacy-ext");
    // The source event object is untouched.
    const loggedEvent = state.getEventLog()[0] as Extract<MessageEvent, { type: "appendMessage" }>;
    expect(loggedEvent.message).not.toBe(derived);
    expect(loggedEvent.message.createdBy).toBeUndefined();
  });

  it("does not override an explicit createdBy field with metadata", () => {
    const message: Message = {
      id: "1",
      data: { role: "user", content: "hi" },
      createdBy: "field-author",
      metadata: { [CREATED_BY_METADATA_KEY]: "metadata-author" },
    };
    const state = createConversationState();
    state.append({
      type: "appendMessage",
      message: message as Extract<MessageEvent, { type: "appendMessage" }>["message"],
    });

    expect(state.getMessages()[0].createdBy).toBe("field-author");
  });
});

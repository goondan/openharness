import { describe, it, expect } from "vitest";
import type { Message, MessageEvent } from "@goondan/openharness-types";
import { createConversationState } from "../conversation-state.js";
import { EventBus } from "../event-bus.js";

// ---------------------------------------------------------------------------
// Two event layers, kept separate (spec §5).
//
//   MessageEvent  (conversation.append / getEventLog)
//     — state change, event sourcing, replay == restore.
//   HarnessEvents (EventBus emit / on / tap)
//     — observation, fire-and-forget, replay != restore.
//
// The load-bearing invariant: `conversation.append` NEVER touches the EventBus.
// Recording an inbox of every payload the bus emits and asserting it stays empty
// across all five MessageEvent kinds pins that down at the contract boundary.
// ---------------------------------------------------------------------------

function userMessage(id: string, text: string): Message {
  return { id, data: { role: "user", content: text } };
}

function systemMessage(id: string, text: string): Message {
  return { id, data: { role: "system", content: text } };
}

function appendUser(id: string, text: string): MessageEvent {
  return {
    type: "appendMessage",
    message: userMessage(id, text) as Extract<MessageEvent, { type: "appendMessage" }>["message"],
  };
}

describe("two event layers stay separate", () => {
  it("conversation.append emits nothing on the EventBus (state change != observation)", () => {
    const conversation = createConversationState();
    const bus = new EventBus();

    const seen: string[] = [];
    bus.tap((payload) => seen.push(payload.type));

    // Exercise every MessageEvent kind.
    conversation.append({
      type: "appendSystem",
      message: systemMessage("s1", "system") as Extract<
        MessageEvent,
        { type: "appendSystem" }
      >["message"],
    });
    conversation.append(appendUser("u1", "hello"));
    conversation.append(appendUser("u2", "world"));
    conversation.append({
      type: "replace",
      messageId: "u1",
      message: userMessage("u1", "hello-edited"),
    });
    conversation.append({ type: "remove", messageId: "u2" });
    conversation.append({ type: "truncate", keepLast: 1 });

    // The bus observed nothing — append is purely a state-layer operation.
    expect(seen).toEqual([]);
    // The state layer did do its work.
    expect(conversation.getEventLog()).toHaveLength(6);
  });

  it("EventBus.emit does not mutate the conversation (observation != state change)", () => {
    const conversation = createConversationState();
    const bus = new EventBus();

    conversation.append(appendUser("u1", "hello"));
    const before = conversation.getEventLog().length;

    bus.emit("turn.done", {
      type: "turn.done",
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
      result: {
        turnId: "t1",
        agentName: "agent",
        conversationId: "c1",
        status: "completed",
        steps: [],
      },
    });

    expect(conversation.getEventLog()).toHaveLength(before);
    expect(conversation.getMessages()).toHaveLength(1);
  });

  it("getEventLog() yields MessageEvents (replay == restore), not HarnessEvents", () => {
    const conversation = createConversationState();
    conversation.append(appendUser("u1", "hello"));
    conversation.append({ type: "truncate", keepLast: 1 });

    const log = conversation.getEventLog();
    // Every entry is a MessageEvent discriminant, never a runtime/HarnessEvent.
    const messageEventTypes = new Set([
      "appendSystem",
      "appendMessage",
      "replace",
      "remove",
      "truncate",
    ]);
    for (const event of log) {
      expect(messageEventTypes.has(event.type)).toBe(true);
    }

    // replay == restore: feeding the log back into a fresh state reconstructs it.
    const restored = createConversationState();
    restored.restore([...log]);
    expect(restored.getMessages()).toEqual(conversation.getMessages());
    expect(restored.getEventLog()).toEqual(conversation.getEventLog());
  });

  it("EventBus payloads are observation-only — re-emitting them does not restore state", () => {
    const bus = new EventBus();
    const observed: string[] = [];
    bus.on("turn.start", (p) => observed.push(p.turnId));

    const payload = {
      type: "turn.start" as const,
      turnId: "t1",
      agentName: "agent",
      conversationId: "c1",
    };

    // Re-emitting the same observation payload simply re-notifies listeners; it
    // carries no state-reconstruction semantics (replay != restore).
    bus.emit("turn.start", payload);
    bus.emit("turn.start", payload);

    expect(observed).toEqual(["t1", "t1"]);
  });
});

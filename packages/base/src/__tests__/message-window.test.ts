import { describe, it, expect } from "vitest";
import { MessageWindow } from "../extensions/message-window.js";
import type { Message } from "@goondan/openharness-types";
import {
  applyModelInputs,
  makeMessages,
  makeMockApi,
  makeMockConversationState,
  makeStepContext,
} from "./_mock-api.js";

describe("MessageWindow", () => {
  it("creates an AgentExtension with name 'message-window'", () => {
    expect(MessageWindow({ maxMessages: 5 }).name).toBe("message-window");
  });

  it("registers a model-input projection (not a durable mutator)", () => {
    const conversation = makeMockConversationState();
    const { api, modelInputs, registered } = makeMockApi(conversation);

    MessageWindow({ maxMessages: 5 }).register(api);

    expect(modelInputs).toHaveLength(1);
    expect(registered).toHaveLength(0);
  });

  it("returns the view unchanged when within maxMessages", async () => {
    const conversation = makeMockConversationState(makeMessages(3));
    const { api, modelInputs } = makeMockApi(conversation);

    MessageWindow({ maxMessages: 5 }).register(api);

    const ctx = makeStepContext(conversation);
    const view = await applyModelInputs(modelInputs, conversation, ctx);

    expect(view).toHaveLength(3);
    // Projection never mutates the durable log.
    expect(conversation.append).not.toHaveBeenCalled();
    expect(conversation.getMessages()).toHaveLength(3);
  });

  it("windows the view to the most recent non-system messages", async () => {
    const conversation = makeMockConversationState(makeMessages(8));
    const { api, modelInputs } = makeMockApi(conversation);

    MessageWindow({ maxMessages: 5 }).register(api);

    const ctx = makeStepContext(conversation);
    const view = await applyModelInputs(modelInputs, conversation, ctx);

    expect(view).toHaveLength(5);
    expect(view.map((m) => m.id)).toEqual([
      "msg-3",
      "msg-4",
      "msg-5",
      "msg-6",
      "msg-7",
    ]);
    // Durable log is untouched.
    expect(conversation.getMessages()).toHaveLength(8);
    expect(conversation.append).not.toHaveBeenCalled();
  });

  it("always retains leading system messages", async () => {
    const system: Message = {
      id: "sys",
      data: { role: "system", content: "you are helpful" },
    };
    const conversation = makeMockConversationState([
      system,
      ...makeMessages(8),
    ]);
    const { api, modelInputs } = makeMockApi(conversation);

    MessageWindow({ maxMessages: 5 }).register(api);

    const ctx = makeStepContext(conversation);
    const view = await applyModelInputs(modelInputs, conversation, ctx);

    expect(view[0].id).toBe("sys");
    expect(view).toHaveLength(6); // 1 system + 5 body
    expect(view.slice(1).map((m) => m.id)).toEqual([
      "msg-3",
      "msg-4",
      "msg-5",
      "msg-6",
      "msg-7",
    ]);
  });

  it("extends the boundary left off an orphaned tool-result", async () => {
    // Body layout (8 messages): the window of 5 would start at index 3, but
    // msg-3 is a tool-result whose assistant tool-call would be dropped, so the
    // boundary extends left to include it.
    const body: Message[] = [
      { id: "b0", data: { role: "user", content: "0" } },
      { id: "b1", data: { role: "user", content: "1" } },
      {
        id: "b2",
        data: {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc", toolName: "x", input: {} },
          ],
        },
      },
      {
        id: "b3",
        data: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc",
              toolName: "x",
              output: { type: "text", value: "ok" },
            },
          ],
        },
      },
      { id: "b4", data: { role: "user", content: "4" } },
      { id: "b5", data: { role: "user", content: "5" } },
      { id: "b6", data: { role: "user", content: "6" } },
      { id: "b7", data: { role: "user", content: "7" } },
    ];
    const conversation = makeMockConversationState(body);
    const { api, modelInputs } = makeMockApi(conversation);

    MessageWindow({ maxMessages: 5 }).register(api);

    const ctx = makeStepContext(conversation);
    const view = await applyModelInputs(modelInputs, conversation, ctx);

    // Default start = 8 - 5 = 3 (b3, a tool-result) → extend left to b2.
    expect(view[0].id).toBe("b2");
    expect(view.map((m) => m.id)).toEqual([
      "b2",
      "b3",
      "b4",
      "b5",
      "b6",
      "b7",
    ]);
  });
});

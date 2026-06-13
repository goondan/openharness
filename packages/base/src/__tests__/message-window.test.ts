import { describe, it, expect } from "vitest";
import { MessageWindow } from "../extensions/message-window.js";
import type { Message, PromptView } from "@goondan/openharness-types";
import {
  makeMockApi,
  makeMockConversationState,
  makeStepContext,
  makeMessages,
} from "./helpers.js";

function userMsg(id: string, content = id): Message {
  return { id, data: { role: "user", content } };
}

function systemMsg(id: string, content = id): Message {
  return { id, data: { role: "system", content } };
}

function assistantToolCall(id: string, toolCallId: string): Message {
  return {
    id,
    data: {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: "x", input: {} }],
    },
  };
}

function toolResult(id: string, toolCallId: string): Message {
  return {
    id,
    data: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "x",
          output: { type: "text", value: "ok" },
        },
      ],
    },
  };
}

describe("MessageWindow", () => {
  it("creates an Extension with name 'message-window'", () => {
    const ext = MessageWindow({ maxMessages: 5 });
    expect(ext.name).toBe("message-window");
  });

  it("registers a prompt projection (not a durable middleware)", () => {
    const conversation = makeMockConversationState([]);
    const { api, projections, registeredMiddleware } = makeMockApi(conversation);

    const ext = MessageWindow({ maxMessages: 5 });
    ext.register(api);

    expect(api.prompt.transform).toHaveBeenCalledOnce();
    expect(projections).toHaveLength(1);
    expect(projections[0].name).toBe("message-window");
    // Windowing is a view projection now — it must not register durable middleware.
    expect(registeredMiddleware).toHaveLength(0);
  });

  it("returns the view unchanged when body is within maxMessages", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    MessageWindow({ maxMessages: 5 }).register(api);

    const view = makeMessages(3) as PromptView;
    const ctx = makeStepContext(conversation);
    const out = await projections[0].projection(view, ctx);

    expect(out).toBe(view);
    // A projection never mutates the durable log.
    expect(conversation.emit).not.toHaveBeenCalled();
  });

  it("keeps only the last maxMessages body messages when exceeded", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    MessageWindow({ maxMessages: 5 }).register(api);

    const view = makeMessages(8) as PromptView;
    const ctx = makeStepContext(conversation);
    const out = await projections[0].projection(view, ctx);

    expect(out).toHaveLength(5);
    expect(out.map((m) => m.id)).toEqual(["msg-3", "msg-4", "msg-5", "msg-6", "msg-7"]);
    expect(conversation.emit).not.toHaveBeenCalled();
  });

  it("always retains leading system messages on top of the window", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    MessageWindow({ maxMessages: 3 }).register(api);

    const view = [
      systemMsg("sys-0"),
      ...makeMessages(6),
    ] as PromptView;
    const ctx = makeStepContext(conversation);
    const out = await projections[0].projection(view, ctx);

    // system always survives + last 3 body messages
    expect(out.map((m) => m.id)).toEqual(["sys-0", "msg-3", "msg-4", "msg-5"]);
  });

  it("extends the boundary left so the window never opens on an orphan tool-result", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    // maxMessages 3 would normally start the window at the tool-result, severing
    // it from its assistant tool-call. The boundary must back up to include the call.
    MessageWindow({ maxMessages: 3 }).register(api);

    const view = [
      userMsg("u-0"),
      userMsg("u-1"),
      assistantToolCall("a-2", "call-1"),
      toolResult("t-3", "call-1"),
      userMsg("u-4"),
    ] as PromptView;
    const ctx = makeStepContext(conversation);
    const out = await projections[0].projection(view, ctx);

    // raw start = 5 - 3 = 2 (the assistant call) — already not a tool-result, so
    // the window is [a-2, t-3, u-4]; the call/result pair stays whole.
    expect(out.map((m) => m.id)).toEqual(["a-2", "t-3", "u-4"]);
    const first = out[0];
    expect(first.data.role).toBe("assistant");
  });

  it("backs up past a tool-result that would otherwise lead the window", async () => {
    const conversation = makeMockConversationState();
    const { api, projections } = makeMockApi(conversation);
    MessageWindow({ maxMessages: 2 }).register(api);

    const view = [
      userMsg("u-0"),
      assistantToolCall("a-1", "call-1"),
      toolResult("t-2", "call-1"),
      userMsg("u-3"),
    ] as PromptView;
    const ctx = makeStepContext(conversation);
    const out = await projections[0].projection(view, ctx);

    // raw start = 4 - 2 = 2 (the tool-result) → back up to index 1 (the call).
    expect(out.map((m) => m.id)).toEqual(["a-1", "t-2", "u-3"]);
  });
});

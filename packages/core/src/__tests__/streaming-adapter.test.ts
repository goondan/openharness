import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, ToolDefinition, LlmStreamCallbacks } from "@goondan/openharness-types";

// -----------------------------------------------------------------------
// Shared fixtures
// -----------------------------------------------------------------------

const mockMessages: Message[] = [
  { id: "1", data: { role: "user", content: "Hello" } },
];

const mockTools: ToolDefinition[] = [
  {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
    handler: async () => ({ type: "text", text: "sunny" }),
  },
];

const abortSignal = new AbortController().signal;

// -----------------------------------------------------------------------
// Helper: create a mock fullStream async iterable
// -----------------------------------------------------------------------

function createMockFullStream(
  parts: Array<Record<string, unknown>>,
): AsyncIterableIterator<Record<string, unknown>> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (index < parts.length) {
        return { value: parts[index++], done: false };
      }
      return { value: undefined, done: true };
    },
  };
}

// -----------------------------------------------------------------------
// Tests: AI SDK adapter streamChat()
// -----------------------------------------------------------------------

describe("AI SDK adapter streamChat()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls streamText and invokes onTextDelta callback for text-delta parts", async () => {
    const streamParts = [
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " world" },
      { type: "text-delta", delta: "!" },
    ];

    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        streamText: vi.fn().mockReturnValue({
          fullStream: createMockFullStream(streamParts),
          text: Promise.resolve("Hello world!"),
          toolCalls: Promise.resolve([]),
        }),
      };
    });
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "claude-3-5-sonnet-20241022" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createClient(config, "sk-ant-resolved");

    const deltas: string[] = [];
    const callbacks: LlmStreamCallbacks = {
      onTextDelta: (delta) => deltas.push(delta),
    };

    const response = await client.streamChat!(
      mockMessages,
      [],
      abortSignal,
      callbacks,
    );

    expect(deltas).toEqual(["Hello", " world", "!"]);
    expect(response.text).toBe("Hello world!");
    expect(response.toolCalls).toBeUndefined();
  });

  it("invokes onToolCallDelta callback for tool-input-delta parts, resolving toolName from tool-input-start", async () => {
    const streamParts = [
      { type: "tool-input-start", toolCallId: "toolu_01", toolName: "get_weather" },
      { type: "tool-input-delta", toolCallId: "toolu_01", inputTextDelta: '{"loc' },
      { type: "tool-input-delta", toolCallId: "toolu_01", inputTextDelta: 'ation":"NYC"}' },
    ];

    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        streamText: vi.fn().mockReturnValue({
          fullStream: createMockFullStream(streamParts),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([
            { toolCallId: "toolu_01", toolName: "get_weather", input: { location: "NYC" } },
          ]),
        }),
      };
    });
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "claude-3-5-sonnet-20241022" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createClient(config, "sk-ant-resolved");

    const toolDeltas: Array<{ toolCallId: string; toolName: string; argsDelta: string }> = [];
    const callbacks: LlmStreamCallbacks = {
      onToolCallDelta: (toolCallId, toolName, argsDelta) =>
        toolDeltas.push({ toolCallId, toolName, argsDelta }),
    };

    const response = await client.streamChat!(
      mockMessages,
      mockTools,
      abortSignal,
      callbacks,
    );

    // Verify tool call deltas received with correct toolName from tool-input-start
    expect(toolDeltas).toHaveLength(2);
    expect(toolDeltas[0]).toEqual({
      toolCallId: "toolu_01",
      toolName: "get_weather",
      argsDelta: '{"loc',
    });
    expect(toolDeltas[1]).toEqual({
      toolCallId: "toolu_01",
      toolName: "get_weather",
      argsDelta: 'ation":"NYC"}',
    });

    // Verify final response includes tool calls
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]).toEqual({
      toolCallId: "toolu_01",
      toolName: "get_weather",
      args: { location: "NYC" },
    });
  });

  it("handles interleaved text and tool call deltas", async () => {
    const streamParts = [
      { type: "text-delta", delta: "Let me check " },
      { type: "text-delta", delta: "the weather." },
      { type: "tool-input-start", toolCallId: "toolu_02", toolName: "get_weather" },
      { type: "tool-input-delta", toolCallId: "toolu_02", inputTextDelta: '{"location":"SF"}' },
    ];

    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        streamText: vi.fn().mockReturnValue({
          fullStream: createMockFullStream(streamParts),
          text: Promise.resolve("Let me check the weather."),
          toolCalls: Promise.resolve([
            { toolCallId: "toolu_02", toolName: "get_weather", input: { location: "SF" } },
          ]),
        }),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "gpt-4o" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient(
      { provider: "openai", model: "gpt-4o", apiKey: "key" },
      "sk-resolved",
    );

    const textDeltas: string[] = [];
    const toolDeltas: Array<{ toolCallId: string; toolName: string; argsDelta: string }> = [];

    const response = await client.streamChat!(
      mockMessages,
      mockTools,
      abortSignal,
      {
        onTextDelta: (d) => textDeltas.push(d),
        onToolCallDelta: (id, name, delta) =>
          toolDeltas.push({ toolCallId: id, toolName: name, argsDelta: delta }),
      },
    );

    expect(textDeltas).toEqual(["Let me check ", "the weather."]);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0].toolName).toBe("get_weather");
    expect(response.text).toBe("Let me check the weather.");
    expect(response.toolCalls).toHaveLength(1);
  });

  it("returns undefined text when response text is empty", async () => {
    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        streamText: vi.fn().mockReturnValue({
          fullStream: createMockFullStream([]),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
        }),
      };
    });
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "claude" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient(
      { provider: "anthropic", model: "claude", apiKey: "key" },
      "sk-resolved",
    );

    const response = await client.streamChat!(
      mockMessages,
      [],
      abortSignal,
      {},
    );

    expect(response.text).toBeUndefined();
    expect(response.toolCalls).toBeUndefined();
  });

  it("handles multiple tool calls with separate tool-input-start events", async () => {
    const streamParts = [
      { type: "tool-input-start", toolCallId: "tc-1", toolName: "tool_a" },
      { type: "tool-input-delta", toolCallId: "tc-1", inputTextDelta: '{"v":"1"}' },
      { type: "tool-input-start", toolCallId: "tc-2", toolName: "tool_b" },
      { type: "tool-input-delta", toolCallId: "tc-2", inputTextDelta: '{"v":"2"}' },
    ];

    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        streamText: vi.fn().mockReturnValue({
          fullStream: createMockFullStream(streamParts),
          text: Promise.resolve(""),
          toolCalls: Promise.resolve([
            { toolCallId: "tc-1", toolName: "tool_a", input: { v: "1" } },
            { toolCallId: "tc-2", toolName: "tool_b", input: { v: "2" } },
          ]),
        }),
      };
    });
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "claude" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient(
      { provider: "anthropic", model: "claude", apiKey: "key" },
      "sk-resolved",
    );

    const toolDeltas: Array<{ toolCallId: string; toolName: string }> = [];
    const response = await client.streamChat!(
      mockMessages,
      [],
      abortSignal,
      {
        onToolCallDelta: (id, name) => toolDeltas.push({ toolCallId: id, toolName: name }),
      },
    );

    // Each delta should have the correct toolName resolved from its respective tool-input-start
    expect(toolDeltas[0]).toEqual({ toolCallId: "tc-1", toolName: "tool_a" });
    expect(toolDeltas[1]).toEqual({ toolCallId: "tc-2", toolName: "tool_b" });
    expect(response.toolCalls).toHaveLength(2);
  });

  it("passes LlmChatOptions (temperature, maxTokens, model) to streamText", async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        streamText: vi.fn().mockImplementation((args: Record<string, unknown>) => {
          capturedArgs = args;
          return {
            fullStream: createMockFullStream([]),
            text: Promise.resolve(""),
            toolCalls: Promise.resolve([]),
          };
        }),
      };
    });
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "gemini-1.5-flash" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient(
      { provider: "google", model: "gemini-1.5-pro", apiKey: "key" },
      "g-resolved",
    );

    await client.streamChat!(
      mockMessages,
      [],
      abortSignal,
      {},
      { model: "gemini-1.5-flash", temperature: 0.7, maxTokens: 1024 },
    );

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!["temperature"]).toBe(0.7);
    expect(capturedArgs!["maxOutputTokens"]).toBe(1024);
  });
});

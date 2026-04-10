import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "@goondan/openharness-types";
import { Anthropic, OpenAI, Google, createLlmClient } from "../models/index.js";
import { ConfigError } from "../errors.js";
import type { Message, ToolDefinition } from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("Anthropic()", () => {
  it("returns ModelConfig with provider 'anthropic'", () => {
    const config = Anthropic({ model: "claude-3-5-sonnet-20241022", apiKey: "sk-ant-test" });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-3-5-sonnet-20241022");
    expect(config.apiKey).toBe("sk-ant-test");
  });

  it("includes baseUrl when provided", () => {
    const config = Anthropic({ model: "claude-3-haiku-20240307", apiKey: "key", baseUrl: "https://custom.anthropic.com" });
    expect(config.baseUrl).toBe("https://custom.anthropic.com");
  });

  it("accepts EnvRef as apiKey (not resolved at factory time)", () => {
    const ref = env("ANTHROPIC_API_KEY");
    const config = Anthropic({ model: "claude-3-5-sonnet-20241022", apiKey: ref });
    expect(config.apiKey).toBe(ref);
    expect(config.apiKey).toEqual({ name: "ANTHROPIC_API_KEY" });
  });

  it("omits baseUrl when not provided", () => {
    const config = Anthropic({ model: "claude-3-5-sonnet-20241022", apiKey: "key" });
    expect("baseUrl" in config).toBe(false);
  });
});

describe("OpenAI()", () => {
  it("returns ModelConfig with provider 'openai'", () => {
    const config = OpenAI({ model: "gpt-4o", apiKey: "sk-openai-test" });
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.apiKey).toBe("sk-openai-test");
  });

  it("includes baseUrl when provided", () => {
    const config = OpenAI({ model: "gpt-4o-mini", apiKey: "key", baseUrl: "https://api.custom.com/v1" });
    expect(config.baseUrl).toBe("https://api.custom.com/v1");
  });

  it("accepts EnvRef as apiKey (not resolved at factory time)", () => {
    const ref = env("OPENAI_API_KEY");
    const config = OpenAI({ model: "gpt-4o", apiKey: ref });
    expect(config.apiKey).toBe(ref);
  });
});

describe("Google()", () => {
  it("returns ModelConfig with provider 'google'", () => {
    const config = Google({ model: "gemini-1.5-pro", apiKey: "google-key" });
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-1.5-pro");
    expect(config.apiKey).toBe("google-key");
  });

  it("accepts EnvRef as apiKey (not resolved at factory time)", () => {
    const ref = env("GOOGLE_API_KEY");
    const config = Google({ model: "gemini-1.5-flash", apiKey: ref });
    expect(config.apiKey).toBe(ref);
  });

  it("omits baseUrl (Google does not support custom endpoints)", () => {
    const config = Google({ model: "gemini-1.5-pro", apiKey: "key" });
    expect("baseUrl" in config).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createLlmClient tests
// ---------------------------------------------------------------------------

describe("createLlmClient()", () => {
  it("throws ConfigError for unknown provider", () => {
    const config = { provider: "unknown", model: "some-model", apiKey: "key" };
    expect(() => createLlmClient(config, "resolved-key")).toThrow(ConfigError);
    expect(() => createLlmClient(config, "resolved-key")).toThrow("Unknown model provider: unknown");
  });

  it("creates a functional client for each supported provider", () => {
    const providers = [
      { factory: Anthropic, model: "claude-3-5-sonnet-20241022", provider: "anthropic" },
      { factory: OpenAI, model: "gpt-4o", provider: "openai" },
      { factory: Google, model: "gemini-1.5-pro", provider: "google" },
    ] as const;

    for (const { factory, model, provider } of providers) {
      const config = factory({ model, apiKey: "key" });
      const client = createLlmClient(config, "resolved-key");
      // Verify the client has a callable chat method (adapter was created successfully)
      expect(typeof client.chat).toBe("function");
      // Verify the config provider matches expectations
      expect(config.provider).toBe(provider);
    }
  });
});

// ---------------------------------------------------------------------------
// Adapter chat() tests — mock ai-sdk's generateText
// ---------------------------------------------------------------------------

const mockMessages: Message[] = [
  { id: "1", data: { role: "user", content: "Hello" } },
];

const mockTools: ToolDefinition[] = [
  {
    name: "get_weather",
    description: "Get the weather",
    parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
    handler: async () => ({ type: "text", text: "sunny" }),
  },
];

const abortSignal = new AbortController().signal;

describe("AI SDK adapter chat()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls generateText and returns LlmResponse with text", async () => {
    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
          text: "Hello from AI SDK",
          toolCalls: [],
          finishReason: "stop",
          response: { messages: [] },
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
    const response = await client.chat(mockMessages, mockTools, abortSignal);

    expect(response.text).toBe("Hello from AI SDK");
    expect(response.toolCalls).toBeUndefined();
  });

  it("returns toolCalls when generateText responds with tool calls", async () => {
    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockResolvedValue({
          text: "",
          toolCalls: [
            {
              toolCallId: "toolu_01",
              toolName: "get_weather",
              input: { location: "NYC" },
            },
          ],
          finishReason: "tool-calls",
          response: { messages: [] },
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
    const response = await client.chat(mockMessages, [], abortSignal);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]).toEqual({
      toolCallId: "toolu_01",
      toolName: "get_weather",
      args: { location: "NYC" },
    });
  });

  it("passes messages as ModelMessage[] to generateText", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return { text: "ok", toolCalls: [], finishReason: "stop", response: { messages: [] } };
        }),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "gpt-4o" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient({ provider: "openai", model: "gpt-4o", apiKey: "key" }, "sk-resolved");
    const messages: Message[] = [
      { id: "sys", data: { role: "system", content: "You are helpful" } },
      { id: "usr", data: { role: "user", content: "Hi" } },
    ];
    await client.chat(messages, [], abortSignal);

    // generateText should receive the raw ModelMessage data (msg.data)
    expect(capturedArgs).toBeDefined();
    const passedMessages = capturedArgs!["messages"] as Array<{ role: string; content: string }>;
    expect(passedMessages).toHaveLength(2);
    expect(passedMessages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(passedMessages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts tools to ai-sdk tool format", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return { text: "ok", toolCalls: [], finishReason: "stop", response: { messages: [] } };
        }),
      };
    });
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "gemini-1.5-pro" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient({ provider: "google", model: "gemini-1.5-pro", apiKey: "key" }, "g-resolved");
    await client.chat(mockMessages, mockTools, abortSignal);

    expect(capturedArgs).toBeDefined();
    const passedTools = capturedArgs!["tools"] as Record<string, unknown>;
    expect(passedTools).toBeDefined();
    expect("get_weather" in passedTools).toBe(true);
  });

  it("does not pass tools when tool list is empty", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
          capturedArgs = args;
          return { text: "ok", toolCalls: [], finishReason: "stop", response: { messages: [] } };
        }),
      };
    });
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockReturnValue({ modelId: "claude" }),
      }),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const client = createClient({ provider: "anthropic", model: "claude", apiKey: "key" }, "sk-resolved");
    await client.chat(mockMessages, [], abortSignal);

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!["tools"]).toBeUndefined();
  });
});

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
// Adapter chat() tests with mocked SDKs
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

describe("Anthropic adapter chat()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls Anthropic SDK and returns LlmResponse with text", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "Hello from Claude" }],
            stop_reason: "end_turn",
          }),
        },
      })),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createClient(config, "sk-ant-resolved");
    const response = await client.chat(mockMessages, mockTools, abortSignal);

    expect(response.text).toBe("Hello from Claude");
    expect(response.toolCalls).toBeUndefined();
  });

  it("returns toolCalls when Anthropic responds with tool_use", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                id: "toolu_01",
                name: "get_weather",
                input: { location: "NYC" },
              },
            ],
            stop_reason: "tool_use",
          }),
        },
      })),
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
});

describe("OpenAI adapter chat()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls OpenAI SDK and returns LlmResponse with text", async () => {
    vi.doMock("openai", () => ({
      default: vi.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: "Hello from GPT",
                    tool_calls: null,
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          },
        },
      })),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "openai", model: "gpt-4o", apiKey: "key" };
    const client = createClient(config, "sk-openai-resolved");
    const response = await client.chat(mockMessages, mockTools, abortSignal);

    expect(response.text).toBe("Hello from GPT");
    expect(response.toolCalls).toBeUndefined();
  });

  it("returns toolCalls when OpenAI responds with tool_calls", async () => {
    vi.doMock("openai", () => ({
      default: vi.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_abc",
                        type: "function",
                        function: {
                          name: "get_weather",
                          arguments: JSON.stringify({ location: "SF" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          },
        },
      })),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "openai", model: "gpt-4o", apiKey: "key" };
    const client = createClient(config, "sk-openai-resolved");
    const response = await client.chat(mockMessages, [], abortSignal);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]).toEqual({
      toolCallId: "call_abc",
      toolName: "get_weather",
      args: { location: "SF" },
    });
  });
});

describe("Google adapter chat()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls Google SDK and returns LlmResponse with text", async () => {
    vi.doMock("@google/generative-ai", () => ({
      GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
        getGenerativeModel: vi.fn().mockReturnValue({
          generateContent: vi.fn().mockResolvedValue({
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "Hello from Gemini" }],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          }),
        }),
      })),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "google", model: "gemini-1.5-pro", apiKey: "key" };
    const client = createClient(config, "google-resolved");
    const response = await client.chat(mockMessages, mockTools, abortSignal);

    expect(response.text).toBe("Hello from Gemini");
    expect(response.toolCalls).toBeUndefined();
  });

  it("returns toolCalls when Google responds with function calls", async () => {
    vi.doMock("@google/generative-ai", () => ({
      GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
        getGenerativeModel: vi.fn().mockReturnValue({
          generateContent: vi.fn().mockResolvedValue({
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: "get_weather",
                          args: { location: "LA" },
                        },
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          }),
        }),
      })),
    }));

    const { createLlmClient: createClient } = await import("../models/index.js");
    const config = { provider: "google", model: "gemini-1.5-pro", apiKey: "key" };
    const client = createClient(config, "google-resolved");
    const response = await client.chat(mockMessages, [], abortSignal);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0].toolName).toBe("get_weather");
    expect(response.toolCalls![0].args).toEqual({ location: "LA" });
    expect(response.toolCalls![0].toolCallId).toBeDefined();
  });
});

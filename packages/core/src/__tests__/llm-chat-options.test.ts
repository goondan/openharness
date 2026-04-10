import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, ToolDefinition } from "@goondan/openharness-types";

/**
 * FR-CORE-009: LlmClient.chat()은 선택적 4번째 인자 LlmChatOptions를 받아
 *              호출별로 model, temperature, maxTokens를 오버라이드할 수 있다.
 *
 * EXEC-CONST-007: LlmChatOptions로 전달된 오버라이드는 해당 chat() 호출에만
 *                 적용된다. 에이전트의 기본 모델 구성을 영구적으로 변경하지 않는다.
 *
 * 테스트 전략:
 * - ai-sdk의 generateText를 모킹하여 전달되는 파라미터를 캡처
 * - options 전달 / 미전달 / 부분 전달 / 연속 호출 시나리오 검증
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockMessages: Message[] = [
  { id: "1", data: { role: "user", content: "Hello" } },
];

const emptyTools: ToolDefinition[] = [];
const signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// Unified AI SDK adapter — LlmChatOptions 전달 검증
// ---------------------------------------------------------------------------

describe("FR-CORE-009: LlmChatOptions via AI SDK adapter", () => {
  let createFn: typeof import("../models/index.js")["createLlmClient"];
  let capturedArgs: Array<Record<string, unknown>>;
  let capturedModelIds: string[];

  beforeEach(async () => {
    vi.resetModules();
    capturedArgs = [];
    capturedModelIds = [];

    vi.doMock("ai", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ai")>();
      return {
        ...actual,
        generateText: vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
          capturedArgs.push({ ...args });
          // Capture the model ID from the mock language model
          const model = args["model"] as { modelId?: string };
          if (model?.modelId) {
            capturedModelIds.push(model.modelId);
          }
          return {
            text: "response",
            toolCalls: [],
            finishReason: "stop",
            response: { messages: [] },
          };
        }),
      };
    });

    // Mock all three providers — each returns a languageModel that captures the model ID
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockImplementation((modelId: string) => ({
          modelId,
          provider: "anthropic",
        })),
      }),
    }));
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockImplementation((modelId: string) => ({
          modelId,
          provider: "openai",
        })),
      }),
    }));
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: vi.fn().mockReturnValue({
        languageModel: vi.fn().mockImplementation((modelId: string) => ({
          modelId,
          provider: "google",
        })),
      }),
    }));

    const mod = await import("../models/index.js");
    createFn = mod.createLlmClient;
  });

  // --- Anthropic ---

  it("Anthropic: uses default model when no options provided", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelIds[0]).toBe("claude-3-5-sonnet-20241022");
  });

  it("Anthropic: overrides model when options.model is provided", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");
    await client.chat(mockMessages, emptyTools, signal, { model: "claude-3-haiku-20240307" });

    expect(capturedModelIds[0]).toBe("claude-3-haiku-20240307");
  });

  it("Anthropic: overrides temperature", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");
    await client.chat(mockMessages, emptyTools, signal, { temperature: 0 });

    expect(capturedArgs[0]["temperature"]).toBe(0);
  });

  it("Anthropic: overrides maxTokens → maxOutputTokens", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");
    await client.chat(mockMessages, emptyTools, signal, { maxTokens: 100 });

    expect(capturedArgs[0]["maxOutputTokens"]).toBe(100);
  });

  it("Anthropic: partial options — only temperature, model stays default", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");
    await client.chat(mockMessages, emptyTools, signal, { temperature: 0.5 });

    expect(capturedModelIds[0]).toBe("claude-3-5-sonnet-20241022");
    expect(capturedArgs[0]["temperature"]).toBe(0.5);
  });

  // AC-16 + EXEC-CONST-007: 오버라이드는 해당 호출에만 적용
  it("Anthropic EXEC-CONST-007: options override is isolated to that single call", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");

    // 1st call: override model + temperature
    await client.chat(mockMessages, emptyTools, signal, { model: "claude-3-haiku-20240307", temperature: 0 });
    // 2nd call: no options → should use default
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelIds[0]).toBe("claude-3-haiku-20240307");
    expect(capturedArgs[0]["temperature"]).toBe(0);
    expect(capturedModelIds[1]).toBe("claude-3-5-sonnet-20241022");
    expect(capturedArgs[1]["temperature"]).toBeUndefined();
  });

  it("Anthropic: empty options object behaves same as no options", async () => {
    const client = createFn({ provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" }, "sk-ant");

    await client.chat(mockMessages, emptyTools, signal, {});
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelIds[0]).toBe(capturedModelIds[1]);
    expect(capturedArgs[0]["temperature"]).toEqual(capturedArgs[1]["temperature"]);
  });

  // --- OpenAI ---

  it("OpenAI: uses default model when no options provided", async () => {
    const client = createFn({ provider: "openai", model: "gpt-4o", apiKey: "key" }, "sk-openai");
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelIds[0]).toBe("gpt-4o");
  });

  it("OpenAI: overrides model when options.model is provided", async () => {
    const client = createFn({ provider: "openai", model: "gpt-4o", apiKey: "key" }, "sk-openai");
    await client.chat(mockMessages, emptyTools, signal, { model: "gpt-4o-mini" });

    expect(capturedModelIds[0]).toBe("gpt-4o-mini");
  });

  it("OpenAI: overrides temperature and maxTokens", async () => {
    const client = createFn({ provider: "openai", model: "gpt-4o", apiKey: "key" }, "sk-openai");
    await client.chat(mockMessages, emptyTools, signal, { temperature: 0.2, maxTokens: 500 });

    expect(capturedArgs[0]["temperature"]).toBe(0.2);
    expect(capturedArgs[0]["maxOutputTokens"]).toBe(500);
  });

  it("OpenAI EXEC-CONST-007: options override is isolated", async () => {
    const client = createFn({ provider: "openai", model: "gpt-4o", apiKey: "key" }, "sk-openai");

    await client.chat(mockMessages, emptyTools, signal, { model: "gpt-4o-mini", temperature: 0 });
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelIds[0]).toBe("gpt-4o-mini");
    expect(capturedArgs[0]["temperature"]).toBe(0);
    expect(capturedModelIds[1]).toBe("gpt-4o");
    expect(capturedArgs[1]["temperature"]).toBeUndefined();
  });

  // --- Google ---

  it("Google: uses default model when no options provided", async () => {
    const client = createFn({ provider: "google", model: "gemini-1.5-pro", apiKey: "key" }, "g-key");
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelIds[0]).toBe("gemini-1.5-pro");
  });

  it("Google: overrides model when options.model is provided", async () => {
    const client = createFn({ provider: "google", model: "gemini-1.5-pro", apiKey: "key" }, "g-key");
    await client.chat(mockMessages, emptyTools, signal, { model: "gemini-1.5-flash" });

    expect(capturedModelIds[0]).toBe("gemini-1.5-flash");
  });
});

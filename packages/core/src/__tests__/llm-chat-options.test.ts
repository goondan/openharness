import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LlmClient,
  LlmChatOptions,
  LlmResponse,
  Message,
  ToolDefinition,
} from "@goondan/openharness-types";

/**
 * FR-CORE-009: LlmClient.chat()은 선택적 4번째 인자 LlmChatOptions를 받아
 *              호출별로 model, temperature, maxTokens를 오버라이드할 수 있다.
 *
 * EXEC-CONST-007: LlmChatOptions로 전달된 오버라이드는 해당 chat() 호출에만
 *                 적용된다. 에이전트의 기본 모델 구성을 영구적으로 변경하지 않는다.
 *
 * 테스트 전략:
 * - 모델 어댑터를 모킹하여 SDK에 전달되는 requestParams를 캡처
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
// Anthropic adapter — LlmChatOptions 전달 검증
// ---------------------------------------------------------------------------

describe("FR-CORE-009: LlmChatOptions — Anthropic adapter", () => {
  let createFn: typeof import("../models/index.js")["createLlmClient"];
  let capturedParams: Record<string, unknown>[];

  beforeEach(async () => {
    vi.resetModules();
    capturedParams = [];

    vi.doMock("@anthropic-ai/sdk", () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
            capturedParams.push({ ...params });
            return {
              content: [{ type: "text", text: "response" }],
              stop_reason: "end_turn",
            };
          }),
        },
      })),
    }));

    const mod = await import("../models/index.js");
    createFn = mod.createLlmClient;
  });

  it("uses default model when no options provided", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedParams[0]["model"]).toBe("claude-3-5-sonnet-20241022");
  });

  it("overrides model when options.model is provided", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");
    await client.chat(mockMessages, emptyTools, signal, { model: "claude-3-haiku-20240307" });

    expect(capturedParams[0]["model"]).toBe("claude-3-haiku-20240307");
  });

  it("overrides temperature when options.temperature is provided", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");
    await client.chat(mockMessages, emptyTools, signal, { temperature: 0 });

    expect(capturedParams[0]["temperature"]).toBe(0);
  });

  it("overrides maxTokens when options.maxTokens is provided", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");
    await client.chat(mockMessages, emptyTools, signal, { maxTokens: 100 });

    expect(capturedParams[0]["max_tokens"]).toBe(100);
  });

  it("partial options: only temperature, model stays default", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");
    await client.chat(mockMessages, emptyTools, signal, { temperature: 0.5 });

    expect(capturedParams[0]["model"]).toBe("claude-3-5-sonnet-20241022");
    expect(capturedParams[0]["temperature"]).toBe(0.5);
  });

  // AC-16 + EXEC-CONST-007: 오버라이드는 해당 호출에만 적용, 이후 호출은 기본값
  it("EXEC-CONST-007: options override is isolated to that single call", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");

    // 1st call: override model
    await client.chat(mockMessages, emptyTools, signal, { model: "claude-3-haiku-20240307", temperature: 0 });
    // 2nd call: no options → should use default
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedParams[0]["model"]).toBe("claude-3-haiku-20240307");
    expect(capturedParams[0]["temperature"]).toBe(0);
    expect(capturedParams[1]["model"]).toBe("claude-3-5-sonnet-20241022");
    expect(capturedParams[1]["temperature"]).toBeUndefined();
  });

  it("empty options object behaves same as no options", async () => {
    const config = { provider: "anthropic", model: "claude-3-5-sonnet-20241022", apiKey: "key" };
    const client = createFn(config, "sk-ant-resolved");

    await client.chat(mockMessages, emptyTools, signal, {});
    await client.chat(mockMessages, emptyTools, signal);

    // Both calls should have same model and no temperature
    expect(capturedParams[0]["model"]).toBe(capturedParams[1]["model"]);
    expect(capturedParams[0]["temperature"]).toEqual(capturedParams[1]["temperature"]);
  });
});

// ---------------------------------------------------------------------------
// OpenAI adapter — LlmChatOptions 전달 검증
// ---------------------------------------------------------------------------

describe("FR-CORE-009: LlmChatOptions — OpenAI adapter", () => {
  let createFn: typeof import("../models/index.js")["createLlmClient"];
  let capturedParams: Record<string, unknown>[];

  beforeEach(async () => {
    vi.resetModules();
    capturedParams = [];

    vi.doMock("openai", () => ({
      default: vi.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
              capturedParams.push({ ...params });
              return {
                choices: [{
                  message: { content: "response", tool_calls: null },
                  finish_reason: "stop",
                }],
              };
            }),
          },
        },
      })),
    }));

    const mod = await import("../models/index.js");
    createFn = mod.createLlmClient;
  });

  it("uses default model when no options provided", async () => {
    const config = { provider: "openai", model: "gpt-4o", apiKey: "key" };
    const client = createFn(config, "sk-openai-resolved");
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedParams[0]["model"]).toBe("gpt-4o");
  });

  it("overrides model when options.model is provided", async () => {
    const config = { provider: "openai", model: "gpt-4o", apiKey: "key" };
    const client = createFn(config, "sk-openai-resolved");
    await client.chat(mockMessages, emptyTools, signal, { model: "gpt-4o-mini" });

    expect(capturedParams[0]["model"]).toBe("gpt-4o-mini");
  });

  it("overrides temperature and maxTokens", async () => {
    const config = { provider: "openai", model: "gpt-4o", apiKey: "key" };
    const client = createFn(config, "sk-openai-resolved");
    await client.chat(mockMessages, emptyTools, signal, { temperature: 0.2, maxTokens: 500 });

    expect(capturedParams[0]["temperature"]).toBe(0.2);
    expect(capturedParams[0]["max_tokens"]).toBe(500);
  });

  // AC-16 + EXEC-CONST-007: 격리 검증
  it("EXEC-CONST-007: options override is isolated — next call uses defaults", async () => {
    const config = { provider: "openai", model: "gpt-4o", apiKey: "key" };
    const client = createFn(config, "sk-openai-resolved");

    await client.chat(mockMessages, emptyTools, signal, { model: "gpt-4o-mini", temperature: 0 });
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedParams[0]["model"]).toBe("gpt-4o-mini");
    expect(capturedParams[0]["temperature"]).toBe(0);
    expect(capturedParams[1]["model"]).toBe("gpt-4o");
    expect(capturedParams[1]["temperature"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Google adapter — LlmChatOptions 전달 검증
// ---------------------------------------------------------------------------

describe("FR-CORE-009: LlmChatOptions — Google adapter", () => {
  let createFn: typeof import("../models/index.js")["createLlmClient"];
  let capturedModelName: string[];
  let capturedGenerateParams: Record<string, unknown>[];

  beforeEach(async () => {
    vi.resetModules();
    capturedModelName = [];
    capturedGenerateParams = [];

    vi.doMock("@google/generative-ai", () => ({
      GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
        getGenerativeModel: vi.fn().mockImplementation(({ model }: { model: string }) => {
          capturedModelName.push(model);
          return {
            generateContent: vi.fn().mockImplementation(async (params: unknown) => {
              capturedGenerateParams.push(params as Record<string, unknown>);
              return {
                response: {
                  candidates: [{
                    content: { parts: [{ text: "response" }] },
                    finishReason: "STOP",
                  }],
                },
              };
            }),
          };
        }),
      })),
    }));

    const mod = await import("../models/index.js");
    createFn = mod.createLlmClient;
  });

  it("uses default model when no options provided", async () => {
    const config = { provider: "google", model: "gemini-1.5-pro", apiKey: "key" };
    const client = createFn(config, "google-resolved");
    await client.chat(mockMessages, emptyTools, signal);

    expect(capturedModelName[0]).toBe("gemini-1.5-pro");
  });

  it("overrides model when options.model is provided", async () => {
    const config = { provider: "google", model: "gemini-1.5-pro", apiKey: "key" };
    const client = createFn(config, "google-resolved");
    await client.chat(mockMessages, emptyTools, signal, { model: "gemini-1.5-flash" });

    expect(capturedModelName[0]).toBe("gemini-1.5-flash");
  });
});

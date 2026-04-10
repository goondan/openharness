/**
 * E2E tests with real Google Gemini API.
 *
 * These tests make actual API calls and are skipped unless GOOGLE_API_KEY is set.
 * Run with: GOOGLE_API_KEY=... npx vitest run packages/core/src/__tests__/integration/e2e-google.test.ts
 */

import { describe, it, expect } from "vitest";
import { createHarness } from "../../create-harness.js";
import type { HarnessConfig, Extension, ExtensionApi, ToolDefinition } from "@goondan/openharness-types";

const API_KEY = process.env["GOOGLE_API_KEY"];
const describeE2E = API_KEY ? describe : describe.skip;

describeE2E("E2E: Google Gemini API", () => {
  // -----------------------------------------------------------------------
  // Test 1: Simple text response — no extensions, no tools
  // -----------------------------------------------------------------------
  it("simple text response without extensions", async () => {
    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "google", model: "gemini-2.5-flash", apiKey: API_KEY! },
        },
      },
    };

    const runtime = await createHarness(config);
    const result = await runtime.processTurn("default", "Reply with exactly: PONG");

    expect(result.status).toBe("completed");
    expect(result.text).toBeDefined();
    expect(result.text!.toUpperCase()).toContain("PONG");
    expect(result.steps.length).toBe(1);

    await runtime.close();
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 2: BasicSystemPrompt extension injects a strong response style
  // -----------------------------------------------------------------------
  it("BasicSystemPrompt extension injects system prompt that affects response", async () => {
    function BasicSystemPrompt(text: string): Extension {
      return {
        name: "basic-system-prompt",
        register(api: ExtensionApi): void {
          api.pipeline.register(
            "turn",
            async (ctx, next) => {
              ctx.conversation.emit({
                type: "append",
                message: {
                  id: `sys-${Date.now()}`,
                  data: { role: "system", content: text },
                  metadata: { __createdBy: "basic-system-prompt" },
                },
              });
              return next();
            },
            { priority: 10 },
          );
        },
      };
    }

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "google", model: "gemini-2.5-flash", apiKey: API_KEY! },
          extensions: [BasicSystemPrompt("You are a pirate. Every reply must sound like a pirate and use words like ahoy or matey.")],
        },
      },
    };

    const runtime = await createHarness(config);
    const result = await runtime.processTurn("default", "Say hello.");

    expect(result.status).toBe("completed");
    expect(result.text).toBeDefined();
    const text = result.text!.toLowerCase();
    const pirateWords = ["arr", "ahoy", "matey", "ye", "aye", "captain", "ship", "treasure", "sea", "sail"];
    const hasPirateWord = pirateWords.some((w) => text.includes(w));
    expect(hasPirateWord).toBe(true);

    await runtime.close();
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 3: Tool calling — LLM invokes a tool and uses the result
  // -----------------------------------------------------------------------
  it("tool calling — LLM invokes a tool and uses its result", async () => {
    const weatherTool: ToolDefinition = {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
      handler: async (args) => {
        return { type: "text", text: `The weather in ${(args as { city: string }).city} is 22°C and sunny.` };
      },
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "google", model: "gemini-2.5-flash", apiKey: API_KEY! },
          tools: [weatherTool],
        },
      },
    };

    const runtime = await createHarness(config);
    const result = await runtime.processTurn("default", "What is the weather in Tokyo? Use the get_weather tool.");

    expect(result.status).toBe("completed");
    expect(result.text).toBeDefined();
    expect(result.text!).toContain("22");
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    const toolStep = result.steps.find((s) => s.toolCalls.length > 0);
    expect(toolStep).toBeDefined();
    expect(toolStep!.toolCalls[0].toolName).toBe("get_weather");

    await runtime.close();
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 4: Multi-turn conversation preserves context
  // -----------------------------------------------------------------------
  it("multi-turn conversation preserves context", async () => {
    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "google", model: "gemini-2.5-flash", apiKey: API_KEY! },
        },
      },
    };

    const runtime = await createHarness(config);
    const convId = "e2e-google-multi-turn";

    const result1 = await runtime.processTurn("default", "Remember this: the secret code is ALPHA-7. Just say OK.", {
      conversationId: convId,
    });
    expect(result1.status).toBe("completed");

    const result2 = await runtime.processTurn("default", "What is the secret code I told you?", {
      conversationId: convId,
    });
    expect(result2.status).toBe("completed");
    expect(result2.text).toBeDefined();
    expect(result2.text!).toContain("ALPHA-7");

    await runtime.close();
  }, 60_000);
});

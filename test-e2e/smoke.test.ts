/**
 * Smoke test for the test-e2e harness config.
 *
 * Verifies that the harness config loads correctly and that the assistant agent
 * can produce a response via the Anthropic API.
 *
 * Skipped unless ANTHROPIC_API_KEY is set.
 * Run with: ANTHROPIC_API_KEY=... npx vitest run test-e2e/smoke.test.ts
 */

import { describe, it, expect } from "vitest";
import { createHarness } from "@goondan/openharness";
import type { HarnessConfig } from "@goondan/openharness-types";

// Import the config to verify it loads without error
import config from "./harness.config.js";

const API_KEY = process.env["ANTHROPIC_API_KEY"];
const describeE2E = API_KEY ? describe : describe.skip;

describe("harness.config.ts", () => {
  it("exports a valid HarnessConfig with an assistant agent", () => {
    expect(config).toBeDefined();
    expect(config.agents).toBeDefined();
    expect(config.agents["assistant"]).toBeDefined();
    expect(config.agents["assistant"].model.provider).toBe("anthropic");
    expect(config.agents["assistant"].model.model).toBe("claude-haiku-4-5-20251001");
    expect(config.agents["assistant"].extensions).toHaveLength(1);
    expect(config.agents["assistant"].tools).toHaveLength(1);
  });
});

describeE2E("E2E: assistant agent smoke test", () => {
  it("responds to a simple prompt", async () => {
    // Build a runtime-ready config with the real API key resolved
    const runtimeConfig: HarnessConfig = {
      agents: {
        assistant: {
          model: {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            apiKey: API_KEY!,
          },
        },
      },
    };

    const runtime = await createHarness(runtimeConfig);
    const result = await runtime.processTurn("assistant", "Reply with exactly: PONG");

    expect(result.status).toBe("completed");
    expect(result.text).toBeDefined();
    expect(result.text!.toUpperCase()).toContain("PONG");

    await runtime.close();
  }, 30_000);
});

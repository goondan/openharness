import { defineHarness, env } from "@goondan/openharness-types";
import { BasicSystemPrompt } from "@goondan/openharness-base";
import { BashTool } from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      model: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        apiKey: env("ANTHROPIC_API_KEY"),
      },
      extensions: [
        BasicSystemPrompt(
          "You are a helpful assistant. Answer concisely in the language of the user's message.",
        ),
      ],
      tools: [BashTool()],
    },
  },
});

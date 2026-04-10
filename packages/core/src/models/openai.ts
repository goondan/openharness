import type { ModelConfig, EnvRef } from "@goondan/openharness-types";

/**
 * Factory function that returns a ModelConfig for OpenAI models.
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function OpenAI(config: {
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
}): ModelConfig {
  return { provider: "openai", ...config };
}

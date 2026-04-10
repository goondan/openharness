import type { ModelConfig, EnvRef } from "@goondan/openharness-types";

/**
 * Factory function that returns a ModelConfig for Anthropic models.
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function Anthropic(config: {
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
}): ModelConfig {
  return { provider: "anthropic", ...config };
}

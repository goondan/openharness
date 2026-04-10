import type { ModelConfig, EnvRef } from "@goondan/openharness-types";

/**
 * Factory function that returns a ModelConfig for Google models.
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function Google(config: {
  model: string;
  apiKey: string | EnvRef;
}): ModelConfig {
  return { provider: "google", ...config };
}

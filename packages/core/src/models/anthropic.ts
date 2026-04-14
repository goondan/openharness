import type { AnthropicProviderSettings } from "@ai-sdk/anthropic";
import type {
  EnvRef,
  EnvResolvable,
  ModelConfig,
} from "@goondan/openharness-types";

export type AnthropicConfig = {
  model: string;
  baseUrl?: string | EnvRef;
} & EnvResolvable<AnthropicProviderSettings>;

/**
 * Factory function that returns a ModelConfig for Anthropic models.
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function Anthropic(config: AnthropicConfig): ModelConfig {
  const { model, baseUrl, ...providerOptions } = config;
  const normalizedProviderOptions = {
    ...providerOptions,
    ...(providerOptions.baseURL === undefined && baseUrl !== undefined
      ? { baseURL: baseUrl }
      : {}),
  };

  return {
    provider: "anthropic",
    model,
    ...(normalizedProviderOptions.apiKey !== undefined
      ? { apiKey: normalizedProviderOptions.apiKey }
      : {}),
    ...(normalizedProviderOptions.baseURL !== undefined
      ? { baseUrl: normalizedProviderOptions.baseURL }
      : {}),
    ...(Object.keys(normalizedProviderOptions).length > 0
      ? { providerOptions: normalizedProviderOptions }
      : {}),
  };
}

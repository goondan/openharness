import type { OpenAIProviderSettings } from "@ai-sdk/openai";
import type {
  EnvRef,
  EnvResolvable,
  ModelConfig,
} from "@goondan/openharness-types";

export type OpenAIConfig = {
  model: string;
  baseUrl?: string | EnvRef;
} & EnvResolvable<OpenAIProviderSettings>;

/**
 * Factory function that returns a ModelConfig for OpenAI models.
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function OpenAI(config: OpenAIConfig): ModelConfig {
  const { model, baseUrl, ...providerOptions } = config;
  const normalizedProviderOptions = {
    ...providerOptions,
    ...(providerOptions.baseURL === undefined && baseUrl !== undefined
      ? { baseURL: baseUrl }
      : {}),
  };

  return {
    provider: "openai",
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

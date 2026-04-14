import type { GoogleGenerativeAIProviderSettings } from "@ai-sdk/google";
import type {
  EnvRef,
  EnvResolvable,
  ModelConfig,
} from "@goondan/openharness-types";

export type GoogleConfig = {
  model: string;
  baseUrl?: string | EnvRef;
} & EnvResolvable<GoogleGenerativeAIProviderSettings>;

/**
 * Factory function that returns a ModelConfig for Google models.
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function Google(config: GoogleConfig): ModelConfig {
  const { model, baseUrl, ...providerOptions } = config;
  const normalizedProviderOptions = {
    ...providerOptions,
    ...(providerOptions.baseURL === undefined && baseUrl !== undefined
      ? { baseURL: baseUrl }
      : {}),
  };

  return {
    provider: "google",
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

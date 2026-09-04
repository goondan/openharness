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

function buildOpenAIModelConfig(
  provider: "openai" | "openai-chat",
  config: OpenAIConfig,
): ModelConfig {
  const { model, baseUrl, ...providerOptions } = config;
  const normalizedProviderOptions = {
    ...providerOptions,
    ...(providerOptions.baseURL === undefined && baseUrl !== undefined
      ? { baseURL: baseUrl }
      : {}),
  };

  return {
    provider,
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

/**
 * Factory function that returns a ModelConfig for OpenAI models.
 * Requests go through the Responses API (`/v1/responses`).
 * The actual LLM call is handled by the unified AI SDK adapter.
 */
export function OpenAI(config: OpenAIConfig): ModelConfig {
  return buildOpenAIModelConfig("openai", config);
}

/**
 * Factory function that returns a ModelConfig for OpenAI-compatible models that
 * only serve the Chat Completions API (`/v1/chat/completions`), e.g. gateways
 * that front non-OpenAI models behind an OpenAI-compatible surface.
 * Accepts the same options as `OpenAI()`.
 */
export function OpenAIChat(config: OpenAIConfig): ModelConfig {
  return buildOpenAIModelConfig("openai-chat", config);
}

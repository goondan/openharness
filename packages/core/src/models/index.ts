import type { ModelConfig, LlmClient } from "@goondan/openharness-types";
import { ConfigError } from "../errors.js";
import { createAiSdkClient } from "./ai-sdk-adapter.js";

export { Anthropic } from "./anthropic.js";
export { OpenAI } from "./openai.js";
export { Google } from "./google.js";

const SUPPORTED_PROVIDERS = new Set(["anthropic", "openai", "google"]);

export function createLlmClient(
  config: ModelConfig,
  apiKey?: string,
): LlmClient {
  if (!SUPPORTED_PROVIDERS.has(config.provider)) {
    throw new ConfigError(`Unknown model provider: ${config.provider}`);
  }

  const providerOptions = { ...(config.providerOptions ?? {}) };
  const effectiveBaseUrl = providerOptions["baseURL"] ?? config.baseUrl;
  if (effectiveBaseUrl !== undefined && providerOptions["baseURL"] === undefined) {
    providerOptions["baseURL"] = effectiveBaseUrl;
  }

  const effectiveApiKey =
    apiKey ?? (typeof config.apiKey === "string" ? config.apiKey : undefined);
  const hasProviderApiKey = providerOptions["apiKey"] !== undefined;
  const hasAnthropicAuthToken =
    config.provider === "anthropic" &&
    providerOptions["authToken"] !== undefined;

  if (
    effectiveApiKey !== undefined &&
    !hasProviderApiKey &&
    !hasAnthropicAuthToken
  ) {
    providerOptions["apiKey"] = effectiveApiKey;
  }

  return createAiSdkClient(config.provider, config.model, providerOptions);
}

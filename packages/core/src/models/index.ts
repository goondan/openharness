import type { ModelConfig, LlmClient } from "@goondan/openharness-types";
import { ConfigError } from "../errors.js";
import { createAiSdkClient } from "./ai-sdk-adapter.js";

export { Anthropic } from "./anthropic.js";
export { OpenAI } from "./openai.js";
export { Google } from "./google.js";

const SUPPORTED_PROVIDERS = new Set(["anthropic", "openai", "google"]);

export function createLlmClient(config: ModelConfig, apiKey: string): LlmClient {
  if (!SUPPORTED_PROVIDERS.has(config.provider)) {
    throw new ConfigError(`Unknown model provider: ${config.provider}`);
  }
  return createAiSdkClient(config.provider, config.model, apiKey, config.baseUrl);
}

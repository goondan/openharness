import type { ModelConfig, LlmClient } from "@goondan/openharness-types";
import { ConfigError } from "../errors.js";
import { createAnthropicClient } from "./anthropic.js";
import { createOpenAIClient } from "./openai.js";
import { createGoogleClient } from "./google.js";

export { Anthropic } from "./anthropic.js";
export { OpenAI } from "./openai.js";
export { Google } from "./google.js";

export function createLlmClient(config: ModelConfig, apiKey: string): LlmClient {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicClient(config.model, apiKey, config.baseUrl);
    case "openai":
      return createOpenAIClient(config.model, apiKey, config.baseUrl);
    case "google":
      return createGoogleClient(config.model, apiKey);
    default:
      throw new ConfigError(`Unknown model provider: ${config.provider}`);
  }
}

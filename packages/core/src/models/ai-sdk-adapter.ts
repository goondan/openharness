import { generateText, streamText, tool as aiTool, jsonSchema } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type {
  LlmClient,
  LlmChatOptions,
  LlmStreamCallbacks,
  LlmResponse,
  Message,
  ToolDefinition,
  JsonObject,
} from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Provider instance cache — keyed by provider name
// ---------------------------------------------------------------------------

type ProviderFactory = {
  languageModel: (modelId: string) => LanguageModel;
};

const providerCache = new Map<string, ProviderFactory>();

async function getProviderFactory(
  provider: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderFactory> {
  const cacheKey = `${provider}:${apiKey}:${baseUrl ?? ""}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  let factory: ProviderFactory;

  switch (provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const p = createAnthropic({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
      factory = { languageModel: (m: string) => p.languageModel(m) };
      break;
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const p = createOpenAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
      factory = { languageModel: (m: string) => p.languageModel(m) };
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const p = createGoogleGenerativeAI({ apiKey });
      factory = { languageModel: (m: string) => p.languageModel(m) };
      break;
    }
    default:
      throw new Error(`Unknown model provider: ${provider}`);
  }

  providerCache.set(cacheKey, factory);
  return factory;
}

// ---------------------------------------------------------------------------
// Tool conversion — OpenHarness ToolDefinition[] → ai-sdk ToolSet
// ---------------------------------------------------------------------------

function toAiSdkTools(
  tools: ToolDefinition[],
): Record<string, ReturnType<typeof aiTool>> {
  const result: Record<string, ReturnType<typeof aiTool>> = {};
  for (const t of tools) {
    result[t.name] = aiTool({
      description: t.description,
      inputSchema: jsonSchema(
        t.parameters ?? { type: "object", properties: {} },
      ),
      // No execute handler — openharness manages tool execution in its own step loop
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Message conversion — extract ModelMessage from envelope
// ---------------------------------------------------------------------------

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m) => m.data);
}

// ---------------------------------------------------------------------------
// Public: createAiSdkClient
// ---------------------------------------------------------------------------

export function createAiSdkClient(
  provider: string,
  defaultModel: string,
  apiKey: string,
  baseUrl?: string,
): LlmClient {
  return {
    async chat(
      messages: Message[],
      tools: ToolDefinition[],
      signal: AbortSignal,
      options?: LlmChatOptions,
    ): Promise<LlmResponse> {
      const factory = await getProviderFactory(provider, apiKey, baseUrl);
      const effectiveModel = options?.model ?? defaultModel;
      const model = factory.languageModel(effectiveModel);

      const aiTools =
        tools.length > 0 ? toAiSdkTools(tools) : undefined;

      const result = await generateText({
        model,
        messages: toModelMessages(messages),
        ...(aiTools ? { tools: aiTools } : {}),
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.maxTokens !== undefined
          ? { maxOutputTokens: options.maxTokens }
          : {}),
        abortSignal: signal,
      });

      // Extract text (undefined if empty)
      const text =
        result.text && result.text.trim().length > 0
          ? result.text
          : undefined;

      // Extract tool calls
      // ai-sdk v6 uses `input` (not `args`) on tool call objects.
      const toolCalls =
        result.toolCalls && result.toolCalls.length > 0
          ? result.toolCalls.map((tc) => ({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: (tc.input ?? {}) as JsonObject,
            }))
          : undefined;

      return { text, toolCalls };
    },

    async streamChat(
      messages: Message[],
      tools: ToolDefinition[],
      signal: AbortSignal,
      callbacks: LlmStreamCallbacks,
      options?: LlmChatOptions,
    ): Promise<LlmResponse> {
      const factory = await getProviderFactory(provider, apiKey, baseUrl);
      const effectiveModel = options?.model ?? defaultModel;
      const model = factory.languageModel(effectiveModel);

      const aiTools =
        tools.length > 0 ? toAiSdkTools(tools) : undefined;

      const result = streamText({
        model,
        messages: toModelMessages(messages),
        ...(aiTools ? { tools: aiTools } : {}),
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.maxTokens !== undefined
          ? { maxOutputTokens: options.maxTokens }
          : {}),
        abortSignal: signal,
      });

      // Track toolCallId → toolName from tool-input-start events
      const toolNameMap = new Map<string, string>();

      // Consume fullStream for granular delta events
      // ai-sdk v6 TextStreamPart uses: text-delta.text, tool-input-start.id, tool-input-delta.{id,delta}
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            callbacks.onTextDelta?.(part.text);
            break;
          case "tool-input-start":
            toolNameMap.set(part.id, part.toolName);
            break;
          case "tool-input-delta":
            callbacks.onToolCallDelta?.(
              part.id,
              toolNameMap.get(part.id) ?? "",
              part.delta,
            );
            break;
        }
      }

      // After stream completes, build LlmResponse from resolved promises
      const text = await result.text;
      const toolCalls = await result.toolCalls;

      return {
        text: text && text.trim().length > 0 ? text : undefined,
        toolCalls:
          toolCalls && toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: (tc.input ?? {}) as JsonObject,
              }))
            : undefined,
      };
    },
  };
}

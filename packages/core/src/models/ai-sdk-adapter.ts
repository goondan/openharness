import {
  generateText,
  streamText,
  tool as aiTool,
  jsonSchema,
  type Tool as AiSdkTool,
  type LanguageModelUsage,
} from "ai";
import type { AnthropicProviderSettings } from "@ai-sdk/anthropic";
import type { GoogleGenerativeAIProviderSettings } from "@ai-sdk/google";
import type { OpenAIProviderSettings } from "@ai-sdk/openai";
import type { LanguageModel, ModelMessage } from "ai";
import type {
  LlmClient,
  LlmChatOptions,
  LlmStreamCallbacks,
  LlmResponse,
  LlmFinishReason,
  LlmUsage,
  Message,
  ToolDefinition,
} from "@goondan/openharness-types";
import { isJsonSchemaWrapper } from "@goondan/openharness-types";
import { normalizeToolArgs } from "../tool-args.js";

type ProviderFactory = {
  languageModel: (modelId: string) => LanguageModel;
};

async function getProviderFactory(
  provider: string,
  providerOptions: Record<string, unknown>,
): Promise<ProviderFactory> {
  let factory: ProviderFactory;

  switch (provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const p = createAnthropic(providerOptions as AnthropicProviderSettings);
      factory = { languageModel: (m: string) => p.languageModel(m) };
      break;
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const p = createOpenAI(providerOptions as OpenAIProviderSettings);
      factory = { languageModel: (m: string) => p.languageModel(m) };
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const p = createGoogleGenerativeAI(
        providerOptions as GoogleGenerativeAIProviderSettings,
      );
      factory = { languageModel: (m: string) => p.languageModel(m) };
      break;
    }
    default:
      throw new Error(`Unknown model provider: ${provider}`);
  }

  return factory;
}

// ---------------------------------------------------------------------------
// Tool conversion — OpenHarness ToolDefinition[] → ai-sdk ToolSet
// ---------------------------------------------------------------------------

function toAiSdkTools(
  tools: ToolDefinition[],
): Record<string, AiSdkTool<unknown, never>> {
  const result: Record<string, AiSdkTool<unknown, never>> = {};
  for (const t of tools) {
    result[t.name] = aiTool({
      description: t.description,
      inputSchema: isJsonSchemaWrapper(t.parameters)
        ? t.parameters
        : jsonSchema(
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

const LLM_FINISH_REASONS = new Set<LlmFinishReason>([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);

function normalizeFinishReason(value: unknown): LlmFinishReason | undefined {
  return typeof value === "string" && LLM_FINISH_REASONS.has(value as LlmFinishReason)
    ? (value as LlmFinishReason)
    : undefined;
}

function toLlmUsage(usage: LanguageModelUsage | undefined): LlmUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokenDetails: usage.inputTokenDetails
      ? {
          cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
          cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
        }
      : undefined,
    outputTokenDetails: usage.outputTokenDetails
      ? {
          reasoningTokens: usage.outputTokenDetails.reasoningTokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public: createAiSdkClient
// ---------------------------------------------------------------------------

export function createAiSdkClient(
  provider: string,
  defaultModel: string,
  providerOptions: Record<string, unknown> = {},
): LlmClient {
  const providerFactoryPromise = getProviderFactory(provider, providerOptions);

  return {
    async chat(
      messages: Message[],
      tools: ToolDefinition[],
      signal: AbortSignal,
      options?: LlmChatOptions,
    ): Promise<LlmResponse> {
      const factory = await providerFactoryPromise;
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
              args: normalizeToolArgs(tc.input ?? {}),
            }))
          : undefined;

      const usage = toLlmUsage(result.usage);

      return {
        text,
        toolCalls,
        finishReason: normalizeFinishReason(result.finishReason),
        rawFinishReason: result.rawFinishReason,
        ...(usage ? { usage } : {}),
      };
    },

    async streamChat(
      messages: Message[],
      tools: ToolDefinition[],
      signal: AbortSignal,
      callbacks: LlmStreamCallbacks,
      options?: LlmChatOptions,
    ): Promise<LlmResponse> {
      const factory = await providerFactoryPromise;
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
      const finishReason = await result.finishReason;
      const rawFinishReason = await result.rawFinishReason;
      const usage = toLlmUsage(await result.usage);

      return {
        text: text && text.trim().length > 0 ? text : undefined,
        finishReason: normalizeFinishReason(finishReason),
        rawFinishReason,
        toolCalls:
          toolCalls && toolCalls.length > 0
            ? toolCalls.map((tc) => ({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: normalizeToolArgs(tc.input ?? {}),
              }))
            : undefined,
        ...(usage ? { usage } : {}),
      };
    },
  };
}

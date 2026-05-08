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
import { normalizeToolArgsResult } from "../tool-args.js";

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

function toAiSdkPrompt(messages: Message[]): {
  messages: ModelMessage[];
  system?: string;
} {
  const nonSystemMessages: ModelMessage[] = [];
  const systemMessages: string[] = [];

  for (const message of messages) {
    const modelMessage = message.data;

    if (modelMessage.role === "system") {
      systemMessages.push(modelMessage.content);
      continue;
    }

    nonSystemMessages.push(modelMessage);
  }

  return {
    messages: nonSystemMessages,
    ...(systemMessages.length > 0
      ? { system: systemMessages.join("\n\n") }
      : {}),
  };
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

function formatInvalidToolCallReason(error: unknown): string {
  if (error instanceof Error) {
    return `Invalid tool call: ${error.message}`;
  }
  if (typeof error === "string" && error.length > 0) {
    return `Invalid tool call: ${error}`;
  }
  if (error !== undefined) {
    try {
      return `Invalid tool call: ${JSON.stringify(error)}`;
    } catch {
      return `Invalid tool call: ${String(error)}`;
    }
  }

  return "Invalid tool call: AI SDK marked the tool call as invalid.";
}

function toLlmToolCalls(
  toolCalls:
    | readonly {
        toolCallId: string;
        toolName: string;
        input?: unknown;
        invalid?: boolean;
        error?: unknown;
      }[]
    | undefined,
): LlmResponse["toolCalls"] {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((tc) => {
    const normalized = normalizeToolArgsResult(
      tc.input === undefined ? {} : tc.input,
    );

    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: normalized.args,
      ...(tc.invalid === true
        ? { invalidReason: formatInvalidToolCallReason(tc.error) }
        : normalized.ok
          ? {}
          : { invalidReason: normalized.error }),
    };
  });
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
      const prompt = toAiSdkPrompt(messages);

      const result = await generateText({
        model,
        ...prompt,
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

      // ai-sdk v6 uses `input` (not `args`) on tool call objects.
      const toolCalls = toLlmToolCalls(result.toolCalls);

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
      const prompt = toAiSdkPrompt(messages);

      const result = streamText({
        model,
        ...prompt,
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
        toolCalls: toLlmToolCalls(toolCalls),
        ...(usage ? { usage } : {}),
      };
    },
  };
}

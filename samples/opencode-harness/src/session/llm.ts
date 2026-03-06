import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { type JsonObject, type ToolCallResult, type ToolCatalogItem, validateToolCallInputAgainstCatalogSchema } from "@goondan/openharness";

export function createLanguageModel(provider: string, model: string, apiKey: string): LanguageModel {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic") {
    return createAnthropic({ apiKey }).languageModel(model);
  }
  if (normalized === "openai") {
    return createOpenAI({ apiKey }).languageModel(model);
  }
  if (normalized === "google") {
    return createGoogleGenerativeAI({ apiKey }).languageModel(model);
  }
  throw new Error(`지원하지 않는 model provider입니다: ${provider}`);
}

export function createStreamingStep(input: {
  provider: string;
  apiKey: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
  toolCatalog: ToolCatalogItem[];
  activeToolNames?: string[];
  messages: ModelMessage[];
  executeTool(input: { toolName: string; toolCallId: string; args: JsonObject }): Promise<ToolCallResult>;
}) {
  const model = createLanguageModel(input.provider, input.modelName, input.apiKey);
  const availableToolNames = new Set(input.toolCatalog.map((item) => item.name));
  const invalidToolName =
    input.toolCatalog.find((item) => item.name === "invalid" || item.name.endsWith("__invalid"))?.name ?? null;

  return streamText({
    model,
    messages: input.messages,
    tools: toStreamingToolSet(input.toolCatalog, input.executeTool),
    activeTools: input.activeToolNames,
    stopWhen: stepCountIs(1),
    maxRetries: 2,
    temperature: input.temperature,
    maxOutputTokens: input.maxTokens,
    async experimental_repairToolCall(failed) {
      const lower = failed.toolCall.toolName.toLowerCase();
      if (lower !== failed.toolCall.toolName && availableToolNames.has(lower)) {
        return {
          ...failed.toolCall,
          toolName: lower,
        };
      }
      if (invalidToolName) {
        return {
          ...failed.toolCall,
          toolName: invalidToolName,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
        };
      }
      return null;
    },
  });
}

export const streamSessionStep = createStreamingStep;

function toStreamingToolSet(
  toolCatalog: ToolCatalogItem[],
  executeTool: (input: { toolName: string; toolCallId: string; args: JsonObject }) => Promise<ToolCallResult>,
): ToolSet {
  const tools: ToolSet = {};

  for (const item of toolCatalog) {
    const schema =
      item.parameters
      ?? ({
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const);

    tools[item.name] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema, {
        validate: (value: unknown) =>
          validateToolCallInputAgainstCatalogSchema({
            toolName: item.name,
            schema,
            value,
          }),
      }),
      execute: async (rawArgs: unknown, options: unknown): Promise<unknown> => {
        const toolCallId =
          typeof options === "object"
          && options !== null
          && !Array.isArray(options)
          && typeof (options as { toolCallId?: unknown }).toolCallId === "string"
            ? ((options as { toolCallId: string }).toolCallId)
            : `${item.name}-${Date.now()}`;

        const result = await executeTool({
          toolName: item.name,
          toolCallId,
          args: ensureJsonObject(rawArgs),
        });

        if (result.status === "error") {
          const error = new Error(result.error?.message ?? `Tool ${item.name} failed`);
          if (result.error?.code) {
            Reflect.set(error, "code", result.error.code);
          }
          if (result.error?.suggestion) {
            Reflect.set(error, "suggestion", result.error.suggestion);
          }
          Reflect.set(error, "toolError", result.error ?? null);
          throw error;
        }

        return result.output ?? null;
      },
    });
  }

  return tools;
}

function ensureJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function normalizeUsage(usage: LanguageModelUsage | undefined): NormalizedUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails.reasoningTokens ?? usage?.reasoningTokens ?? 0,
    cacheReadTokens: usage?.inputTokenDetails.cacheReadTokens ?? usage?.cachedInputTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails.cacheWriteTokens ?? 0,
  };
}

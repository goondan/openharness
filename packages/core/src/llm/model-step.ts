import {
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
  type AssistantModelMessage,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

import { formatToolArgumentValidationIssues, validateToolArguments } from "../tools/executor.js";
import { isJsonObject, type JsonObject, type JsonSchemaObject, type JsonValue, type ToolCatalogItem } from "../types.js";
import type { ConversationTurn } from "../runner/conversation-state.js";
import { throwIfAborted, toAbortError } from "../utils/abort.js";

export interface ToolUseBlock {
  id: string;
  name: string;
  input: JsonObject;
}

export interface ToolCallInputIssue {
  toolCallId: string;
  toolName: string;
  reason: "invalid_tool_call" | "non_object_input";
  inputPreview?: string;
}

export interface ModelStepParseResult {
  assistantContent: unknown[];
  textBlocks: string[];
  toolUseBlocks: ToolUseBlock[];
  toolCallInputIssues: ToolCallInputIssue[];
  finishReason: FinishReason;
  rawFinishReason?: string;
}

export type ModelStepRetryKind = "empty_output" | "malformed_tool_calls";

const TOOL_CALL_INPUT_PREVIEW_MAX_CHARS = 240;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isJsonObject(value)) {
    const converted: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      converted[key] = toJsonValue(nested);
    }
    return converted;
  }

  if (value === undefined) {
    return null;
  }

  return String(value);
}

function ensureJsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    return {};
  }

  const converted: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    converted[key] = toJsonValue(nested);
  }
  return converted;
}

function readStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function createLanguageModel(provider: string, model: string, apiKey: string): LanguageModel {
  const normalizedProvider = provider.trim().toLowerCase();

  if (normalizedProvider === "anthropic") {
    return createAnthropic({ apiKey }).languageModel(model);
  }

  if (normalizedProvider === "openai") {
    return createOpenAI({ apiKey }).languageModel(model);
  }

  if (normalizedProvider === "google") {
    return createGoogleGenerativeAI({ apiKey }).languageModel(model);
  }

  throw new Error(`지원하지 않는 model provider입니다: ${provider}`);
}

type RunnerToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue };

function toToolResultOutput(value: unknown): RunnerToolResultOutput {
  if (isJsonObject(value) && value.type === "text" && typeof value.value === "string") {
    return {
      type: "text",
      value: value.value,
    };
  }

  if (isJsonObject(value) && value.type === "json" && Object.hasOwn(value, "value")) {
    return {
      type: "json",
      value: toJsonValue(value.value),
    };
  }

  if (typeof value === "string") {
    return {
      type: "text",
      value,
    };
  }

  return {
    type: "json",
    value: toJsonValue(value),
  };
}

function parseToolCallPart(block: JsonObject): { toolCallId: string; toolName: string; input: JsonObject } | undefined {
  const type = typeof block.type === "string" ? block.type : "";
  if (type !== "tool-call" && type !== "tool_call" && type !== "tool_use") {
    return undefined;
  }

  const toolCallId = readStringValue(block, "toolCallId") ?? readStringValue(block, "id");
  const toolName = readStringValue(block, "toolName") ?? readStringValue(block, "name");
  if (!toolCallId || !toolName || !isJsonObject(block.input)) {
    return undefined;
  }

  return {
    toolCallId,
    toolName,
    input: ensureJsonObject(block.input),
  };
}

function parseToolResultPart(
  block: JsonObject,
): { toolCallId: string; toolName: string; output: RunnerToolResultOutput } | undefined {
  const type = typeof block.type === "string" ? block.type : "";
  if (type !== "tool-result" && type !== "tool_result") {
    return undefined;
  }

  const toolCallId = readStringValue(block, "toolCallId") ?? readStringValue(block, "tool_use_id");
  if (!toolCallId) {
    return undefined;
  }

  const toolName = readStringValue(block, "toolName") ?? readStringValue(block, "tool_name") ?? "unknown-tool";
  const hasOutput = Object.hasOwn(block, "output");
  const rawOutput = hasOutput ? block.output : block.content;
  const isError = block.is_error === true;
  if (isError) {
    return {
      toolCallId,
      toolName,
      output: {
        type: "text",
        value: `ERROR: ${typeof rawOutput === "string" ? rawOutput : safeJsonStringify(rawOutput)}`,
      },
    };
  }

  return {
    toolCallId,
    toolName,
    output: toToolResultOutput(rawOutput),
  };
}

function normalizeAssistantContent(content: unknown): AssistantModelMessage["content"] {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return safeJsonStringify(content);
  }

  const parts: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: JsonObject }
    | { type: "tool-result"; toolCallId: string; toolName: string; output: RunnerToolResultOutput }
  > = [];

  for (const item of content) {
    if (isJsonObject(item)) {
      const toolCallPart = parseToolCallPart(item);
      if (toolCallPart) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCallPart.toolCallId,
          toolName: toolCallPart.toolName,
          input: toolCallPart.input,
        });
        continue;
      }

      const toolResultPart = parseToolResultPart(item);
      if (toolResultPart) {
        parts.push({
          type: "tool-result",
          toolCallId: toolResultPart.toolCallId,
          toolName: toolResultPart.toolName,
          output: toolResultPart.output,
        });
        continue;
      }

      if (item.type === "text" && typeof item.text === "string") {
        parts.push({ type: "text", text: item.text });
        continue;
      }
    }

    parts.push({
      type: "text",
      text: safeJsonStringify(item),
    });
  }

  return parts;
}

function normalizeUserMessages(content: unknown): ModelMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }

  if (!Array.isArray(content)) {
    return [{ role: "user", content: safeJsonStringify(content) }];
  }

  const textParts: Array<{ type: "text"; text: string }> = [];
  const toolParts: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: RunnerToolResultOutput }> =
    [];

  for (const item of content) {
    if (isJsonObject(item)) {
      const toolPart = parseToolResultPart(item);
      if (toolPart) {
        toolParts.push({
          type: "tool-result",
          toolCallId: toolPart.toolCallId,
          toolName: toolPart.toolName,
          output: toolPart.output,
        });
        continue;
      }

      if (item.type === "text" && typeof item.text === "string") {
        textParts.push({ type: "text", text: item.text });
        continue;
      }
    }

    textParts.push({
      type: "text",
      text: safeJsonStringify(item),
    });
  }

  const messages: ModelMessage[] = [];
  if (toolParts.length > 0) {
    messages.push({
      role: "tool",
      content: toolParts,
    });
  }

  if (textParts.length === 1) {
    const onlyText = textParts[0];
    if (onlyText) {
      messages.push({
        role: "user",
        content: onlyText.text,
      });
    }
  } else if (textParts.length > 1) {
    messages.push({
      role: "user",
      content: textParts,
    });
  }

  return messages;
}

function toModelMessages(turns: ConversationTurn[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const turn of turns) {
    if (turn.role === "system") {
      messages.push({
        role: "system",
        content: typeof turn.content === "string" ? turn.content : safeJsonStringify(turn.content),
      });
      continue;
    }
    if (turn.role === "assistant") {
      messages.push({
        role: "assistant",
        content: normalizeAssistantContent(turn.content),
      });
      continue;
    }

    messages.push(...normalizeUserMessages(turn.content));
  }

  return messages;
}

function createDefaultObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
  };
}

export function validateToolCallInputAgainstCatalogSchema(input: {
  toolName: string;
  schema: JsonSchemaObject;
  value: unknown;
}):
  | { success: true; value: JsonObject }
  | {
      success: false;
      error: Error;
    } {
  if (!isJsonObject(input.value)) {
    const actualType = Array.isArray(input.value) ? "array" : input.value === null ? "null" : typeof input.value;
    return {
      success: false,
      error: new Error(
        `Invalid arguments for tool '${input.toolName}': args: expected object but got ${actualType}`,
      ),
    };
  }

  const args = ensureJsonObject(input.value);
  const issues = validateToolArguments(args, input.schema, "args");
  if (issues.length > 0) {
    return {
      success: false,
      error: new Error(formatToolArgumentValidationIssues(input.toolName, issues)),
    };
  }

  return {
    success: true,
    value: args,
  };
}

function toRunnerToolSet(catalog: ToolCatalogItem[]): ToolSet {
  const tools: ToolSet = {};
  for (const item of catalog) {
    const inputSchema = item.parameters ?? createDefaultObjectSchema();
    tools[item.name] = tool({
      description: item.description,
      inputSchema: jsonSchema(inputSchema, {
        validate: (value) =>
          validateToolCallInputAgainstCatalogSchema({
            toolName: item.name,
            schema: inputSchema,
            value,
          }),
      }),
    });
  }

  return tools;
}

function toAssistantContent(messages: readonly ModelMessage[], fallbackText: string): unknown[] {
  const assistantMessage = messages.find((message): message is AssistantModelMessage => message.role === "assistant");
  if (!assistantMessage) {
    return fallbackText.trim().length > 0 ? [{ type: "text", text: fallbackText }] : [];
  }

  if (typeof assistantMessage.content === "string") {
    return [{ type: "text", text: assistantMessage.content }];
  }

  return assistantMessage.content;
}

function toAssistantToolCallContent(toolUseBlocks: readonly ToolUseBlock[]): unknown[] {
  return toolUseBlocks.map((toolUse) => ({
    type: "tool-call",
    toolCallId: toolUse.id,
    toolName: toolUse.name,
    input: toolUse.input,
  }));
}

function normalizeRawFinishReason(rawFinishReason: string | undefined): string | undefined {
  if (typeof rawFinishReason !== "string") {
    return undefined;
  }
  const trimmed = rawFinishReason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function summarizeToolCallInputPreview(value: unknown): string | undefined {
  const rawText = typeof value === "string" ? value : safeJsonStringify(value);
  const normalized = rawText.replace(/\\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= TOOL_CALL_INPUT_PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, TOOL_CALL_INPUT_PREVIEW_MAX_CHARS)}...`;
}

export function buildMalformedToolCallRetryMessage(issues: readonly ToolCallInputIssue[]): string {
  const lines = [
    "직전 tool-call 인자가 유효한 JSON object 형태가 아닙니다.",
    "도구 호출 args는 반드시 객체여야 하며, 문자열 payload는 객체의 input 필드 문자열로 전달해야 합니다.",
  ];

  const hasAgentsToolIssue = issues.some(
    (issue) => issue.toolName === "agents__send" || issue.toolName === "agents__request",
  );
  if (hasAgentsToolIssue) {
    lines.push('agents__send/agents__request 예시: {"target":"coordinator","input":"작업 결과 문자열"}');
  }

  const visibleIssues = issues.slice(0, 3);
  for (const issue of visibleIssues) {
    const reason = issue.reason === "non_object_input" ? "args가 object가 아닙니다." : "SDK가 invalid tool-call로 판정했습니다.";
    const previewText = issue.inputPreview ? ` input=${issue.inputPreview}` : "";
    lines.push(`- ${issue.toolName}(${issue.toolCallId}): ${reason}${previewText}`);
  }
  if (issues.length > visibleIssues.length) {
    lines.push(`- ... +${issues.length - visibleIssues.length}건`);
  }

  lines.push("다음 응답에서는 스키마에 맞는 tool call만 생성하세요.");
  return lines.join("\\n");
}

export function normalizeModelStepParseResult(input: {
  responseMessages: readonly ModelMessage[];
  text: string;
  toolUseBlocks: ToolUseBlock[];
  toolCallInputIssues?: ToolCallInputIssue[];
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}): ModelStepParseResult {
  const assistantContent = toAssistantContent(input.responseMessages, input.text);
  const normalizedAssistantContent =
    assistantContent.length > 0 || input.toolUseBlocks.length === 0
      ? assistantContent
      : toAssistantToolCallContent(input.toolUseBlocks);
  const text = input.text.trim();
  return {
    assistantContent: normalizedAssistantContent,
    textBlocks: text.length > 0 ? [text] : [],
    toolUseBlocks: input.toolUseBlocks,
    toolCallInputIssues: input.toolCallInputIssues ?? [],
    finishReason: input.finishReason,
    rawFinishReason: normalizeRawFinishReason(input.rawFinishReason),
  };
}

export function classifyModelStepRetryKind(input: {
  assistantContent: unknown[];
  textBlocks: string[];
  toolUseBlocks: ToolUseBlock[];
  toolCallInputIssues?: readonly ToolCallInputIssue[];
  finishReason: FinishReason;
  lastInputMessageWasToolResult?: boolean;
}): ModelStepRetryKind | undefined {
  if ((input.toolCallInputIssues?.length ?? 0) > 0) {
    return "malformed_tool_calls";
  }

  const hasToolCalls = input.toolUseBlocks.length > 0;
  if (input.finishReason === "tool-calls" && !hasToolCalls) {
    return "malformed_tool_calls";
  }

  const hasAssistantContent = input.assistantContent.length > 0;
  const hasTextBlocks = input.textBlocks.length > 0;
  if (!hasToolCalls && !hasAssistantContent && !hasTextBlocks) {
    if (input.lastInputMessageWasToolResult === true) {
      return undefined;
    }
    return "empty_output";
  }

  return undefined;
}

export async function requestModelMessage(input: {
  provider: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  toolCatalog: ToolCatalogItem[];
  turns: ConversationTurn[];
  abortSignal: AbortSignal;
}): Promise<ModelStepParseResult> {
  throwIfAborted(input.abortSignal);
  const model = createLanguageModel(input.provider, input.model, input.apiKey);
  let result;
  try {
    result = await generateText({
      model,
      messages: toModelMessages(input.turns),
      tools: toRunnerToolSet(input.toolCatalog),
      stopWhen: stepCountIs(1),
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
      abortSignal: input.abortSignal,
    });
  } catch (error) {
    if (input.abortSignal.aborted) {
      throw toAbortError(error, input.abortSignal.reason);
    }
    throw error;
  }

  const toolUseBlocks: ToolUseBlock[] = [];
  const toolCallInputIssues: ToolCallInputIssue[] = [];
  for (const toolCall of result.toolCalls) {
    const inputPreview = summarizeToolCallInputPreview(toolCall.input);
    if (toolCall.invalid === true) {
      toolCallInputIssues.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        reason: "invalid_tool_call",
        inputPreview,
      });
      continue;
    }

    if (!isJsonObject(toolCall.input)) {
      toolCallInputIssues.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        reason: "non_object_input",
        inputPreview,
      });
      continue;
    }

    toolUseBlocks.push({
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      input: ensureJsonObject(toolCall.input),
    });
  }

  return normalizeModelStepParseResult({
    responseMessages: result.response.messages,
    text: result.text,
    toolUseBlocks,
    toolCallInputIssues,
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
  });
}

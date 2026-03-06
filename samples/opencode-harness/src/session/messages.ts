import type { JsonValue, Message, ToolCallResult, ToolCatalogItem } from "@goondan/openharness";
import { convertToModelMessages, type ModelMessage, type ToolSet } from "ai";

import {
  type AssistantPart,
  type AssistantToolPart,
  type ToolPayload,
  isAssistantPart,
  readToolPayload,
} from "./protocol.js";

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createAssistantMessage(
  parts: AssistantPart[],
  stepId: string,
  metadata: Record<string, JsonValue> = {},
): Message {
  return {
    id: createId("msg"),
    data: {
      role: "assistant",
      content: parts,
    },
    metadata: {
      ...metadata,
      "opencode.assistant": true,
    },
    createdAt: new Date(),
    source: {
      type: "assistant",
      stepId,
    },
  };
}

export function createSystemMessage(text: string): Message {
  return {
    id: createId("msg"),
    data: {
      role: "system",
      content: text,
    },
    metadata: {
      pinned: true,
      "__openharness.runner.system": true,
    },
    createdAt: new Date(),
    source: {
      type: "system",
    },
  };
}

export function createUserMessage(text: string): Message {
  return {
    id: createId("msg"),
    data: {
      role: "user",
      content: text,
    },
    metadata: {},
    createdAt: new Date(),
    source: {
      type: "user",
    },
  };
}

export function cloneAssistantMessage(message: Message, parts: AssistantPart[]): Message {
  return {
    ...message,
    data: {
      ...message.data,
      content: parts,
    },
    metadata: {
      ...message.metadata,
    },
  };
}

export const replaceAssistantMessage = cloneAssistantMessage;

export function readAssistantParts(message: Message | undefined): AssistantPart[] {
  if (!message || message.data.role !== "assistant" || !Array.isArray(message.data.content)) {
    return [];
  }
  return message.data.content.filter((item): item is AssistantPart => isAssistantPart(item));
}

export function latestAssistantMessage(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.data.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

export function latestUserMessage(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.data.role === "user") {
      return message;
    }
  }
  return undefined;
}

export function latestUserMessageIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.data.role === "user") {
      return index;
    }
  }
  return -1;
}

export function extractAssistantText(partsOrContent: readonly AssistantPart[] | unknown): string {
  const parts = Array.isArray(partsOrContent)
    ? partsOrContent.filter((part): part is AssistantPart => isAssistantPart(part))
    : [];

  return parts
    .filter((part): part is Extract<AssistantPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function collectAssistantToolParts(parts: readonly AssistantPart[]): AssistantToolPart[] {
  return parts.filter((part): part is AssistantToolPart => part.type === "tool");
}

export function normalizeUsageMetadata(input: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}): Record<string, JsonValue> {
  const reasoningTokens = input.reasoningTokens ?? input.outputTokenDetails?.reasoningTokens ?? 0;
  const cacheReadTokens = input.cacheReadTokens ?? input.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? input.inputTokenDetails?.cacheWriteTokens ?? 0;

  return {
    input: input.inputTokens ?? 0,
    output: input.outputTokens ?? 0,
    total: input.totalTokens ?? 0,
    reasoning: reasoningTokens,
    cache: {
      read: cacheReadTokens,
      write: cacheWriteTokens,
    },
  };
}

function extractDataPayload(url: string): string {
  const commaIndex = url.indexOf(",");
  return commaIndex === -1 ? url : url.slice(commaIndex + 1);
}

function toToolResultOutput(payload: ToolPayload): unknown {
  const attachments = payload.attachments?.filter((attachment) => attachment.url.startsWith("data:")) ?? [];
  if (attachments.length === 0) {
    return payload.output;
  }

  return {
    text: payload.output,
    attachments: attachments.map((attachment) => ({
      mime: attachment.mediaType,
      url: attachment.url,
    })),
  };
}

function createToolSet(catalog: readonly ToolCatalogItem[]): ToolSet {
  const tools: ToolSet = {};
  for (const item of catalog) {
    tools[item.name] = {
      toModelOutput: async ({ output }: { output: unknown }) => {
        const payload = readToolPayload(output);
        const attachments = payload.attachments?.filter((attachment) => attachment.url.startsWith("data:")) ?? [];
        if (attachments.length === 0) {
          return {
            type: "text",
            value: payload.output,
          };
        }
        return {
          type: "content",
          value: [
            { type: "text", text: payload.output },
            ...attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mediaType,
              data: extractDataPayload(attachment.url),
            })),
          ],
        } as never;
      },
    } as never;
  }
  return tools;
}

function toUserParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: stringifyJson(content) }];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
      continue;
    }
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      parts.push({ type: "text", text: stringifyJson(item) });
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "text", text: record.text });
      continue;
    }
    if (
      record.type === "file"
      && typeof record.url === "string"
      && typeof record.mediaType === "string"
    ) {
      parts.push({
        type: "file",
        url: record.url,
        mediaType: record.mediaType,
        filename: typeof record.filename === "string" ? record.filename : undefined,
      });
      continue;
    }
    parts.push({ type: "text", text: stringifyJson(item) });
  }
  return parts;
}

function toAssistantParts(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [{ type: "text", text: content }] : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (!isAssistantPart(item)) {
      continue;
    }
    if (item.type === "text") {
      parts.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "reasoning") {
      parts.push({ type: "reasoning", text: item.text });
      continue;
    }
    if (item.type === "tool") {
      if (item.state.status === "completed") {
        parts.push({
          type: `tool-${item.tool}`,
          toolCallId: item.callID,
          state: "output-available",
          input: item.state.input,
          output: toToolResultOutput({
            output: item.state.output,
            title: item.state.title,
            metadata: item.state.metadata,
            attachments: item.state.attachments,
          }),
        });
        continue;
      }
      if (item.state.status === "error") {
        parts.push({
          type: `tool-${item.tool}`,
          toolCallId: item.callID,
          state: "output-error",
          input: item.state.input,
          errorText: item.state.error,
        });
        continue;
      }
      parts.push({
        type: `tool-${item.tool}`,
        toolCallId: item.callID,
        state: "output-error",
        input: item.state.input,
        errorText: "[Tool execution was interrupted]",
      });
    }
  }
  return parts;
}

function splitAssistantMessageParts(content: unknown): Array<Array<Record<string, unknown>>> {
  if (!Array.isArray(content)) {
    return [toAssistantParts(content)].filter((segment) => segment.length > 0);
  }

  const segments: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    segments.push(current);
    current = [];
  };

  for (const item of content) {
    if (!isAssistantPart(item)) {
      continue;
    }
    if (item.type === "step-start") {
      flush();
      continue;
    }

    const mapped = toAssistantParts([item]);
    if (mapped.length === 0) {
      continue;
    }
    current.push(...mapped);
  }

  flush();
  return segments;
}

export async function toModelMessages(
  messages: readonly Message[],
  toolCatalog: readonly ToolCatalogItem[] = [],
): Promise<ModelMessage[]> {
  const uiMessages: Array<{ role: "system" | "user" | "assistant"; parts: Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    if (message.data.role === "system") {
      uiMessages.push({
        role: "system" as const,
        parts: [{ type: "text", text: typeof message.data.content === "string" ? message.data.content : stringifyJson(message.data.content) }],
      });
      continue;
    }
    if (message.data.role === "assistant") {
      const segments = splitAssistantMessageParts(message.data.content);
      if (segments.length === 0) {
        continue;
      }
      for (const segment of segments) {
        uiMessages.push({
          role: "assistant" as const,
          parts: segment,
        });
      }
      continue;
    }
    uiMessages.push({
      role: "user" as const,
      parts: toUserParts(message.data.content),
    });
  }

  return await convertToModelMessages(uiMessages as never, {
    tools: createToolSet(toolCatalog),
    ignoreIncompleteToolCalls: false,
  });
}

export function buildToolResultMessage(input: { toolResults: ToolCallResult[] }): Message | undefined {
  const parts = input.toolResults.map((result) => ({
    type: "tool-result",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    output:
      result.status === "ok"
        ? readToolPayload(result.output).output
        : {
            error: result.error?.message ?? "Unknown tool error",
          },
  }));

  if (parts.length === 0) {
    return undefined;
  }

  return {
    id: createId("msg"),
    data: {
      role: "user",
      content: parts,
    },
    metadata: {
      "__opencode.toolResult": true,
    },
    createdAt: new Date(),
    source: {
      type: "user",
    },
  };
}

export function buildAttachmentMessage(input: { toolResults: ToolCallResult[] }): Message | undefined {
  const parts: Array<Record<string, unknown>> = [];

  for (const result of input.toolResults) {
    if (result.status !== "ok") {
      continue;
    }

    const payload = readToolPayload(result.output);
    for (const attachment of payload.attachments ?? []) {
      parts.push({
        type: "text",
        text: `[Attached ${attachment.mediaType}: ${attachment.filename ?? "file"} from ${result.toolName}]`,
      });
      parts.push({
        type: "file",
        url: attachment.url,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
      });
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    id: createId("msg"),
    data: {
      role: "user",
      content: parts,
    },
    metadata: {
      "__opencode.attachment": true,
    },
    createdAt: new Date(),
    source: {
      type: "user",
    },
  };
}

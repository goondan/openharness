import { generateText } from "ai";
import type { Message, ToolCatalogItem } from "@goondan/openharness";

import {
  cloneAssistantMessage,
  createAssistantMessage,
  extractAssistantText,
  readAssistantParts,
  stringifyJson,
  toModelMessages,
} from "./messages.js";

const RESERVED_TOKENS = 20_000;
const RETAIN_TAIL_MESSAGES = 8;
const PRUNE_OUTPUT_CHARS = 4_000;
const PRUNE_MINIMUM_TOKENS = 20_000;
const PRUNE_PROTECT_TOKENS = 40_000;
const PRUNE_PROTECTED_TOOLS = new Set(["skill"]);

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += Math.ceil(stringifyJson(message.data.content).length / 4);
  }
  return total;
}

export function shouldCompact(input: {
  provider: string;
  modelName: string;
  maxTokens: number;
  messages: Message[];
  lastStepTotalTokens?: number;
}): boolean {
  const contextWindow = estimateContextWindow(input.provider, input.modelName);
  if (contextWindow <= 0) {
    return false;
  }

  const total = input.lastStepTotalTokens ?? estimateMessageTokens(input.messages);
  return total >= Math.max(1, contextWindow - Math.min(RESERVED_TOKENS, input.maxTokens));
}

export function pruneMessages(messages: Message[]): Message[] {
  let protectedTokens = 0;
  let prunedTokens = 0;
  let observedUserTurns = 0;
  const targets = new Set<string>();

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message) {
      continue;
    }

    if (message.data.role === "user") {
      observedUserTurns += 1;
    }
    if (observedUserTurns < 2) {
      continue;
    }
    if (message.data.role !== "assistant" || message.metadata.summary === true) {
      continue;
    }

    const parts = readAssistantParts(message);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== "tool" || part.state.status !== "completed") {
        continue;
      }
      if (PRUNE_PROTECTED_TOOLS.has(part.tool) || part.state.time.compacted) {
        continue;
      }

      const estimate = estimateTextTokens(part.state.output);
      protectedTokens += estimate;
      if (protectedTokens > PRUNE_PROTECT_TOKENS) {
        prunedTokens += estimate;
        targets.add(`${message.id}:${part.callID}`);
      }
    }
  }

  if (prunedTokens < PRUNE_MINIMUM_TOKENS) {
    return messages;
  }

  return messages.map((message) => {
    if (message.data.role !== "assistant") {
      return message;
    }

    const parts = readAssistantParts(message);
    let mutated = false;
    const nextParts = parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed" || !targets.has(`${message.id}:${part.callID}`)) {
        return part;
      }

      mutated = true;
      return {
        ...part,
        state: {
          ...part.state,
          output: truncate(part.state.output),
          attachments: [],
          time: {
            ...part.state.time,
            compacted: new Date().toISOString(),
          },
        },
      };
    });

    return mutated ? cloneAssistantMessage(message, nextParts) : message;
  });
}

export async function compactMessages(input: {
  provider: string;
  apiKey: string;
  modelName: string;
  baseMessages: Message[];
  toolCatalog?: readonly ToolCatalogItem[];
}): Promise<{ compactedMessages: Message[]; summaryText: string }> {
  const systemMessages = input.baseMessages.filter((message) => message.data.role === "system");
  const nonSystem = input.baseMessages.filter((message) => message.data.role !== "system");
  if (nonSystem.length <= RETAIN_TAIL_MESSAGES) {
    return { compactedMessages: input.baseMessages, summaryText: "" };
  }

  const head = nonSystem.slice(0, Math.max(0, nonSystem.length - RETAIN_TAIL_MESSAGES));
  const tail = nonSystem.slice(-RETAIN_TAIL_MESSAGES);
  const summaryText = await summarizeConversation({
    provider: input.provider,
    apiKey: input.apiKey,
    modelName: input.modelName,
    messages: head,
    toolCatalog: input.toolCatalog,
  });

  if (summaryText.trim().length === 0) {
    return { compactedMessages: input.baseMessages, summaryText: "" };
  }

  const summaryMessage = createAssistantMessage(
    [
      {
        type: "text",
        id: "compaction-summary",
        text: summaryText,
      },
      {
        type: "compaction",
        text: summaryText,
      },
    ],
    "compaction-summary",
    {
      "__opencode.compaction": true,
      summary: true,
    },
  );

  return {
    compactedMessages: [...systemMessages, summaryMessage, ...tail],
    summaryText,
  };
}

function truncate(text: string): string {
  if (text.length <= PRUNE_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, PRUNE_OUTPUT_CHARS)}\n\n... (pruned by compaction)`;
}

async function summarizeConversation(input: {
  provider: string;
  apiKey: string;
  modelName: string;
  messages: Message[];
  toolCatalog?: readonly ToolCatalogItem[];
}): Promise<string> {
  if (input.messages.length === 0) {
    return "";
  }

  const { createLanguageModel } = await import("./llm.js");
  const model = createLanguageModel(input.provider, input.modelName, input.apiKey);

  const prompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary will be used so that another agent can continue the work.

Use this template:
## Goal
[What the user is trying to accomplish]

## Instructions
- [Important constraints or user instructions]

## Discoveries
[Relevant findings]

## Accomplished
[Completed work and remaining work]

## Relevant files / directories
[Important files or directories]
`;

  const result = await generateText({
    model,
    temperature: 0,
    messages: [
      ...(await toModelMessages(stripAttachments(input.messages), input.toolCatalog ?? [])),
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return result.text.trim();
}

function stripAttachments(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.data.role !== "assistant") {
      return message;
    }

    const parts = readAssistantParts(message);
    const nextParts = parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed" || !part.state.attachments) {
        return part;
      }
      return {
        ...part,
        state: {
          ...part.state,
          attachments: [],
        },
      };
    });

    return cloneAssistantMessage(message, nextParts);
  });
}

function estimateContextWindow(provider: string, modelName: string): number {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = modelName.toLowerCase();

  if (normalizedProvider === "anthropic" || normalizedModel.includes("claude")) {
    return 200_000;
  }
  if (normalizedProvider === "openai" || normalizedModel.includes("gpt") || normalizedModel.includes("o1") || normalizedModel.includes("o3")) {
    return 128_000;
  }
  if (normalizedProvider === "google" || normalizedModel.includes("gemini")) {
    return 1_000_000;
  }
  return 0;
}

export function lastAssistantText(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.data.role === "assistant");
  if (!lastAssistant) {
    return "";
  }
  return extractAssistantText(lastAssistant.data.content);
}

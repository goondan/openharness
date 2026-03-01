import type { Message, MessageContentPart } from '../types.js';

function readToolCallId(part: MessageContentPart): string | null {
  const value = part.toolCallId;
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

function collectToolCallIds(message: Message | undefined): Set<string> {
  const ids = new Set<string>();
  if (!message) {
    return ids;
  }

  const content = message.data.content;
  if (!Array.isArray(content)) {
    return ids;
  }

  for (const part of content) {
    if (part.type !== 'tool-call' && part.type !== 'tool_call' && part.type !== 'tool_use') {
      continue;
    }
    const toolCallId = readToolCallId(part);
    if (!toolCallId) {
      continue;
    }
    ids.add(toolCallId);
  }

  return ids;
}

function collectToolResultIds(message: Message): string[] {
  const content = message.data.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const ids: string[] = [];
  for (const part of content) {
    if (part.type !== 'tool-result' && part.type !== 'tool_result') {
      continue;
    }
    const toolCallId = readToolCallId(part);
    if (!toolCallId) {
      continue;
    }
    ids.push(toolCallId);
  }

  return ids;
}

function hasDanglingToolResult(message: Message, previousMessage: Message | undefined): boolean {
  const toolResultIds = collectToolResultIds(message);
  if (toolResultIds.length === 0) {
    return false;
  }

  const previousToolCallIds = collectToolCallIds(previousMessage);
  if (previousToolCallIds.size === 0) {
    return true;
  }

  for (const toolResultId of toolResultIds) {
    if (!previousToolCallIds.has(toolResultId)) {
      return true;
    }
  }

  return false;
}

/**
 * Removes messages that would leave invalid tool_result references after trimming.
 * Anthropic requires every tool_result block to map to a tool_use/tool-call block
 * in the immediately previous assistant message.
 */
export function normalizeRemovalTargets(
  messages: Message[],
  initialRemovedIds: ReadonlySet<string>
): Set<string> {
  const removedIds = new Set(initialRemovedIds);

  let changed = true;
  while (changed) {
    changed = false;
    let previousRemainingMessage: Message | undefined;

    for (const message of messages) {
      if (removedIds.has(message.id)) {
        continue;
      }

      if (hasDanglingToolResult(message, previousRemainingMessage)) {
        removedIds.add(message.id);
        changed = true;
        continue;
      }

      previousRemainingMessage = message;
    }
  }

  return removedIds;
}

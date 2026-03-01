import type { JsonValue, Message } from '../index.js';

export type ConversationTurnRole = 'system' | 'user' | 'assistant';

export interface ConversationTurn {
  role: ConversationTurnRole;
  content: unknown;
  metadata?: Record<string, JsonValue>;
}

function cloneMetadata(metadata: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return undefined;
  }

  const copied: Record<string, JsonValue> = {};
  for (const [key, value] of entries) {
    copied[key] = value;
  }
  return copied;
}

export function toConversationTurns(messages: Message[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const message of messages) {
    if (
      message.data.role !== 'system'
      && message.data.role !== 'user'
      && message.data.role !== 'assistant'
    ) {
      continue;
    }

    const turn: ConversationTurn = {
      role: message.data.role,
      content: message.data.content,
    };
    const metadata = cloneMetadata(message.metadata);
    if (metadata) {
      turn.metadata = metadata;
    }
    turns.push(turn);
  }

  return turns;
}

export function toPersistentMessages(turns: ConversationTurn[]): Message[] {
  const messages: Message[] = [];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }

    if (turn.role === 'assistant') {
      messages.push({
        id: `persist-${index}`,
        data: {
          role: 'assistant',
          content: turn.content,
        },
        metadata: cloneMetadata(turn.metadata) ?? {},
        createdAt: new Date(),
        source: {
          type: 'assistant',
          stepId: `persist-step-${index}`,
        },
      });
      continue;
    }

    if (turn.role === 'system') {
      messages.push({
        id: `persist-${index}`,
        data: {
          role: 'system',
          content: turn.content,
        },
        metadata: cloneMetadata(turn.metadata) ?? {},
        createdAt: new Date(),
        source: {
          type: 'system',
        },
      });
      continue;
    }

    messages.push({
      id: `persist-${index}`,
      data: {
        role: 'user',
        content: turn.content,
      },
      metadata: cloneMetadata(turn.metadata) ?? {},
      createdAt: new Date(),
      source: {
        type: 'user',
      },
    });
  }

  return messages;
}

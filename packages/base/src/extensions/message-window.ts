import type { ExtensionApi, Message, MessageEvent } from '../types.js';
import { normalizeRemovalTargets } from './message-integrity.js';

export interface MessageWindowExtensionConfig {
  maxMessages?: number;
}

const DEFAULT_CONFIG: Required<MessageWindowExtensionConfig> = {
  maxMessages: 40,
};

function isPinned(message: Message): boolean {
  return message.metadata.pinned === true;
}

function resolveMaxMessages(config?: MessageWindowExtensionConfig): number {
  const value = config?.maxMessages;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_CONFIG.maxMessages;
  }

  return Math.floor(value);
}

export function registerMessageWindowExtension(
  api: ExtensionApi,
  config?: MessageWindowExtensionConfig,
): void {
  const maxMessages = resolveMaxMessages(config);

  api.pipeline.register('turn', async (ctx) => {
    const messages = ctx.conversationState.nextMessages;
    const removedIds = new Set<string>();
    if (messages.length > maxMessages) {
      const removeCount = messages.length - maxMessages;
      let removed = 0;
      for (const message of messages) {
        if (removed >= removeCount) {
          break;
        }
        if (!message) {
          continue;
        }
        if (isPinned(message)) {
          continue;
        }
        removedIds.add(message.id);
        removed += 1;
      }
    }

    const normalizedRemovedIds = normalizeRemovalTargets(messages, removedIds);
    if (normalizedRemovedIds.size === 0) {
      return ctx.next();
    }

    const events: MessageEvent[] = [];
    for (const message of messages) {
      if (!normalizedRemovedIds.has(message.id)) {
        continue;
      }

      events.push({
        type: 'remove',
        targetId: message.id,
      });
    }

    for (const event of events) {
      ctx.emitMessageEvent(event);
    }

    return ctx.next();
  });
}

export function register(api: ExtensionApi, config?: MessageWindowExtensionConfig): void {
  registerMessageWindowExtension(api, config);
}

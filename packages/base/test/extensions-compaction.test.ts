import { describe, expect, it } from 'vitest';
import { registerCompactionExtension } from '../src/extensions/compaction.js';
import type { Message, MessageEvent, TurnMiddlewareContext } from '../src/types.js';
import {
  createConversationState,
  createMessage,
  createMockExtensionApi,
} from './helpers.js';

function createTurnContext(events: MessageEvent[]): TurnMiddlewareContext {
  const messages = [
    createMessage('m1', '1111111111'),
    createMessage('m2', '2222222222'),
    createMessage('m3', '3333333333'),
    createMessage('m4', '4444444444'),
    createMessage('m5', '5555555555'),
  ];

  return {
    agentName: 'agent-a',
    instanceKey: 'instance-1',
    turnId: 'turn-1',
    traceId: 'trace-1',
    inputEvent: {
      id: 'evt-1',
      type: 'connector.message',
      createdAt: new Date(),
      source: { kind: 'connector', name: 'cli' },
      input: 'hello',
    },
    conversationState: createConversationState(messages),
    emitMessageEvent(event) {
      events.push(event);
    },
    metadata: {},
    async next() {
      return {
        turnId: 'turn-1',
        finishReason: 'text_response',
      };
    },
  };
}

function createAssistantToolCallMessage(id: string, toolCallId: string): Message {
  return {
    id,
    data: {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId,
          toolName: 'tool-a',
          input: {},
        },
      ],
    },
    metadata: {},
    createdAt: new Date(),
    source: {
      type: 'assistant',
      stepId: `step-${id}`,
    },
  };
}

function createUserToolResultMessage(id: string, toolCallId: string): Message {
  return {
    id,
    data: {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'tool-a',
          output: {
            type: 'text',
            value: 'ok',
          },
        },
      ],
    },
    metadata: {},
    createdAt: new Date(),
    source: { type: 'user' },
  };
}

describe('compaction extension', () => {
  it('emits remove + append summary events when message limit exceeded', async () => {
    const mock = createMockExtensionApi();
    registerCompactionExtension(mock.api, {
      maxMessages: 3,
      retainLastMessages: 1,
      appendSummary: true,
      mode: 'remove',
      maxCharacters: 1000,
    });

    expect(mock.pipeline.turnMiddlewares.length).toBe(1);

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext(emitted);

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing compaction middleware');
    }
    await middleware(ctx);

    const removeCount = emitted.filter((event) => event.type === 'remove').length;
    const summaryCount = emitted.filter((event) => event.type === 'append').length;

    expect(removeCount).toBeGreaterThan(0);
    expect(summaryCount).toBe(1);
  });

  it('can emit truncate in truncate mode', async () => {
    const mock = createMockExtensionApi();
    registerCompactionExtension(mock.api, {
      maxMessages: 1,
      mode: 'truncate',
      appendSummary: false,
      maxCharacters: 20,
    });

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext(emitted);

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing compaction middleware');
    }
    await middleware(ctx);

    expect(emitted.some((event) => event.type === 'truncate')).toBe(true);
  });

  it('remove 모드에서 제거 경계로 생긴 고아 tool-result 메시지를 함께 정리한다', async () => {
    const mock = createMockExtensionApi();
    registerCompactionExtension(mock.api, {
      maxMessages: 4,
      retainLastMessages: 2,
      appendSummary: false,
      mode: 'remove',
      maxCharacters: 10_000,
    });

    const messages = [
      createMessage('m1', 'pinned', true),
      createAssistantToolCallMessage('m2', 'tool-1'),
      createUserToolResultMessage('m3', 'tool-1'),
      createMessage('m4', 'middle'),
      createMessage('m5', 'tail'),
    ];
    const emitted: MessageEvent[] = [];
    const ctx: TurnMiddlewareContext = {
      agentName: 'agent-a',
      instanceKey: 'instance-1',
      turnId: 'turn-1',
      traceId: 'trace-1',
      inputEvent: {
        id: 'evt-1',
        type: 'connector.message',
        createdAt: new Date(),
        source: { kind: 'connector', name: 'cli' },
        input: 'hello',
      },
      conversationState: createConversationState(messages),
      emitMessageEvent(event) {
        emitted.push(event);
      },
      metadata: {},
      async next() {
        return {
          turnId: 'turn-1',
          finishReason: 'text_response',
        };
      },
    };

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing compaction middleware');
    }

    await middleware(ctx);

    const removedIds = emitted
      .filter((event): event is Extract<MessageEvent, { type: 'remove' }> => event.type === 'remove')
      .map((event) => event.targetId);

    expect(removedIds).toEqual(['m2', 'm3']);
  });
});

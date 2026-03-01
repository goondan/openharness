import { describe, expect, it } from 'vitest';
import { registerMessageWindowExtension } from '../src/extensions/message-window.js';
import type { Message, MessageEvent, TurnMiddlewareContext } from '../src/types.js';
import { createConversationState, createMessage, createMockExtensionApi } from './helpers.js';

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

describe('message-window extension', () => {
  it('maxMessages를 초과하면 오래된 메시지부터 제거 이벤트를 발행한다', async () => {
    const mock = createMockExtensionApi();
    registerMessageWindowExtension(mock.api, {
      maxMessages: 3,
    });

    expect(mock.pipeline.turnMiddlewares.length).toBe(1);

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext(emitted);

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing message-window middleware');
    }

    await middleware(ctx);

    const removedIds = emitted
      .filter((event): event is Extract<MessageEvent, { type: 'remove' }> => event.type === 'remove')
      .map((event) => event.targetId);

    expect(removedIds).toEqual(['m1', 'm2']);
  });

  it('메시지 수가 임계값 이하이면 제거하지 않는다', async () => {
    const mock = createMockExtensionApi();
    registerMessageWindowExtension(mock.api, {
      maxMessages: 10,
    });

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext(emitted);

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing message-window middleware');
    }

    await middleware(ctx);

    expect(emitted.length).toBe(0);
  });

  it('pinned 메시지는 윈도우 제거 대상에서 제외한다', async () => {
    const mock = createMockExtensionApi();
    registerMessageWindowExtension(mock.api, {
      maxMessages: 3,
    });

    const messages: Message[] = [
      {
        id: 'sys-pinned',
        data: {
          role: 'system',
          content: 'pinned system',
        },
        metadata: {
          pinned: true,
        },
        createdAt: new Date(),
        source: {
          type: 'system',
        },
      },
      createMessage('m2', '2222222222'),
      createMessage('m3', '3333333333'),
      createMessage('m4', '4444444444'),
      createMessage('m5', '5555555555'),
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
      throw new Error('Missing message-window middleware');
    }

    await middleware(ctx);

    const removedIds = emitted
      .filter((event): event is Extract<MessageEvent, { type: 'remove' }> => event.type === 'remove')
      .map((event) => event.targetId);

    expect(removedIds).toEqual(['m2', 'm3']);
  });

  it('윈도우 경계에서 고아 tool-result 메시지를 함께 제거한다', async () => {
    const mock = createMockExtensionApi();
    registerMessageWindowExtension(mock.api, {
      maxMessages: 3,
    });

    const messages = [
      createMessage('m1', 'seed'),
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
      throw new Error('Missing message-window middleware');
    }

    await middleware(ctx);

    const removedIds = emitted
      .filter((event): event is Extract<MessageEvent, { type: 'remove' }> => event.type === 'remove')
      .map((event) => event.targetId);

    expect(removedIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('메시지 수가 임계값 이하라도 고아 tool-result 메시지를 정리한다', async () => {
    const mock = createMockExtensionApi();
    registerMessageWindowExtension(mock.api, {
      maxMessages: 10,
    });

    const messages = [
      createAssistantToolCallMessage('m1', 'tool-1'),
      createUserToolResultMessage('m2', 'tool-1'),
      createUserToolResultMessage('m3', 'tool-2'),
      createMessage('m4', 'tail'),
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
      throw new Error('Missing message-window middleware');
    }

    await middleware(ctx);

    const removedIds = emitted
      .filter((event): event is Extract<MessageEvent, { type: 'remove' }> => event.type === 'remove')
      .map((event) => event.targetId);

    expect(removedIds).toEqual(['m3']);
  });
});

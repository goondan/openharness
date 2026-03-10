import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { register as registerContextMessageExtension } from '../src/extensions/context-message.js';
import type {
  AgentEvent,
  JsonObject,
  JsonValue,
  Message,
  MessageEvent,
  RuntimeContext,
  TurnMiddlewareContext,
  TurnResult,
} from '../src/types.js';
import { isJsonObject } from '../src/utils.js';
import { createConversationState, createMessage, createMockExtensionApi } from './helpers.js';

const EXTENSION_EVENTS_METADATA_KEY = 'extension.events';
const CONTEXT_MESSAGE_MARKER_KEY = '__goondanContextMessage';
const INBOUND_MESSAGE_METADATA_KEY = '__goondanInbound';

function createInputEvent(turnId: string): AgentEvent {
  return {
    id: `evt-${turnId}`,
    type: 'connector.message',
    createdAt: new Date(),
    source: { kind: 'connector', name: 'cli' },
    input: 'hello',
  };
}

function createTurnContext(input: {
  turnId?: string;
  messages?: Message[];
  metadata?: Record<string, JsonValue>;
  runtime?: RuntimeContext;
  inputEvent?: AgentEvent;
  emitted: MessageEvent[];
  next?: () => Promise<TurnResult>;
  emitMessageEvent?: (event: MessageEvent) => void;
}): TurnMiddlewareContext {
  const turnId = input.turnId ?? 'turn-1';
  const messages = input.messages ?? [createMessage('m1', 'hello')];

  return {
    agentName: 'agent-a',
    conversationId: 'instance-1',
    turnId,
    traceId: `trace-${turnId}`,
    abortSignal: new AbortController().signal,
    inputEvent: input.inputEvent ?? createInputEvent(turnId),
    conversationState: createConversationState(messages),
    runtime: input.runtime ?? {
      agent: {
        name: 'agent-a',
        bundleRoot: '/tmp',
      },
      inbound: {
        eventId: `evt-${turnId}`,
        eventType: 'connector.message',
        kind: 'connector',
        sourceName: 'cli',
        createdAt: new Date().toISOString(),
        properties: {},
        content: [],
      },
    },
    emitMessageEvent(event) {
      if (input.emitMessageEvent) {
        input.emitMessageEvent(event);
        return;
      }
      input.emitted.push(event);
    },
    metadata: input.metadata ?? {},
    async next() {
      if (input.next) {
        return input.next();
      }
      return {
        turnId,
        finishReason: 'text_response',
      };
    },
  };
}

function readRuntimeEvents(metadata: Record<string, JsonValue>): JsonObject[] {
  const raw = metadata[EXTENSION_EVENTS_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is JsonObject => isJsonObject(item));
}

function readRuntimeEventNames(metadata: Record<string, JsonValue>): string[] {
  return readRuntimeEvents(metadata)
    .map((item) => item.name)
    .filter((name): name is string => typeof name === 'string');
}

function findRuntimeEvent(
  metadata: Record<string, JsonValue>,
  eventName: string,
): JsonObject | undefined {
  return readRuntimeEvents(metadata).find((item) => item.name === eventName);
}

describe('context-message extension', () => {
  it('기본 설정에서는 agent.prompt.system만 system 메시지로 append한다', async () => {
    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeInboundInput: false,
    });

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext({
      emitted,
      runtime: {
        agent: {
          name: 'coordinator',
          bundleRoot: '/tmp',
          prompt: { system: 'You must follow policy A.' },
        },
        inbound: {
          eventId: 'evt-test',
          eventType: 'connector.message',
          kind: 'connector',
          sourceName: 'cli',
          createdAt: new Date().toISOString(),
          properties: {},
          content: [],
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    expect(emitted.length).toBe(1);
    const firstEvent = emitted[0];
    if (!firstEvent || firstEvent.type !== 'append') {
      throw new Error('Expected append event');
    }

    expect(firstEvent.message.data.role).toBe('system');
    expect(firstEvent.message.data.content).toBe('You must follow policy A.');
    expect(firstEvent.message.source).toEqual({
      type: 'extension',
      extensionName: 'context-message',
    });

    const marker = firstEvent.message.metadata[CONTEXT_MESSAGE_MARKER_KEY];
    expect(isJsonObject(marker)).toBe(true);
    if (isJsonObject(marker)) {
      expect(typeof marker.promptHash).toBe('string');
      expect(marker.segmentIds).toEqual(['agent.prompt.system']);
    }

    const eventNames = readRuntimeEventNames(ctx.metadata);
    expect(eventNames).toContain('context.segment.resolved');
    expect(eventNames).toContain('context.message.appended');
  });

  it('inbound input은 context 세그먼트 뒤(user tail)에 append한다', async () => {
    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeAgentPrompt: true,
      includeInboundContext: true,
    });

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext({
      emitted,
      messages: [createMessage('history-1', 'older message')],
      turnId: 'turn-inbound-tail',
      runtime: {
        agent: {
          name: 'coordinator',
          bundleRoot: '/tmp',
          prompt: { system: 'System prompt.' },
        },
        inbound: {
          eventId: 'evt-test',
          eventType: 'app_mention',
          kind: 'connector',
          sourceName: 'slack',
          createdAt: new Date().toISOString(),
          properties: {
            channel_id: 'C123',
          },
          content: [],
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    expect(emitted.length).toBe(3);

    const firstEvent = emitted[0];
    if (!firstEvent || firstEvent.type !== 'append') {
      throw new Error('Expected system append event');
    }
    expect(firstEvent.message.data.role).toBe('system');
    expect(firstEvent.message.data.content).toBe('System prompt.');

    const secondEvent = emitted[1];
    if (!secondEvent || secondEvent.type !== 'append') {
      throw new Error('Expected runtime append event');
    }
    expect(secondEvent.message.data.role).toBe('user');
    expect(secondEvent.message.data.content).toContain('[runtime_inbound]');

    const thirdEvent = emitted[2];
    if (!thirdEvent || thirdEvent.type !== 'append') {
      throw new Error('Expected inbound append event');
    }
    expect(thirdEvent.message.data.role).toBe('user');
    expect(thirdEvent.message.data.content).toBe('hello');
    expect(isJsonObject(thirdEvent.message.metadata[INBOUND_MESSAGE_METADATA_KEY])).toBe(true);
    if (isJsonObject(thirdEvent.message.metadata[INBOUND_MESSAGE_METADATA_KEY])) {
      expect(thirdEvent.message.metadata[INBOUND_MESSAGE_METADATA_KEY]).toMatchObject({
        sourceKind: 'connector',
        sourceName: 'slack',
        eventName: 'app_mention',
      });
    }

    const inboundAppendedEvent = findRuntimeEvent(ctx.metadata, 'context.inbound.appended');
    expect(inboundAppendedEvent).toBeDefined();
  });

  it('멀티모달 inbound content를 user 메시지로 투영하고 raw payload는 metadata에 남긴다', async () => {
    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeAgentPrompt: false,
      includeInboundContext: true,
      includeRouteSummary: false,
      includeInboundInput: true,
    });

    const content = [
      { type: 'text', text: 'hello from slack' },
      { type: 'image', url: 'https://example.com/diagram.png', alt: 'architecture' },
      { type: 'file', url: 'https://example.com/spec.pdf', name: 'spec.pdf', mimeType: 'application/pdf' },
    ] satisfies AgentEvent['content'];

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext({
      emitted,
      turnId: 'turn-multimodal',
      inputEvent: {
        ...createInputEvent('turn-multimodal'),
        input: 'legacy alias should not win',
        content,
        rawPayload: {
          deliveryId: 'evt-raw-1',
        },
      },
      runtime: {
        agent: {
          name: 'coordinator',
          bundleRoot: '/tmp',
        },
        inbound: {
          eventId: 'evt-multimodal',
          eventType: 'slack.message',
          kind: 'connector',
          sourceName: 'slack',
          connectionName: 'slack-main',
          conversationId: 'thread:1',
          createdAt: new Date().toISOString(),
          properties: {
            channelId: 'C123',
          },
          content,
          rawPayload: {
            deliveryId: 'evt-raw-1',
          },
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    expect(emitted).toHaveLength(2);
    const appendEvent = emitted[1];
    if (!appendEvent || appendEvent.type !== 'append') {
      throw new Error('Expected inbound append event');
    }

    expect(appendEvent.message.data.role).toBe('user');
    expect(appendEvent.message.data.content).toBe(
      [
        'hello from slack',
        '[image] architecture https://example.com/diagram.png',
        '[file] spec.pdf (application/pdf): https://example.com/spec.pdf',
      ].join('\n\n'),
    );

    expect(isJsonObject(appendEvent.message.metadata[INBOUND_MESSAGE_METADATA_KEY])).toBe(true);
    if (isJsonObject(appendEvent.message.metadata[INBOUND_MESSAGE_METADATA_KEY])) {
      expect(appendEvent.message.metadata[INBOUND_MESSAGE_METADATA_KEY]).toMatchObject({
        sourceKind: 'connector',
        sourceName: 'slack',
        connectionName: 'slack-main',
        conversationId: 'thread:1',
        eventName: 'slack.message',
        properties: {
          channelId: 'C123',
        },
        rawPayload: {
          deliveryId: 'evt-raw-1',
        },
      });
    }
  });

  it('기존 system 메시지가 여러 개면 하나로 정리하고 필요 시 교체한다', async () => {
    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeInboundInput: false,
    });

    const staleContent = 'stale system';
    const desiredContent = 'fresh system';
    const staleHash = createHash('sha256').update(`system\n${staleContent}`).digest('hex');
    const extraHash = createHash('sha256').update('system\nextra stale').digest('hex');

    const existingMessages: Message[] = [
      {
        id: 'system-anchor',
        data: {
          role: 'system',
          content: staleContent,
        },
        metadata: {
          [CONTEXT_MESSAGE_MARKER_KEY]: {
            promptHash: staleHash,
            role: 'system',
            segmentIds: ['agent.prompt.system'],
          },
        },
        createdAt: new Date(),
        source: {
          type: 'system',
        },
      },
      createMessage('history-user', 'hello'),
      {
        id: 'system-extra',
        data: {
          role: 'system',
          content: 'extra stale',
        },
        metadata: {
          [CONTEXT_MESSAGE_MARKER_KEY]: {
            promptHash: extraHash,
            role: 'system',
            segmentIds: ['agent.prompt.system'],
          },
        },
        createdAt: new Date(),
        source: {
          type: 'system',
        },
      },
    ];

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext({
      emitted,
      messages: existingMessages,
      runtime: {
        agent: {
          name: 'coordinator',
          bundleRoot: '/tmp',
          prompt: { system: desiredContent },
        },
        inbound: {
          eventId: 'evt-test',
          eventType: 'connector.message',
          kind: 'connector',
          sourceName: 'cli',
          createdAt: new Date().toISOString(),
          properties: {},
          content: [],
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    const replaceEvents = emitted.filter((event): event is Extract<MessageEvent, { type: 'replace' }> => event.type === 'replace');
    const removeEvents = emitted.filter((event): event is Extract<MessageEvent, { type: 'remove' }> => event.type === 'remove');

    expect(replaceEvents.length).toBe(1);
    expect(replaceEvents[0]?.targetId).toBe('system-anchor');
    expect(replaceEvents[0]?.message.data.role).toBe('system');
    expect(replaceEvents[0]?.message.data.content).toBe(desiredContent);
    expect(replaceEvents[0]?.message.metadata.pinned).toBe(true);

    expect(removeEvents.length).toBe(1);
    expect(removeEvents[0]?.targetId).toBe('system-extra');

    const replacedEvent = findRuntimeEvent(ctx.metadata, 'context.message.replaced');
    expect(replacedEvent).toBeDefined();
    const removedEvent = findRuntimeEvent(ctx.metadata, 'context.message.removed');
    expect(removedEvent).toBeDefined();
  });

  it('includeRouteSummary=true면 inbound 기준으로 runtime_route를 합성한다', async () => {
    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeAgentPrompt: false,
      includeInboundContext: true,
      includeRouteSummary: true,
      includeInboundInput: false,
    });

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext({
      emitted,
      runtime: {
        agent: {
          name: 'worker',
          bundleRoot: '/tmp',
        },
        inbound: {
          eventId: 'evt-inbound',
          eventType: 'telegram.message',
          kind: 'connector',
          sourceName: 'telegram',
          createdAt: new Date().toISOString(),
          conversationId: 'chat-1',
          properties: {},
          content: [],
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    expect(emitted.length).toBe(1);
    const firstEvent = emitted[0];
    if (!firstEvent || firstEvent.type !== 'append') {
      throw new Error('Expected append event');
    }

    expect(firstEvent.message.data.role).toBe('user');
    expect(firstEvent.message.data.content).toContain('[runtime_route]');
    expect(firstEvent.message.data.content).toContain('precedence=inbound');
    expect(firstEvent.message.data.content).toContain('senderKind=connector');
    expect(firstEvent.message.data.content).toContain('senderName=telegram');
    expect(firstEvent.message.data.content).toContain('senderConversationId=chat-1');
    expect(firstEvent.message.data.content).toContain('eventType=telegram.message');

    const marker = firstEvent.message.metadata[CONTEXT_MESSAGE_MARKER_KEY];
    expect(isJsonObject(marker)).toBe(true);
    if (isJsonObject(marker)) {
      expect(marker.segmentIds).toEqual(['runtime.inbound', 'runtime.route.summary']);
    }
  });

  it('이미 동일 해시 메시지가 있으면 중복 append하지 않는다', async () => {
    const content = 'Deduplicate this prompt.';
    const promptHash = createHash('sha256').update(content).digest('hex');

    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeInboundInput: false,
    });

    const emitted: MessageEvent[] = [];
    const existingMessages: Message[] = [
      {
        id: 'existing-system',
        data: {
          role: 'system',
          content,
        },
        metadata: {
          [CONTEXT_MESSAGE_MARKER_KEY]: {
            promptHash,
            segmentIds: ['agent.prompt.system'],
          },
        },
        createdAt: new Date(),
        source: {
          type: 'extension',
          extensionName: 'context-message',
        },
      },
      createMessage('m1', 'hello'),
    ];

    const ctx = createTurnContext({
      emitted,
      messages: existingMessages,
      runtime: {
        agent: {
          name: 'coordinator',
          bundleRoot: '/tmp',
          prompt: { system: content },
        },
        inbound: {
          eventId: 'evt-test',
          eventType: 'connector.message',
          kind: 'connector',
          sourceName: 'cli',
          createdAt: new Date().toISOString(),
          properties: {},
          content: [],
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    expect(emitted.length).toBe(0);
    const eventNames = readRuntimeEventNames(ctx.metadata);
    expect(eventNames).toContain('context.message.duplicate');
  });

  it('활성 세그먼트가 없으면 no-op으로 종료하고 empty 이벤트를 남긴다', async () => {
    const mock = createMockExtensionApi();
    registerContextMessageExtension(mock.api, {
      includeAgentPrompt: false,
      includeInboundContext: false,
      includeInboundInput: false,
    });

    const emitted: MessageEvent[] = [];
    const ctx = createTurnContext({
      emitted,
      runtime: {
        agent: {
          name: 'coordinator',
          bundleRoot: '/tmp',
        },
        inbound: {
          eventId: 'evt-test',
          eventType: 'connector.message',
          kind: 'connector',
          sourceName: 'cli',
          createdAt: new Date().toISOString(),
          properties: {},
          content: [],
        },
      },
    });

    const middleware = mock.pipeline.turnMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing context-message middleware');
    }

    await middleware(ctx);

    expect(emitted.length).toBe(0);
    const emptyEvent = findRuntimeEvent(ctx.metadata, 'context.message.empty');
    expect(emptyEvent).toBeDefined();
  });
});

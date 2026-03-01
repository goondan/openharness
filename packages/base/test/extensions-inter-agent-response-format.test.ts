import { describe, expect, it } from 'vitest';
import { registerInterAgentResponseFormatExtension } from '../src/extensions/inter-agent-response-format.js';
import type { Message, MessageEvent, StepMiddlewareContext } from '../src/types.js';
import { createConversationState, createMessage, createMockExtensionApi } from './helpers.js';

const INTER_AGENT_RESPONSE_METADATA_KEY = '__goondanInterAgentResponse';
const INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY = '__goondanInterAgentResponseFormatted';

function createStepContext(messages: Message[], emitted: MessageEvent[]): StepMiddlewareContext {
  return {
    agentName: 'coordinator',
    instanceKey: 'instance-1',
    turnId: 'turn-1',
    traceId: 'trace-1',
    turn: { id: 'turn-1', startedAt: new Date() },
    stepIndex: 1,
    conversationState: createConversationState(messages),
    emitMessageEvent(event) {
      emitted.push(event);
    },
    toolCatalog: [],
    metadata: {},
    async next() {
      return {
        status: 'completed',
        shouldContinue: false,
        toolCalls: [],
        toolResults: [],
        metadata: {},
      };
    },
  };
}

function createAsyncResponseMessage(input: {
  id: string;
  status: 'ok' | 'error' | 'timeout';
  fromAgentId: string;
  requestId: string;
  response?: unknown;
  errorCode?: string;
  errorMessage?: string;
  formatted?: boolean;
}): Message {
  const metadata: Record<string, unknown> = {
    kind: 'inter_agent_response',
    version: 1,
    requestId: input.requestId,
    requestEventId: `req-${input.requestId}`,
    fromAgentId: input.fromAgentId,
    toAgentId: 'coordinator',
    async: true,
    status: input.status,
    receivedAt: '2026-02-21T10:00:00.000Z',
    requestEventType: 'agent.request',
  };
  if (input.errorCode) {
    metadata.errorCode = input.errorCode;
  }
  if (input.errorMessage) {
    metadata.errorMessage = input.errorMessage;
  }

  const content: Record<string, unknown> = {
    type: 'inter_agent_response',
    requestId: input.requestId,
    fromAgentId: input.fromAgentId,
    toAgentId: 'coordinator',
    status: input.status,
  };
  if (input.response !== undefined) {
    content.response = input.response;
  }
  if (input.errorCode || input.errorMessage) {
    content.error = {
      code: input.errorCode,
      message: input.errorMessage,
    };
  }

  return {
    id: input.id,
    data: {
      role: 'user',
      content,
    },
    metadata: {
      [INTER_AGENT_RESPONSE_METADATA_KEY]: metadata,
      ...(input.formatted ? { [INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY]: true } : {}),
    },
    createdAt: new Date('2026-02-21T10:00:00.000Z'),
    source: { type: 'user' },
  };
}

describe('inter-agent-response-format extension', () => {
  it('주입된 async request 응답 메시지를 텍스트 포맷으로 교체한다', async () => {
    const mock = createMockExtensionApi();
    registerInterAgentResponseFormatExtension(mock.api);

    expect(mock.pipeline.stepMiddlewares.length).toBe(1);
    const middleware = mock.pipeline.stepMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing inter-agent-response-format middleware');
    }

    const messages: Message[] = [
      createMessage('m0', 'normal message'),
      createAsyncResponseMessage({
        id: 'm1',
        status: 'ok',
        fromAgentId: 'researcher',
        requestId: 'corr-1',
        response: { title: 'memo', score: 9 },
      }),
      createAsyncResponseMessage({
        id: 'm2',
        status: 'error',
        fromAgentId: 'reviewer',
        requestId: 'corr-2',
        errorCode: 'AGENT_REQUEST_TIMEOUT',
        errorMessage: 'timed out',
      }),
      createAsyncResponseMessage({
        id: 'm3',
        status: 'ok',
        fromAgentId: 'planner',
        requestId: 'corr-3',
        response: 'already formatted',
        formatted: true,
      }),
    ];

    const emitted: MessageEvent[] = [];
    await middleware(createStepContext(messages, emitted));

    const replaceEvents = emitted.filter(
      (event): event is Extract<MessageEvent, { type: 'replace' }> => event.type === 'replace',
    );

    expect(replaceEvents.length).toBe(2);
    expect(replaceEvents.map((event) => event.targetId)).toEqual(['m1', 'm2']);

    const first = replaceEvents[0];
    const second = replaceEvents[1];
    if (!first || !second) {
      throw new Error('Missing replace events');
    }

    expect(first.message.source).toEqual({
      type: 'extension',
      extensionName: 'inter-agent-response-format',
    });
    expect(first.message.metadata[INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY]).toBe(true);
    expect(typeof first.message.data.content).toBe('string');
    expect(String(first.message.data.content)).toContain('[inter-agent response]');
    expect(String(first.message.data.content)).toContain('researcher -> coordinator');
    expect(String(first.message.data.content)).toContain('"title": "memo"');

    expect(second.message.metadata[INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY]).toBe(true);
    expect(String(second.message.data.content)).toContain('status=error');
    expect(String(second.message.data.content)).toContain('error(AGENT_REQUEST_TIMEOUT): timed out');
  });

  it('일반 메시지에는 아무 이벤트도 발행하지 않는다', async () => {
    const mock = createMockExtensionApi();
    registerInterAgentResponseFormatExtension(mock.api);

    const middleware = mock.pipeline.stepMiddlewares[0];
    if (!middleware) {
      throw new Error('Missing inter-agent-response-format middleware');
    }

    const emitted: MessageEvent[] = [];
    await middleware(
      createStepContext(
        [
          createMessage('m1', 'hello'),
          createMessage('m2', 'world'),
        ],
        emitted,
      ),
    );

    expect(emitted.length).toBe(0);
  });
});

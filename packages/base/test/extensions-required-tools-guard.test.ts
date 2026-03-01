import { describe, expect, it } from 'vitest';
import { register as registerRequiredToolsGuardExtension } from '../src/extensions/required-tools-guard.js';
import type {
  AgentEvent,
  MessageEvent,
  MiddlewareAgentsApi,
  StepMiddlewareContext,
  StepResult,
  ToolCallMiddlewareContext,
  ToolCallResult,
  TurnMiddlewareContext,
  TurnResult,
  RuntimeContext,
} from '../src/types.js';
import type { RequiredToolsGuardConfig } from '../src/extensions/required-tools-guard.js';
import { createConversationState, createMessage, createMockExtensionApi } from './helpers.js';

const noopAgents: MiddlewareAgentsApi = {
  async request() {
    return {
      target: 'noop',
      response: '',
      accepted: true,
      async: false,
    };
  },
  async send() {
    return {
      accepted: true,
    };
  },
};

function createInputEvent(turnId: string): AgentEvent {
  return {
    id: `evt-${turnId}`,
    type: 'connector.message',
    createdAt: new Date(),
    source: { kind: 'connector', name: 'cli' },
    input: 'hello',
  };
}

function createRuntimeContext(turnId: string): RuntimeContext {
  return {
    agent: {
      name: 'coordinator',
      bundleRoot: '/tmp',
    },
    swarm: {
      swarmName: 'brain',
      entryAgent: 'coordinator',
      selfAgent: 'coordinator',
      availableAgents: ['coordinator'],
      callableAgents: [],
    },
    inbound: {
      eventId: `evt-${turnId}`,
      eventType: 'connector.message',
      kind: 'connector',
      sourceName: 'cli',
      createdAt: new Date().toISOString(),
      properties: {},
    },
  };
}

function createTurnContext(input: {
  turnId: string;
  emitted: MessageEvent[];
  next: () => Promise<TurnResult>;
}): TurnMiddlewareContext {
  return {
    agentName: 'coordinator',
    instanceKey: 'brain',
    turnId: input.turnId,
    traceId: `trace-${input.turnId}`,
    inputEvent: createInputEvent(input.turnId),
    conversationState: createConversationState([createMessage('m1', 'hello')]),
    agents: noopAgents,
    runtime: createRuntimeContext(input.turnId),
    emitMessageEvent(event) {
      input.emitted.push(event);
    },
    metadata: {},
    next: input.next,
  };
}

function createStepContext(input: {
  turnId: string;
  emitted: MessageEvent[];
  result: StepResult;
}): StepMiddlewareContext {
  return {
    agentName: 'coordinator',
    instanceKey: 'brain',
    turnId: input.turnId,
    traceId: `trace-${input.turnId}`,
    turn: { id: input.turnId, startedAt: new Date() },
    stepIndex: 1,
    conversationState: createConversationState([createMessage('m1', 'hello')]),
    agents: noopAgents,
    runtime: createRuntimeContext(input.turnId),
    emitMessageEvent(event) {
      input.emitted.push(event);
    },
    toolCatalog: [{ name: 'slack__send' }],
    metadata: {},
    async next() {
      return input.result;
    },
  };
}

function createToolCallContext(input: {
  turnId: string;
  toolName: string;
  result: ToolCallResult;
}): ToolCallMiddlewareContext {
  return {
    agentName: 'coordinator',
    instanceKey: 'brain',
    turnId: input.turnId,
    traceId: `trace-${input.turnId}`,
    stepIndex: 1,
    toolName: input.toolName,
    toolCallId: `tc-${input.turnId}-${input.toolName}`,
    runtime: createRuntimeContext(input.turnId),
    args: { text: 'ok' },
    metadata: {},
    async next() {
      return input.result;
    },
  };
}

describe('required-tools-guard extension', () => {
  it('turn 경계에서 이전 turn의 성공 호출 상태가 다음 turn으로 누수되지 않는다', async () => {
    const mock = createMockExtensionApi();
    const config: RequiredToolsGuardConfig = {
      requiredTools: ['slack__send'],
      errorMessage: 'slack__send를 반드시 호출해야 합니다.',
    };
    registerRequiredToolsGuardExtension(mock.api, config);

    const turnMiddleware = mock.pipeline.turnMiddlewares[0];
    const stepMiddleware = mock.pipeline.stepMiddlewares[0];
    const toolCallMiddleware = mock.pipeline.toolCallMiddlewares[0];
    if (!turnMiddleware || !stepMiddleware || !toolCallMiddleware) {
      throw new Error('required-tools-guard middlewares are missing');
    }

    let firstStepResult: StepResult | undefined;
    await turnMiddleware(
      createTurnContext({
        turnId: 'turn-reused',
        emitted: [],
        next: async () => {
          await toolCallMiddleware(
            createToolCallContext({
              turnId: 'turn-reused',
              toolName: 'slack__send',
              result: {
                toolCallId: 'tc-1',
                toolName: 'slack__send',
                status: 'ok',
                output: { ok: true },
              },
            }),
          );

          firstStepResult = await stepMiddleware(
            createStepContext({
              turnId: 'turn-reused',
              emitted: [],
              result: {
                status: 'completed',
                shouldContinue: true,
                toolCalls: [{ id: 'tc-1', name: 'slack__send', args: { text: 'ok' } }],
                toolResults: [],
                metadata: {},
              },
            }),
          );

          return {
            turnId: 'turn-reused',
            finishReason: 'max_steps',
          };
        },
      }),
    );
    expect(firstStepResult?.shouldContinue).toBe(true);

    const emitted: MessageEvent[] = [];
    let secondStepResult: StepResult | undefined;
    await turnMiddleware(
      createTurnContext({
        turnId: 'turn-reused',
        emitted,
        next: async () => {
          secondStepResult = await stepMiddleware(
            createStepContext({
              turnId: 'turn-reused',
              emitted,
              result: {
                status: 'completed',
                shouldContinue: false,
                toolCalls: [],
                toolResults: [],
                metadata: {},
              },
            }),
          );

          return {
            turnId: 'turn-reused',
            finishReason: 'text_response',
          };
        },
      }),
    );

    expect(secondStepResult?.shouldContinue).toBe(true);
    expect(emitted.some((event) => event.type === 'append')).toBe(true);
  });

  it('같은 turn에서 required tool 성공 호출이 있으면 종료를 허용한다', async () => {
    const mock = createMockExtensionApi();
    const config: RequiredToolsGuardConfig = {
      requiredTools: ['slack__send'],
    };
    registerRequiredToolsGuardExtension(mock.api, config);

    const turnMiddleware = mock.pipeline.turnMiddlewares[0];
    const stepMiddleware = mock.pipeline.stepMiddlewares[0];
    const toolCallMiddleware = mock.pipeline.toolCallMiddlewares[0];
    if (!turnMiddleware || !stepMiddleware || !toolCallMiddleware) {
      throw new Error('required-tools-guard middlewares are missing');
    }

    const emitted: MessageEvent[] = [];
    let stepResult: StepResult | undefined;
    await turnMiddleware(
      createTurnContext({
        turnId: 'turn-allow-end',
        emitted,
        next: async () => {
          await toolCallMiddleware(
            createToolCallContext({
              turnId: 'turn-allow-end',
              toolName: 'slack__send',
              result: {
                toolCallId: 'tc-2',
                toolName: 'slack__send',
                status: 'ok',
                output: { ok: true },
              },
            }),
          );

          stepResult = await stepMiddleware(
            createStepContext({
              turnId: 'turn-allow-end',
              emitted,
              result: {
                status: 'completed',
                shouldContinue: false,
                toolCalls: [],
                toolResults: [],
                metadata: {},
              },
            }),
          );

          return {
            turnId: 'turn-allow-end',
            finishReason: 'text_response',
          };
        },
      }),
    );

    expect(stepResult?.shouldContinue).toBe(false);
    expect(emitted.some((event) => event.type === 'append')).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  registerLoggingExtension,
} from '../src/extensions/logging.js';
import {
  registerToolSearchExtension,
} from '../src/extensions/tool-search.js';
import type {
  StepMiddlewareContext,
  ToolCallMiddlewareContext,
  TurnMiddlewareContext,
} from '../src/types.js';
import { isJsonObject } from '../src/utils.js';
import {
  createConversationState,
  createMessage,
  createMockExtensionApi,
  createToolContext,
  createTempWorkspace,
} from './helpers.js';

describe('logging extension', () => {
  it('registers turn/step/toolCall middleware and logs lifecycle', async () => {
    const mock = createMockExtensionApi();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    try {
      registerLoggingExtension(mock.api, {
        level: 'debug',
        includeToolArgs: true,
      });

      expect(mock.pipeline.turnMiddlewares.length).toBe(1);
      expect(mock.pipeline.stepMiddlewares.length).toBe(1);
      expect(mock.pipeline.toolCallMiddlewares.length).toBe(1);

      const turnCtx: TurnMiddlewareContext = {
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
        conversationState: createConversationState([createMessage('m1', 'hello')]),
        emitMessageEvent() {},
        metadata: {},
        async next() {
          return {
            turnId: 'turn-1',
            finishReason: 'text_response',
          };
        },
      };

      const stepCtx: StepMiddlewareContext = {
        agentName: 'agent-a',
        instanceKey: 'instance-1',
        turnId: 'turn-1',
        traceId: 'trace-1',
        turn: { id: 'turn-1', startedAt: new Date() },
        stepIndex: 0,
        conversationState: createConversationState([createMessage('m1', 'hello')]),
        emitMessageEvent() {},
        toolCatalog: [
          { name: 'bash__exec' },
        ],
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

      const toolCtx: ToolCallMiddlewareContext = {
        agentName: 'agent-a',
        instanceKey: 'instance-1',
        turnId: 'turn-1',
        traceId: 'trace-1',
        stepIndex: 0,
        toolName: 'bash__exec',
        toolCallId: 'tc-1',
        args: {
          command: 'echo hello',
        },
        metadata: {},
        async next() {
          return {
            toolCallId: 'tc-1',
            toolName: 'bash__exec',
            status: 'ok',
            output: {
              stdout: 'hello',
            },
          };
        },
      };

      const turnMiddleware = mock.pipeline.turnMiddlewares[0];
      const stepMiddleware = mock.pipeline.stepMiddlewares[0];
      const toolCallMiddleware = mock.pipeline.toolCallMiddlewares[0];

      if (!turnMiddleware || !stepMiddleware || !toolCallMiddleware) {
        throw new Error('Missing logging middlewares');
      }

      await turnMiddleware(turnCtx);
      await stepMiddleware(stepCtx);
      await toolCallMiddleware(toolCtx);

      expect(infoSpy).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});

describe('tool-search extension', () => {
  it('stores selected tools and filters next step catalog', async () => {
    const mock = createMockExtensionApi();
    registerToolSearchExtension(mock.api, {
      toolName: 'tool-search__search',
      maxResults: 5,
      minQueryLength: 1,
      persistSelection: true,
    });

    expect(mock.pipeline.stepMiddlewares.length).toBe(1);
    expect(mock.tools.length).toBe(1);
    const registeredTool = mock.tools[0];
    if (!registeredTool) {
      throw new Error('Missing tool-search tool registration');
    }
    expect(registeredTool.item.name).toBe('tool-search__search');

    const firstStep: StepMiddlewareContext = {
      agentName: 'agent-a',
      instanceKey: 'instance-1',
      turnId: 'turn-1',
      traceId: 'trace-1',
      turn: { id: 'turn-1', startedAt: new Date() },
      stepIndex: 0,
      conversationState: createConversationState([createMessage('m1', 'hello')]),
      emitMessageEvent() {},
      toolCatalog: [
        { name: 'bash__exec', description: 'run command' },
        { name: 'file-system__read', description: 'read file' },
        { name: 'tool-search__search', description: 'search tools' },
      ],
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

    const stepMiddleware = mock.pipeline.stepMiddlewares[0];
    if (!stepMiddleware) {
      throw new Error('Missing tool-search step middleware');
    }
    await stepMiddleware(firstStep);

    const workspace = await createTempWorkspace();
    try {
      const toolCtx = createToolContext(workspace.path);
      const searchOutput = await registeredTool.handler(toolCtx, {
        query: 'bash',
      });

      expect(isJsonObject(searchOutput)).toBe(true);
      if (!isJsonObject(searchOutput)) {
        return;
      }

      const selectedTools = searchOutput.selectedTools;
      expect(Array.isArray(selectedTools)).toBe(true);

      const secondStep: StepMiddlewareContext = {
        ...firstStep,
        toolCatalog: [
          { name: 'bash__exec', description: 'run command' },
          { name: 'file-system__read', description: 'read file' },
          { name: 'tool-search__search', description: 'search tools' },
        ],
      };

      await stepMiddleware(secondStep);

      const names = secondStep.toolCatalog.map((item) => item.name);
      expect(names).toContain('tool-search__search');
      expect(names).toContain('bash__exec');
      expect(names).not.toContain('file-system__read');

      const persisted = mock.getState();
      expect(isJsonObject(persisted)).toBe(true);
      if (isJsonObject(persisted)) {
        const selected = persisted.selectedTools;
        expect(Array.isArray(selected)).toBe(true);
      }
    } finally {
      await workspace.cleanup();
    }
  });
});

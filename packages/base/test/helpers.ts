import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentToolRuntime,
  ConversationState,
  ExtensionApi,
  JsonValue,
  Message,
  PipelineRegistry,
  StepMiddleware,
  ToolCallMiddleware,
  ToolCatalogItem,
  ToolContext,
  ToolHandler,
  TurnMiddleware,
} from '../src/types.js';

export interface TempWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

export async function createTempWorkspace(prefix = 'goondan-base-'): Promise<TempWorkspace> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export function createMessage(id: string, content: string, pinned = false): Message {
  return {
    id,
    data: {
      role: 'user',
      content,
    },
    metadata: pinned ? { pinned: true } : {},
    createdAt: new Date(),
    source: { type: 'user' },
  };
}

export function createConversationState(messages: Message[]): ConversationState {
  return {
    baseMessages: messages,
    events: [],
    nextMessages: messages,
    toLlmMessages(): Message['data'][] {
      return messages.map((message) => message.data);
    },
  };
}

export function createToolContext(
  workdir: string,
  runtime?: AgentToolRuntime
): ToolContext {
  return {
    agentName: 'agent-a',
    instanceKey: 'instance-1',
    turnId: 'turn-1',
    traceId: 'trace-1',
    toolCallId: 'tool-call-1',
    workdir,
    logger: console,
    message: {
      id: 'assistant-msg-1',
      data: {
        role: 'assistant',
        content: '',
      },
      metadata: {},
      createdAt: new Date(),
      source: {
        type: 'assistant',
        stepId: 'step-1',
      },
    },
    runtime,
  };
}

class TestPipelineRegistry implements PipelineRegistry {
  readonly turnMiddlewares: TurnMiddleware[] = [];
  readonly stepMiddlewares: StepMiddleware[] = [];
  readonly toolCallMiddlewares: ToolCallMiddleware[] = [];

  register(type: 'turn', middleware: TurnMiddleware): void;
  register(type: 'step', middleware: StepMiddleware): void;
  register(type: 'toolCall', middleware: ToolCallMiddleware): void;
  register(
    ...args:
      | ['turn', TurnMiddleware]
      | ['step', StepMiddleware]
      | ['toolCall', ToolCallMiddleware]
  ): void {
    const [type, middleware] = args;
    if (type === 'turn') {
      this.turnMiddlewares.push(middleware);
      return;
    }

    if (type === 'step') {
      this.stepMiddlewares.push(middleware);
      return;
    }

    this.toolCallMiddlewares.push(middleware);
  }
}

class InMemoryEvents {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): () => void {
    const existing = this.handlers.get(event);
    if (existing) {
      existing.add(handler);
    } else {
      this.handlers.set(event, new Set([handler]));
    }

    return () => {
      const target = this.handlers.get(event);
      if (!target) {
        return;
      }
      target.delete(handler);
      if (target.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  emit(event: string, ...args: unknown[]): void {
    const target = this.handlers.get(event);
    if (!target) {
      return;
    }

    for (const handler of target) {
      handler(...args);
    }
  }
}

export interface RegisteredTool {
  item: ToolCatalogItem;
  handler: ToolHandler;
}

export interface MockExtensionApi {
  api: ExtensionApi;
  pipeline: TestPipelineRegistry;
  tools: RegisteredTool[];
  getState(): JsonValue | null;
}

export function createMockExtensionApi(initialState: JsonValue | null = null): MockExtensionApi {
  let state = initialState;
  const pipeline = new TestPipelineRegistry();
  const events = new InMemoryEvents();
  const tools: RegisteredTool[] = [];

  const api: ExtensionApi = {
    pipeline,
    tools: {
      register(item: ToolCatalogItem, handler: ToolHandler): void {
        const existingIndex = tools.findIndex((entry) => entry.item.name === item.name);
        if (existingIndex >= 0) {
          tools.splice(existingIndex, 1, { item, handler });
          return;
        }
        tools.push({ item, handler });
      },
    },
    state: {
      async get(): Promise<JsonValue | null> {
        return state;
      },
      async set(value: JsonValue): Promise<void> {
        state = value;
      },
    },
    events: {
      on(event: string, handler: (...args: unknown[]) => void): () => void {
        return events.on(event, handler);
      },
      emit(event: string, ...args: unknown[]): void {
        events.emit(event, ...args);
      },
    },
    logger: console,
  };

  return {
    api,
    pipeline,
    tools,
    getState(): JsonValue | null {
      return state;
    },
  };
}

export function randomId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

import { vi } from "vitest";
import type {
  AgentExtensionApi,
  ConversationState,
  ExtensionStore,
  IngressMiddleware,
  Message,
  MessageEvent,
  MiddlewareOptions,
  ModelInput,
  ModelInputMiddleware,
  StepContext,
  StepMiddleware,
  ToolCallMiddleware,
  ToolDefinition,
  TurnContext,
  TurnMiddleware,
} from "@goondan/openharness-types";

/**
 * A middleware registration captured by the mock api. `kind` records which
 * `use*` method received it so tests can assert level routing without the old
 * string-dispatched `pipeline.register("turn", ...)`.
 */
export type RegisteredMiddleware =
  | { kind: "turn"; handler: TurnMiddleware; options?: MiddlewareOptions }
  | { kind: "step"; handler: StepMiddleware; options?: MiddlewareOptions }
  | { kind: "toolCall"; handler: ToolCallMiddleware; options?: MiddlewareOptions }
  | { kind: "ingress"; handler: IngressMiddleware; options?: MiddlewareOptions };

export interface MockApiResult {
  api: AgentExtensionApi;
  registered: RegisteredMiddleware[];
  modelInputs: ModelInputMiddleware[];
  registeredTools: ToolDefinition[];
  eventListeners: Map<string, Array<(payload: unknown) => void>>;
}

/** Build a mock {@link ConversationState} backed by a mutable message array. */
export function makeMockConversationState(
  initial: Message[] = [],
): ConversationState & { appended: MessageEvent[] } {
  const messages: Message[] = [...initial];
  const appended: MessageEvent[] = [];
  const events: MessageEvent[] = [];

  const state: ConversationState & { appended: MessageEvent[] } = {
    appended,
    getEventLog: vi.fn(() => events as readonly MessageEvent[]),
    getMessages: vi.fn(() => messages as readonly Message[]),
    append: vi.fn((event: MessageEvent) => {
      appended.push(event);
      events.push(event);
      switch (event.type) {
        case "appendSystem":
        case "appendMessage":
          messages.push(event.message);
          break;
        case "remove": {
          const idx = messages.findIndex((m) => m.id === event.messageId);
          if (idx !== -1) messages.splice(idx, 1);
          break;
        }
        case "replace": {
          const idx = messages.findIndex((m) => m.id === event.messageId);
          if (idx !== -1) messages[idx] = event.message;
          break;
        }
        case "truncate":
          if (messages.length > event.keepLast) {
            messages.splice(0, messages.length - event.keepLast);
          }
          break;
      }
    }),
    restore: vi.fn(),
  };

  return state;
}

/** Build a mock {@link ExtensionStore} backed by an in-memory Map. */
export function makeMockStore(): ExtensionStore {
  const map = new Map<string, unknown>();
  return {
    get<T = unknown>(key: string): Promise<T | undefined> {
      return Promise.resolve(map.get(key) as T | undefined);
    },
    set(key: string, value: unknown): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      map.delete(key);
      return Promise.resolve();
    },
    keys(): Promise<readonly string[]> {
      return Promise.resolve([...map.keys()]);
    },
  };
}

/**
 * Build a mock {@link AgentExtensionApi} that records `use*` registrations,
 * model-input projections, registered tools, and event listeners.
 */
export function makeMockApi(
  conversation: ConversationState = makeMockConversationState(),
  availableTools: ToolDefinition[] = [],
): MockApiResult {
  const registered: RegisteredMiddleware[] = [];
  const modelInputs: ModelInputMiddleware[] = [];
  const registeredTools: ToolDefinition[] = [...availableTools];
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();

  const api: AgentExtensionApi = {
    useTurn: vi.fn((handler: TurnMiddleware, options?: MiddlewareOptions) => {
      registered.push({ kind: "turn", handler, options });
    }),
    useStep: vi.fn((handler: StepMiddleware, options?: MiddlewareOptions) => {
      registered.push({ kind: "step", handler, options });
    }),
    useToolCall: vi.fn(
      (handler: ToolCallMiddleware, options?: MiddlewareOptions) => {
        registered.push({ kind: "toolCall", handler, options });
      },
    ),
    useModelInput: vi.fn((handler: ModelInputMiddleware) => {
      modelInputs.push(handler);
    }),
    tools: {
      register: vi.fn((tool: ToolDefinition) => {
        registeredTools.push(tool);
      }),
      remove: vi.fn(),
      list: vi.fn(() => registeredTools as readonly ToolDefinition[]),
    },
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const list = eventListeners.get(event) ?? [];
      list.push(listener);
      eventListeners.set(event, list);
    }) as AgentExtensionApi["on"],
    events: {
      emit: vi.fn(),
    } as unknown as AgentExtensionApi["events"],
    conversation,
    runtime: {
      agent: {
        name: "test-agent",
        model: { provider: "openai", model: "gpt-4o" },
        extensions: [],
        tools: [],
      },
      agents: {},
      connections: {},
    },
  };

  return { api, registered, modelInputs, registeredTools, eventListeners };
}

const inboundEnvelope = {
  name: "test-event",
  content: [{ type: "text" as const, text: "hello" }],
  properties: {},
  source: {
    connector: "test-connector",
    connectionName: "test",
    receivedAt: new Date().toISOString(),
  },
};

/** Build a {@link TurnContext} with the given conversation and a mock store. */
export function makeTurnContext(conversation: ConversationState): TurnContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation,
    abortSignal: new AbortController().signal,
    input: inboundEnvelope,
    llm: {
      chat: vi.fn().mockResolvedValue({ text: "mock" }),
    } as unknown as TurnContext["llm"],
    store: makeMockStore(),
  };
}

/** Build a {@link StepContext} with the given conversation and a mock store. */
export function makeStepContext(
  conversation: ConversationState,
  llmText = "mock",
): StepContext {
  return {
    ...makeTurnContext(conversation),
    stepNumber: 1,
    llm: {
      chat: vi.fn().mockResolvedValue({ text: llmText }),
    } as unknown as StepContext["llm"],
  };
}

/** Synthesize a plain user message with the given id. */
export function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    data: { role: "user" as const, content: `Message ${i}` },
  }));
}

/** Fire all listeners registered for `event` with `payload`. */
export function emitEvent(
  eventListeners: Map<string, Array<(payload: unknown) => void>>,
  event: string,
  payload: unknown,
): void {
  eventListeners.get(event)?.forEach((l) => {
    l(payload);
  });
}

/** Build a dummy {@link ToolDefinition}. */
export function makeDummyTool(
  name: string,
  description = `Tool ${name}`,
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
    handler: async () => ({ type: "text", text: "ok" }),
  };
}

/** Project a conversation's messages through the registered model-input pipes. */
export async function applyModelInputs(
  modelInputs: ModelInputMiddleware[],
  conversation: ConversationState,
  ctx: StepContext,
): Promise<ModelInput> {
  let view: ModelInput = conversation.getMessages();
  for (const mw of modelInputs) {
    view = await mw(view, ctx);
  }
  return view;
}

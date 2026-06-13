import { vi } from "vitest";
import type {
  AgentExtensionApi,
  ConversationState,
  EventsApi,
  Message,
  MessageEvent,
  PromptApi,
  PromptProjection,
  PromptTransformOptions,
  PromptView,
  RecoveryApi,
  RecoveryClaimMeta,
  RecoveryClaimOptions,
  RecoveryMatcher,
  SlotKey,
  SlotStore,
  StepContext,
  ToolDefinition,
  TurnContext,
} from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Shared test doubles for the base extensions.
//
// The 1.0 extension API (F1–F6) gives every agent extension a `recovery`,
// `prompt`, and `events` surface and a turn-scoped `slots` store. These helpers
// build complete mocks of that surface and capture everything an extension
// registers (middleware, projections, claims, event listeners) so tests can
// drive each piece in isolation.
// ---------------------------------------------------------------------------

export interface CapturedMiddleware {
  level: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
  options?: { phase?: string; before?: unknown; after?: unknown };
}

export interface CapturedProjection {
  name: string;
  projection: PromptProjection;
  options?: PromptTransformOptions;
}

export interface CapturedClaim {
  matcher: RecoveryMatcher;
  options: RecoveryClaimOptions;
  meta?: RecoveryClaimMeta;
}

export interface MockApi {
  api: AgentExtensionApi;
  registeredMiddleware: CapturedMiddleware[];
  projections: CapturedProjection[];
  claims: CapturedClaim[];
  eventListeners: Map<string, Array<(payload: unknown) => void>>;
  emittedEvents: Array<{ event: string; payload: unknown }>;
}

export type MockConversation = ConversationState & { emitted: MessageEvent[] };

/** A ConversationState whose `emit` records events and folds them into `messages`. */
export function makeMockConversationState(
  messages: Message[] = [],
): MockConversation {
  const emitted: MessageEvent[] = [];
  return {
    messages,
    events: [],
    emitted,
    emit: vi.fn((event: MessageEvent) => {
      emitted.push(event);
      if (event.type === "appendSystem" || event.type === "appendMessage") {
        messages.push(event.message);
      } else if (event.type === "remove") {
        const idx = messages.findIndex((m) => m.id === event.messageId);
        if (idx >= 0) messages.splice(idx, 1);
      }
    }),
    restore: vi.fn(),
  } as MockConversation;
}

/**
 * Minimal turn-scoped slot store. Unlike the core implementation it has no
 * declaration gate — base extensions don't use slots, so tests only need the
 * get/tryGet/set contract to exist and round-trip.
 */
export function makeSlotStore(): SlotStore {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: SlotKey<T>): T {
      if (!values.has(key.id)) {
        throw new Error(`SlotUnsetError: slot "${key.id}" is unset`);
      }
      return values.get(key.id) as T;
    },
    tryGet<T>(key: SlotKey<T>): T | undefined {
      return values.get(key.id) as T | undefined;
    },
    set<T>(key: SlotKey<T>, value: T): void {
      values.set(key.id, value);
    },
  };
}

/** A complete mock AgentExtensionApi that captures everything an extension registers. */
export function makeMockApi(
  conversation: ConversationState,
  availableTools: ToolDefinition[] = [],
): MockApi {
  const registeredMiddleware: CapturedMiddleware[] = [];
  const projections: CapturedProjection[] = [];
  const claims: CapturedClaim[] = [];
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const tools = [...availableTools];

  const prompt: PromptApi = {
    transform: vi.fn(
      (
        name: string,
        projection: PromptProjection,
        options?: PromptTransformOptions,
      ) => {
        projections.push({ name, projection, options });
      },
    ),
    // Runs captured projections in registration order — enough for unit tests,
    // which never exercise topo ordering here.
    apply: vi.fn(async (messages: readonly Message[], ctx: StepContext) => {
      let view: PromptView = messages;
      for (const { projection } of projections) {
        view = await projection(view, ctx);
      }
      return view;
    }),
  };

  const recovery: RecoveryApi = {
    claim: vi.fn(
      (
        matcher: RecoveryMatcher,
        options: RecoveryClaimOptions,
        meta?: RecoveryClaimMeta,
      ) => {
        claims.push({ matcher, options, meta });
      },
    ),
  };

  const events = {
    emit: vi.fn((event: unknown, payload?: unknown) => {
      emittedEvents.push({ event: event as string, payload });
    }),
  } as unknown as EventsApi;

  const api: AgentExtensionApi = {
    pipeline: {
      register: vi.fn(
        (level: string, handler: unknown, options?: unknown) => {
          registeredMiddleware.push({
            level,
            handler,
            options: options as CapturedMiddleware["options"],
          });
        },
      ) as unknown as AgentExtensionApi["pipeline"]["register"],
    },
    tools: {
      register: vi.fn((tool: ToolDefinition) => {
        tools.push(tool);
      }),
      remove: vi.fn(),
      list: vi.fn(() => tools as readonly ToolDefinition[]),
    },
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const list = eventListeners.get(event) ?? [];
      list.push(listener);
      eventListeners.set(event, list);
    }) as unknown as AgentExtensionApi["on"],
    recovery,
    prompt,
    events,
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

  return {
    api,
    registeredMiddleware,
    projections,
    claims,
    eventListeners,
    emittedEvents,
  };
}

export function makeTurnContext(
  conversation: ConversationState,
  slots: SlotStore = makeSlotStore(),
): TurnContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation,
    slots,
    abortSignal: new AbortController().signal,
    input: {
      name: "test-event",
      content: [{ type: "text", text: "hello" }],
      properties: {},
      source: {
        connector: "test-connector",
        connectionName: "test",
        receivedAt: new Date().toISOString(),
      },
    },
    llm: { chat: vi.fn().mockResolvedValue({ text: "mock" }) },
  };
}

export function makeStepContext(
  conversation: ConversationState,
  slots: SlotStore = makeSlotStore(),
): StepContext {
  return {
    turnId: "turn-1",
    agentName: "test-agent",
    conversationId: "conv-1",
    conversation,
    slots,
    stepNumber: 1,
    abortSignal: new AbortController().signal,
    input: {
      name: "test-event",
      content: [{ type: "text", text: "hello" }],
      properties: {},
      source: {
        connector: "test-connector",
        connectionName: "test",
        receivedAt: new Date().toISOString(),
      },
    },
    llm: { chat: vi.fn().mockResolvedValue({ text: "mock" }) },
  };
}

/** Build a list of plain user messages for window/compaction tests. */
export function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    data: { role: "user" as const, content: `Message ${i}` },
  }));
}

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

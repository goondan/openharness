import { randomBytes } from "node:crypto";
import type {
  AgentEvent,
  ConversationState,
  ExecutionContext,
  JsonObject,
  JsonValue,
  MiddlewareAgentsApi,
  MessageEvent,
  RuntimeContext,
  StepResult,
  ToolCallResult,
  ToolCatalogItem,
  Turn,
  TurnResult,
} from "../types.js";
import {
  STEP_STARTED_LLM_INPUT_MESSAGES_METADATA_KEY,
  type RuntimeEventBus,
  type StepStartedLlmInputMessageContentSource,
  type StepStartedLlmInputMessagePart,
  type StepStartedLlmInputMessage,
  type StepStartedLlmInputTextPart,
  type StepStartedLlmInputToolCallPart,
  type StepStartedLlmInputToolResultPart,
  type TokenUsage,
} from "../events/runtime-events.js";

export type PipelineType = "turn" | "step" | "toolCall";

export interface MiddlewareOptions {
  priority?: number;
}

export interface TurnMiddlewareContext extends ExecutionContext {
  readonly inputEvent: AgentEvent;
  readonly conversationState: ConversationState;
  readonly agents: MiddlewareAgentsApi;
  readonly runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  metadata: Record<string, JsonValue>;
  next(): Promise<TurnResult>;
}

export interface StepMiddlewareContext extends ExecutionContext {
  readonly turn: Turn;
  readonly stepIndex: number;
  readonly conversationState: ConversationState;
  readonly agents: MiddlewareAgentsApi;
  readonly runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  toolCatalog: ToolCatalogItem[];
  metadata: Record<string, JsonValue>;
  next(): Promise<StepResult>;
}

export interface ToolCallMiddlewareContext extends ExecutionContext {
  readonly stepIndex: number;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly runtime: RuntimeContext;
  args: JsonObject;
  metadata: Record<string, JsonValue>;
  next(): Promise<ToolCallResult>;
}

export type TurnMiddleware = (ctx: TurnMiddlewareContext) => Promise<TurnResult>;
export type StepMiddleware = (ctx: StepMiddlewareContext) => Promise<StepResult>;
export type ToolCallMiddleware = (ctx: ToolCallMiddlewareContext) => Promise<ToolCallResult>;

interface MiddlewareEntry<T> {
  readonly fn: T;
  readonly priority: number;
  readonly registrationOrder: number;
}

interface TurnMutableState extends ExecutionContext {
  inputEvent: AgentEvent;
  conversationState: ConversationState;
  agents: MiddlewareAgentsApi;
  runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  metadata: Record<string, JsonValue>;
}

interface StepMutableState extends ExecutionContext {
  turn: Turn;
  stepIndex: number;
  conversationState: ConversationState;
  agents: MiddlewareAgentsApi;
  runtime: RuntimeContext;
  emitMessageEvent(event: MessageEvent): void;
  toolCatalog: ToolCatalogItem[];
  metadata: Record<string, JsonValue>;
}

interface ToolCallMutableState extends ExecutionContext {
  stepIndex: number;
  toolName: string;
  toolCallId: string;
  runtime: RuntimeContext;
  args: JsonObject;
  metadata: Record<string, JsonValue>;
}

// ---------------------------------------------------------------------------
// OTel-compatible span ID generation (64-bit hex)
// ---------------------------------------------------------------------------

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function isJsonObjectValue(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStepStartedLlmInputMessageContentSource(
  value: JsonValue | undefined,
): StepStartedLlmInputMessageContentSource | undefined {
  if (value === "verbatim" || value === "summary") {
    return value;
  }
  return undefined;
}

function readStepStartedLlmInputMessageParts(
  value: JsonValue | undefined,
): StepStartedLlmInputMessagePart[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts: StepStartedLlmInputMessagePart[] = [];
  for (const item of value) {
    if (!isJsonObjectValue(item)) {
      continue;
    }

    const type = item["type"];
    const truncated = item["truncated"] === true ? true : undefined;

    if (type === "text") {
      const text = item["text"];
      if (typeof text !== "string") {
        continue;
      }
      const part: StepStartedLlmInputTextPart = { type: "text", text };
      if (truncated) {
        part.truncated = truncated;
      }
      parts.push(part);
      continue;
    }

    if (type === "tool-call") {
      const toolCallId = item["toolCallId"];
      const toolName = item["toolName"];
      const input = item["input"];
      if (typeof toolCallId !== "string" || typeof toolName !== "string" || typeof input !== "string") {
        continue;
      }
      const part: StepStartedLlmInputToolCallPart = {
        type: "tool-call",
        toolCallId,
        toolName,
        input,
      };
      if (truncated) {
        part.truncated = truncated;
      }
      parts.push(part);
      continue;
    }

    if (type === "tool-result") {
      const toolCallId = item["toolCallId"];
      const toolName = item["toolName"];
      const output = item["output"];
      if (typeof toolCallId !== "string" || typeof toolName !== "string" || typeof output !== "string") {
        continue;
      }
      const part: StepStartedLlmInputToolResultPart = {
        type: "tool-result",
        toolCallId,
        toolName,
        output,
      };
      if (truncated) {
        part.truncated = truncated;
      }
      parts.push(part);
    }
  }

  return parts.length > 0 ? parts : undefined;
}

function readStepStartedLlmInputMessages(
  metadata: Record<string, JsonValue>,
): StepStartedLlmInputMessage[] | undefined {
  const raw = metadata[STEP_STARTED_LLM_INPUT_MESSAGES_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const messages: StepStartedLlmInputMessage[] = [];
  for (const item of raw) {
    if (!isJsonObjectValue(item)) {
      continue;
    }
    const role = item["role"];
    const content = item["content"];
    if (typeof role !== "string" || role.length === 0 || typeof content !== "string") {
      continue;
    }
    const message: StepStartedLlmInputMessage = {
      role,
      content,
    };
    const contentSource = readStepStartedLlmInputMessageContentSource(item["contentSource"]);
    if (contentSource !== undefined) {
      message.contentSource = contentSource;
    }
    const parts = readStepStartedLlmInputMessageParts(item["parts"]);
    if (parts !== undefined) {
      message.parts = parts;
    }
    messages.push(message);
  }

  return messages.length > 0 ? messages : undefined;
}

function readTokenUsage(metadata: Record<string, JsonValue>): TokenUsage | undefined {
  const raw = metadata["runtime.tokenUsage"];
  if (raw === undefined || raw === null || !isJsonObjectValue(raw)) {
    return undefined;
  }

  const promptTokens = raw["promptTokens"];
  const completionTokens = raw["completionTokens"];
  const totalTokens = raw["totalTokens"];

  if (typeof promptTokens !== "number" || typeof completionTokens !== "number" || typeof totalTokens !== "number") {
    return undefined;
  }

  return { promptTokens, completionTokens, totalTokens };
}

// ---------------------------------------------------------------------------
// Turn-scoped step tracking (thread-safe per-turn counter)
// ---------------------------------------------------------------------------

interface TurnScope {
  stepCount: number;
  spanId: string;
  tokenUsage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PipelineRegistry {
  register(type: "turn", fn: TurnMiddleware, options?: MiddlewareOptions): void;
  register(type: "step", fn: StepMiddleware, options?: MiddlewareOptions): void;
  register(type: "toolCall", fn: ToolCallMiddleware, options?: MiddlewareOptions): void;
  runTurn(ctx: Omit<TurnMiddlewareContext, "next">, core: TurnMiddleware): Promise<TurnResult>;
  runStep(ctx: Omit<StepMiddlewareContext, "next">, core: StepMiddleware): Promise<StepResult>;
  runToolCall(
    ctx: Omit<ToolCallMiddlewareContext, "next">,
    core: ToolCallMiddleware,
  ): Promise<ToolCallResult>;
}

export class PipelineRegistryImpl implements PipelineRegistry {
  private turnMiddlewares: MiddlewareEntry<TurnMiddleware>[] = [];
  private stepMiddlewares: MiddlewareEntry<StepMiddleware>[] = [];
  private toolCallMiddlewares: MiddlewareEntry<ToolCallMiddleware>[] = [];

  /** Turn-scoped tracking: turnId → TurnScope */
  private activeTurnScopes = new Map<string, TurnScope>();

  constructor(private readonly eventBus?: RuntimeEventBus) {}

  register(...args: ["turn", TurnMiddleware, MiddlewareOptions?]): void;
  register(...args: ["step", StepMiddleware, MiddlewareOptions?]): void;
  register(...args: ["toolCall", ToolCallMiddleware, MiddlewareOptions?]): void;
  register(
    ...args:
      | ["turn", TurnMiddleware, MiddlewareOptions?]
      | ["step", StepMiddleware, MiddlewareOptions?]
      | ["toolCall", ToolCallMiddleware, MiddlewareOptions?]
  ): void {
    const [type, fn, options] = args;
    const priority = options?.priority ?? 0;

    if (type === "turn") {
      this.turnMiddlewares.push({
        fn,
        priority,
        registrationOrder: this.turnMiddlewares.length,
      });
      return;
    }

    if (type === "step") {
      this.stepMiddlewares.push({
        fn,
        priority,
        registrationOrder: this.stepMiddlewares.length,
      });
      return;
    }

    this.toolCallMiddlewares.push({
      fn,
      priority,
      registrationOrder: this.toolCallMiddlewares.length,
    });
  }

  async runTurn(ctx: Omit<TurnMiddlewareContext, "next">, core: TurnMiddleware): Promise<TurnResult> {
    const ordered = this.sortEntries(this.turnMiddlewares);
    const state: TurnMutableState = {
      agentName: ctx.agentName,
      instanceKey: ctx.instanceKey,
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      inputEvent: ctx.inputEvent,
      conversationState: ctx.conversationState,
      agents: ctx.agents,
      runtime: ctx.runtime,
      emitMessageEvent: ctx.emitMessageEvent,
      metadata: ctx.metadata,
    };

    const startTime = Date.now();
    const turnSpanId = generateSpanId();
    const turnScope: TurnScope = { stepCount: 0, spanId: turnSpanId };
    this.activeTurnScopes.set(ctx.turnId, turnScope);

    if (this.eventBus !== undefined) {
      await this.eventBus.emit({
        type: "turn.started",
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        instanceKey: ctx.instanceKey,
        traceId: ctx.traceId,
        spanId: turnSpanId,
        parentSpanId: undefined,
        timestamp: new Date().toISOString(),
      });
    }

    const dispatch = async (index: number): Promise<TurnResult> => {
      if (index >= ordered.length) {
        return core(this.createTurnContext(state, this.createNeverNext("turn")));
      }

      const next = async (): Promise<TurnResult> => dispatch(index + 1);
      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("turn middleware entry is missing");
      }
      return entry.fn(this.createTurnContext(state, next));
    };

    try {
      const result = await dispatch(0);

      if (this.eventBus !== undefined) {
        await this.eventBus.emit({
          type: "turn.completed",
          turnId: ctx.turnId,
          agentName: ctx.agentName,
          instanceKey: ctx.instanceKey,
          traceId: ctx.traceId,
          spanId: turnSpanId,
          parentSpanId: undefined,
          stepCount: turnScope.stepCount,
          duration: Date.now() - startTime,
          tokenUsage: turnScope.tokenUsage,
          timestamp: new Date().toISOString(),
        });
      }

      return result;
    } catch (error) {
      if (this.eventBus !== undefined) {
        await this.eventBus.emit({
          type: "turn.failed",
          turnId: ctx.turnId,
          agentName: ctx.agentName,
          instanceKey: ctx.instanceKey,
          traceId: ctx.traceId,
          spanId: turnSpanId,
          parentSpanId: undefined,
          duration: Date.now() - startTime,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
      throw error;
    } finally {
      this.activeTurnScopes.delete(ctx.turnId);
    }
  }

  async runStep(ctx: Omit<StepMiddlewareContext, "next">, core: StepMiddleware): Promise<StepResult> {
    const ordered = this.sortEntries(this.stepMiddlewares);
    const state: StepMutableState = {
      agentName: ctx.agentName,
      instanceKey: ctx.instanceKey,
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      turn: ctx.turn,
      stepIndex: ctx.stepIndex,
      conversationState: ctx.conversationState,
      agents: ctx.agents,
      runtime: ctx.runtime,
      emitMessageEvent: ctx.emitMessageEvent,
      toolCatalog: ctx.toolCatalog,
      metadata: ctx.metadata,
    };

    const stepId = `${ctx.turnId}-step-${ctx.stepIndex}`;
    const startTime = Date.now();
    const stepSpanId = generateSpanId();

    // Resolve parent turn's spanId
    const turnScope = this.activeTurnScopes.get(ctx.turnId);
    const parentTurnSpanId = turnScope?.spanId;

    // Count this step in the turn scope
    if (turnScope) {
      turnScope.stepCount += 1;
    }

    const llmInputMessages = readStepStartedLlmInputMessages(state.metadata);

    if (this.eventBus !== undefined) {
      await this.eventBus.emit({
        type: "step.started",
        stepId,
        stepIndex: ctx.stepIndex,
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        instanceKey: ctx.instanceKey,
        traceId: ctx.traceId,
        spanId: stepSpanId,
        parentSpanId: parentTurnSpanId,
        llmInputMessages,
        timestamp: new Date().toISOString(),
      });
    }

    // Store stepSpanId for tool calls to use as parent
    const stepScopeKey = `${ctx.turnId}:step:${ctx.stepIndex}`;
    this.activeStepSpanIds.set(stepScopeKey, stepSpanId);

    const dispatch = async (index: number): Promise<StepResult> => {
      if (index >= ordered.length) {
        return core(this.createStepContext(state, this.createNeverNext("step")));
      }

      const next = async (): Promise<StepResult> => dispatch(index + 1);
      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("step middleware entry is missing");
      }
      return entry.fn(this.createStepContext(state, next));
    };

    try {
      const result = await dispatch(0);
      const stepTokenUsage = readTokenUsage(result.metadata);

      // Accumulate token usage to turn scope
      if (turnScope && stepTokenUsage) {
        if (turnScope.tokenUsage) {
          turnScope.tokenUsage = {
            promptTokens: turnScope.tokenUsage.promptTokens + stepTokenUsage.promptTokens,
            completionTokens: turnScope.tokenUsage.completionTokens + stepTokenUsage.completionTokens,
            totalTokens: turnScope.tokenUsage.totalTokens + stepTokenUsage.totalTokens,
          };
        } else {
          turnScope.tokenUsage = { ...stepTokenUsage };
        }
      }

      if (this.eventBus !== undefined) {
        await this.eventBus.emit({
          type: "step.completed",
          stepId,
          stepIndex: ctx.stepIndex,
          turnId: ctx.turnId,
          agentName: ctx.agentName,
          instanceKey: ctx.instanceKey,
          traceId: ctx.traceId,
          spanId: stepSpanId,
          parentSpanId: parentTurnSpanId,
          toolCallCount: result.toolCalls.length,
          duration: Date.now() - startTime,
          tokenUsage: stepTokenUsage,
          timestamp: new Date().toISOString(),
        });
      }

      return result;
    } catch (error) {
      if (this.eventBus !== undefined) {
        await this.eventBus.emit({
          type: "step.failed",
          stepId,
          stepIndex: ctx.stepIndex,
          turnId: ctx.turnId,
          agentName: ctx.agentName,
          instanceKey: ctx.instanceKey,
          traceId: ctx.traceId,
          spanId: stepSpanId,
          parentSpanId: parentTurnSpanId,
          duration: Date.now() - startTime,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
      throw error;
    } finally {
      this.activeStepSpanIds.delete(stepScopeKey);
    }
  }

  async runToolCall(
    ctx: Omit<ToolCallMiddlewareContext, "next">,
    core: ToolCallMiddleware,
  ): Promise<ToolCallResult> {
    const ordered = this.sortEntries(this.toolCallMiddlewares);
    const state: ToolCallMutableState = {
      agentName: ctx.agentName,
      instanceKey: ctx.instanceKey,
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      stepIndex: ctx.stepIndex,
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      runtime: ctx.runtime,
      args: ctx.args,
      metadata: ctx.metadata,
    };

    const stepId = `${ctx.turnId}-step-${ctx.stepIndex}`;
    const startTime = Date.now();
    const toolSpanId = generateSpanId();

    // Resolve parent step's spanId
    const stepScopeKey = `${ctx.turnId}:step:${ctx.stepIndex}`;
    const parentStepSpanId = this.activeStepSpanIds.get(stepScopeKey);

    if (this.eventBus !== undefined) {
      await this.eventBus.emit({
        type: "tool.called",
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        stepId,
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        instanceKey: ctx.instanceKey,
        traceId: ctx.traceId,
        spanId: toolSpanId,
        parentSpanId: parentStepSpanId,
        timestamp: new Date().toISOString(),
      });
    }

    const dispatch = async (index: number): Promise<ToolCallResult> => {
      if (index >= ordered.length) {
        return core(this.createToolCallContext(state, this.createNeverNext("toolCall")));
      }

      const next = async (): Promise<ToolCallResult> => dispatch(index + 1);
      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("toolCall middleware entry is missing");
      }
      return entry.fn(this.createToolCallContext(state, next));
    };

    try {
      const result = await dispatch(0);

      if (this.eventBus !== undefined) {
        await this.eventBus.emit({
          type: "tool.completed",
          toolCallId: ctx.toolCallId,
          toolName: ctx.toolName,
          status: result.status,
          duration: Date.now() - startTime,
          stepId,
          turnId: ctx.turnId,
          agentName: ctx.agentName,
          instanceKey: ctx.instanceKey,
          traceId: ctx.traceId,
          spanId: toolSpanId,
          parentSpanId: parentStepSpanId,
          timestamp: new Date().toISOString(),
        });
      }

      return result;
    } catch (error) {
      if (this.eventBus !== undefined) {
        await this.eventBus.emit({
          type: "tool.failed",
          toolCallId: ctx.toolCallId,
          toolName: ctx.toolName,
          duration: Date.now() - startTime,
          stepId,
          turnId: ctx.turnId,
          agentName: ctx.agentName,
          instanceKey: ctx.instanceKey,
          traceId: ctx.traceId,
          spanId: toolSpanId,
          parentSpanId: parentStepSpanId,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
      throw error;
    }
  }

  /** Step spanId tracking for tool call parent resolution */
  private activeStepSpanIds = new Map<string, string>();

  private sortEntries<T>(entries: MiddlewareEntry<T>[]): MiddlewareEntry<T>[] {
    return [...entries].sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.registrationOrder - right.registrationOrder;
    });
  }

  private createTurnContext(state: TurnMutableState, next: () => Promise<TurnResult>): TurnMiddlewareContext {
    return {
      get agentName() {
        return state.agentName;
      },
      get instanceKey() {
        return state.instanceKey;
      },
      get turnId() {
        return state.turnId;
      },
      get traceId() {
        return state.traceId;
      },
      get inputEvent() {
        return state.inputEvent;
      },
      get conversationState() {
        return state.conversationState;
      },
      get agents() {
        return state.agents;
      },
      get runtime() {
        return state.runtime;
      },
      emitMessageEvent(event: MessageEvent): void {
        state.emitMessageEvent(event);
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private createStepContext(state: StepMutableState, next: () => Promise<StepResult>): StepMiddlewareContext {
    return {
      get agentName() {
        return state.agentName;
      },
      get instanceKey() {
        return state.instanceKey;
      },
      get turnId() {
        return state.turnId;
      },
      get traceId() {
        return state.traceId;
      },
      get turn() {
        return state.turn;
      },
      get stepIndex() {
        return state.stepIndex;
      },
      get conversationState() {
        return state.conversationState;
      },
      get agents() {
        return state.agents;
      },
      get runtime() {
        return state.runtime;
      },
      emitMessageEvent(event: MessageEvent): void {
        state.emitMessageEvent(event);
      },
      get toolCatalog() {
        return state.toolCatalog;
      },
      set toolCatalog(value: ToolCatalogItem[]) {
        state.toolCatalog = value;
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private createToolCallContext(
    state: ToolCallMutableState,
    next: () => Promise<ToolCallResult>,
  ): ToolCallMiddlewareContext {
    return {
      get agentName() {
        return state.agentName;
      },
      get instanceKey() {
        return state.instanceKey;
      },
      get turnId() {
        return state.turnId;
      },
      get traceId() {
        return state.traceId;
      },
      get stepIndex() {
        return state.stepIndex;
      },
      get toolName() {
        return state.toolName;
      },
      get toolCallId() {
        return state.toolCallId;
      },
      get runtime() {
        return state.runtime;
      },
      get args() {
        return state.args;
      },
      set args(value: JsonObject) {
        state.args = value;
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private createNeverNext<T>(type: PipelineType): () => Promise<T> {
    return async (): Promise<T> => {
      throw new Error(`next() is not available inside core ${type} handler`);
    };
  }
}

import type {
  HarnessRuntime,
  InboundEnvelope,
  IngressApi,
  ControlApi,
  AbortResult,
  ProcessTurnOptions,
  TurnResult,
  LlmClient,
  EventPayload,
} from "@goondan/openharness-types";
import type { ConversationStateImpl } from "./conversation-state.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { MiddlewareRegistry } from "./middleware-chain.js";
import type { EventBus } from "./event-bus.js";
import type { IngressPipeline } from "./ingress/pipeline.js";
import { createConversationState } from "./conversation-state.js";
import { executeTurn } from "./execution/turn.js";
import { HarnessError, ConfigError } from "./errors.js";
import { randomUUID } from "node:crypto";

const CLOSE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Per-agent deps
// ---------------------------------------------------------------------------

export interface AgentDeps {
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  middlewareRegistry: MiddlewareRegistry;
  eventBus: EventBus;
  maxSteps: number;
}

// ---------------------------------------------------------------------------
// In-flight turn tracking
// ---------------------------------------------------------------------------

interface InFlightTurn {
  agentName: string;
  conversationId: string;
  abortController: AbortController;
  promise: Promise<TurnResult>;
}

// ---------------------------------------------------------------------------
// HarnessRuntimeImpl
// ---------------------------------------------------------------------------

export class HarnessRuntimeImpl implements HarnessRuntime {
  private readonly _agents: Map<string, AgentDeps>;
  private readonly _conversations: Map<string, ConversationStateImpl> = new Map();
  private readonly _inFlightTurns: Map<string, InFlightTurn> = new Map();
  private readonly _ingressPipeline: IngressPipeline;
  private readonly _runtimeEvents: EventBus;
  private _closed = false;

  constructor(agents: Map<string, AgentDeps>, ingressPipeline: IngressPipeline, runtimeEvents: EventBus) {
    this._agents = agents;
    this._ingressPipeline = ingressPipeline;
    this._runtimeEvents = runtimeEvents;
  }

  private _conversationKey(agentName: string, conversationId: string): string {
    return `${agentName}::${conversationId}`;
  }

  private async _processTurnInternal(
    agentName: string,
    input: string | InboundEnvelope,
    options?: (ProcessTurnOptions & { turnId?: string }),
  ): Promise<TurnResult> {
    if (this._closed) {
      throw new HarnessError("Runtime is closed");
    }

    const agentDeps = this._agents.get(agentName);
    if (!agentDeps) {
      throw new ConfigError(`Unknown agent: "${agentName}"`);
    }

    const conversationId =
      options?.conversationId ??
      (typeof input !== "string" && input.conversationId
        ? input.conversationId
        : randomUUID());

    const conversationKey = this._conversationKey(agentName, conversationId);

    let conversationState = this._conversations.get(conversationKey);
    if (!conversationState) {
      conversationState = createConversationState();
      this._conversations.set(conversationKey, conversationState);
    }

    const abortController = new AbortController();
    const trackingId = randomUUID();

    const turnPromise = executeTurn(agentName, input, options, {
      llmClient: agentDeps.llmClient,
      toolRegistry: agentDeps.toolRegistry,
      middlewareRegistry: agentDeps.middlewareRegistry,
      eventBus: agentDeps.eventBus,
      conversationState,
      maxSteps: agentDeps.maxSteps,
      abortController,
    });

    this._inFlightTurns.set(trackingId, {
      agentName,
      conversationId,
      abortController,
      promise: turnPromise,
    });

    try {
      return await turnPromise;
    } finally {
      this._inFlightTurns.delete(trackingId);
    }
  }

  // -----------------------------------------------------------------------
  // processTurn
  // -----------------------------------------------------------------------

  async processTurn(
    agentName: string,
    input: string | InboundEnvelope,
    options?: ProcessTurnOptions,
  ): Promise<TurnResult> {
    return this._processTurnInternal(agentName, input, options);
  }

  async dispatchTurn(
    agentName: string,
    input: InboundEnvelope,
    options: { conversationId: string; turnId: string },
  ): Promise<TurnResult> {
    return this._processTurnInternal(agentName, input, options);
  }

  // -----------------------------------------------------------------------
  // ingress
  // -----------------------------------------------------------------------

  get ingress(): IngressApi {
    return this._ingressPipeline;
  }

  get events(): HarnessRuntime["events"] {
    return {
      on: <T extends EventPayload["type"]>(
        event: T,
        listener: (payload: Extract<EventPayload, { type: T }>) => void,
      ) => this._runtimeEvents.on(event, listener),
    };
  }

  // -----------------------------------------------------------------------
  // control
  // -----------------------------------------------------------------------

  get control(): ControlApi {
    return {
      abortConversation: async (input: {
        conversationId: string;
        agentName?: string;
        reason?: string;
      }): Promise<AbortResult> => {
        let abortedTurns = 0;

        for (const [id, turn] of this._inFlightTurns) {
          if (turn.conversationId !== input.conversationId) continue;
          if (input.agentName && turn.agentName !== input.agentName) continue;

          turn.abortController.abort(input.reason ?? "abortConversation");
          abortedTurns++;
        }

        return {
          conversationId: input.conversationId,
          abortedTurns,
          reason: input.reason,
        };
      },
    };
  }

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    this._closed = true;

    // Abort all in-flight turns
    const promises: Promise<unknown>[] = [];
    for (const [, turn] of this._inFlightTurns) {
      turn.abortController.abort("Runtime closed");
      promises.push(turn.promise.catch(() => {}));
    }

    // Wait for turns to settle (with timeout)
    if (promises.length > 0) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS));
      await Promise.race([Promise.allSettled(promises), timeout]);
    }

    // Clean up
    this._inFlightTurns.clear();
    this._conversations.clear();
  }
}

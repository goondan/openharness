import type { TurnResult } from "./middleware.js";
import type { InboundEnvelope, IngressApi } from "./ingress.js";
import type { ProcessTurnOptions } from "./config.js";
import type { EventPayload } from "./events.js";

// -----------------------------------------------------------------------
// ControlApi
// -----------------------------------------------------------------------

export interface AbortResult {
  conversationId: string;
  abortedTurns: number;
  reason?: string;
}

export interface ControlApi {
  abortConversation(input: {
    conversationId: string;
    agentName?: string;
    reason?: string;
  }): Promise<AbortResult>;
}

export type RuntimeEventType = EventPayload["type"];

export type RuntimeEventListener<T extends RuntimeEventType> = (
  payload: Extract<EventPayload, { type: T }>,
) => void;

export type RuntimeEventUnsubscribeFn = () => void;

export interface RuntimeEventsApi {
  on<T extends RuntimeEventType>(event: T, listener: RuntimeEventListener<T>): RuntimeEventUnsubscribeFn;
}

// -----------------------------------------------------------------------
// HarnessRuntime
// -----------------------------------------------------------------------

export interface HarnessRuntime {
  processTurn(
    agentName: string,
    input: string | InboundEnvelope,
    options?: ProcessTurnOptions,
  ): Promise<TurnResult>;
  ingress: IngressApi;
  events: RuntimeEventsApi;
  control: ControlApi;
  close(): Promise<void>;
}

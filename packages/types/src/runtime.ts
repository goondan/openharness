import type { TurnResult } from "./middleware.js";
import type { InboundEnvelope, IngressApi } from "./ingress.js";
import type { ProcessTurnOptions } from "./config.js";
import type { EventPayload } from "./events.js";
import type {
  CancelHitlInput,
  CancelHitlBatchInput,
  CancelHitlResult,
  HitlBatchFilter,
  HitlBatchView,
  HitlRequestFilter,
  HitlRequestView,
  ResumeHitlResult,
  SubmitHitlResult,
  SubmitHitlResultInput,
} from "./hitl.js";

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
  listPendingHitl(filter?: HitlRequestFilter): Promise<HitlRequestView[]>;
  listPendingHitlBatches(filter?: HitlBatchFilter): Promise<HitlBatchView[]>;
  getHitlBatch(batchId: string): Promise<HitlBatchView | null>;
  getHitlRequest(requestId: string): Promise<HitlRequestView | null>;
  submitHitlResult(input: SubmitHitlResultInput): Promise<SubmitHitlResult>;
  resumeHitlBatch(batchId: string): Promise<ResumeHitlResult>;
  resumeHitl(requestId: string): Promise<ResumeHitlResult>;
  cancelHitlBatch(input: CancelHitlBatchInput): Promise<CancelHitlResult>;
  cancelHitl(input: CancelHitlInput): Promise<CancelHitlResult>;
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

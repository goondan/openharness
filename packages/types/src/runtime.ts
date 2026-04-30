import type { TurnResult } from "./middleware.js";
import type {
  DeadLetterInboundInput,
  DurableInboundItem,
  InboundEnvelope,
  InboundItemFilter,
  IngressAcceptResult,
  IngressApi,
  ReleaseInboundItemInput,
} from "./ingress.js";
import type { ProcessTurnOptions } from "./config.js";
import type { EventPayload } from "./events.js";
import type {
  CancelHumanGateInput,
  HumanGateRecord,
  HumanTaskFilter,
  HumanTaskView,
  SubmitHumanResult,
  SubmitHumanResultInput,
} from "./tool.js";

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

  listInboundItems?(filter?: InboundItemFilter): Promise<DurableInboundItem[]>;
  retryInboundItem?(id: string): Promise<DurableInboundItem>;
  releaseInboundItem?(input: string | ReleaseInboundItemInput): Promise<DurableInboundItem>;
  deadLetterInboundItem?(input: string | DeadLetterInboundInput): Promise<DurableInboundItem>;

  listHumanTasks?(filter?: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitHumanResult?(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  resumeHumanGate?(id: string): Promise<HumanGateResumeResult>;
  cancelHumanGate?(input: string | CancelHumanGateInput): Promise<HumanGateRecord>;
}

export interface DurableControlApi extends ControlApi {
  listInboundItems(filter?: InboundItemFilter): Promise<DurableInboundItem[]>;
  retryInboundItem(id: string): Promise<DurableInboundItem>;
  releaseInboundItem(input: string | ReleaseInboundItemInput): Promise<DurableInboundItem>;
  deadLetterInboundItem(input: string | DeadLetterInboundInput): Promise<DurableInboundItem>;

  listHumanTasks(filter?: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitHumanResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  resumeHumanGate(id: string): Promise<HumanGateResumeResult>;
  cancelHumanGate(input: string | CancelHumanGateInput): Promise<HumanGateRecord>;
}

export interface HumanGateResumeResult {
  humanGateId: string;
  status: "completed" | "blocked" | "failed";
  gate: HumanGateRecord;
  continuation?: TurnResult;
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

export interface DurableHarnessRuntime extends Omit<HarnessRuntime, "control"> {
  control: DurableControlApi;
}

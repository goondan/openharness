import type { TurnResult } from "./middleware.js";
import type { InboundEnvelope, IngressApi } from "./ingress.js";
import type { ProcessTurnOptions } from "./config.js";

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
  control: ControlApi;
  close(): Promise<void>;
}

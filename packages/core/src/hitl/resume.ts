import type {
  HumanGateRecord,
  HumanGateStore,
} from "./types.js";

export interface HumanGateResumeCoordinatorOptions {
  store: HumanGateStore;
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: () => string;
  resumeGate: (input: ResumeHumanGateHandlerInput) => Promise<ResumeHumanGateHandlerResult> | ResumeHumanGateHandlerResult;
}

export interface ResumeHumanGateHandlerInput {
  gate: HumanGateRecord;
}

export interface ResumeHumanGateHandlerResult {
  blockedInboundItemIds?: string[];
}

export type HumanGateResumeResult =
  | {
      status: "completed";
      gate: HumanGateRecord;
      blockedInboundItemIds: string[];
    }
  | {
      status: "notReady" | "failed";
      humanGateId: string;
      reason: string;
      gate?: HumanGateRecord;
    };

export class HumanGateResumeCoordinator {
  private readonly _options: HumanGateResumeCoordinatorOptions;

  constructor(options: HumanGateResumeCoordinatorOptions) {
    this._options = options;
  }

  async resumeHumanGate(humanGateId: string): Promise<HumanGateResumeResult> {
    const now = this._options.now?.() ?? new Date().toISOString();
    const gate = await this._options.store.acquireGateForResume({
      humanGateId,
      leaseOwner: this._options.leaseOwner,
      leaseTtlMs: this._options.leaseTtlMs,
      now,
    });

    if (!gate) {
      return {
        status: "notReady",
        humanGateId,
        reason: "Gate is missing, not ready, or currently leased by another worker.",
      };
    }

    try {
      const resumeResult = await this._options.resumeGate({ gate });
      const blockedInboundItemIds = resumeResult.blockedInboundItemIds ?? [];
      const completed = await this._options.store.markGateCompleted({
        humanGateId,
        leaseOwner: this._options.leaseOwner,
        blockedInboundItemIds,
        now: this._options.now?.() ?? new Date().toISOString(),
      });
      return {
        status: "completed",
        gate: completed,
        blockedInboundItemIds,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const failed = await this._options.store.markGateFailed({
        humanGateId,
        reason,
        retryable: true,
        leaseOwner: this._options.leaseOwner,
        now: this._options.now?.() ?? new Date().toISOString(),
      });
      return {
        status: "failed",
        humanGateId,
        reason,
        gate: failed,
      };
    }
  }
}

export function createHumanGateResumeCoordinator(
  options: HumanGateResumeCoordinatorOptions,
): HumanGateResumeCoordinator {
  return new HumanGateResumeCoordinator(options);
}

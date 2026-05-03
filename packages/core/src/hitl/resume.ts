import type {
  HumanApprovalRecord,
  HumanApprovalStore,
} from "@goondan/openharness-types";

export interface HumanApprovalResumeCoordinatorOptions {
  store: HumanApprovalStore;
  leaseOwner: string;
  leaseTtlMs?: number;
  now?: () => string;
  resumeApproval: (input: ResumeHumanApprovalHandlerInput) => Promise<ResumeHumanApprovalHandlerResult> | ResumeHumanApprovalHandlerResult;
}

export interface ResumeHumanApprovalHandlerInput {
  approval: HumanApprovalRecord;
}

export interface ResumeHumanApprovalHandlerResult {
  blockedInboundItemIds?: string[];
}

export type HumanApprovalResumeResult =
  | {
      status: "completed";
      approval: HumanApprovalRecord;
      blockedInboundItemIds: string[];
    }
  | {
      status: "notReady" | "failed";
      humanApprovalId: string;
      reason: string;
      approval?: HumanApprovalRecord;
    };

export class HumanApprovalResumeCoordinator {
  private readonly _options: HumanApprovalResumeCoordinatorOptions;

  constructor(options: HumanApprovalResumeCoordinatorOptions) {
    this._options = options;
  }

  async resumeHumanApproval(humanApprovalId: string): Promise<HumanApprovalResumeResult> {
    const now = this._options.now?.() ?? new Date().toISOString();
    const gate = await this._options.store.acquireApprovalForResume({
      humanApprovalId,
      leaseOwner: this._options.leaseOwner,
      leaseTtlMs: this._options.leaseTtlMs,
      now,
    });

    if (!gate) {
      return {
        status: "notReady",
        humanApprovalId,
        reason: "Approval is missing, not ready, or currently leased by another worker.",
      };
    }

    try {
      const resumeResult = await this._options.resumeApproval({ approval: gate });
      const blockedInboundItemIds = resumeResult.blockedInboundItemIds ?? [];
      const completed = await this._options.store.markApprovalCompleted({
        humanApprovalId,
        leaseOwner: this._options.leaseOwner,
        blockedInboundItemIds,
        now: this._options.now?.() ?? new Date().toISOString(),
      });
      return {
        status: "completed",
        approval: completed,
        blockedInboundItemIds,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const failed = await this._options.store.markApprovalFailed({
        humanApprovalId,
        reason,
        retryable: true,
        leaseOwner: this._options.leaseOwner,
        now: this._options.now?.() ?? new Date().toISOString(),
      });
      return {
        status: "failed",
        humanApprovalId,
        reason,
        approval: failed,
      };
    }
  }
}

export function createHumanApprovalResumeCoordinator(
  options: HumanApprovalResumeCoordinatorOptions,
): HumanApprovalResumeCoordinator {
  return new HumanApprovalResumeCoordinator(options);
}

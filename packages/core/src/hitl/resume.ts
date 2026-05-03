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

/**
 * Internal outcome type for the resume coordinator.
 *
 * Distinct from the public `HumanApprovalResumeResult` exposed via
 * `ControlApi.resumeHumanApproval` — this one only describes what the
 * coordinator did to the approval record (and which inbound items it
 * drained), not the continuation that the harness runtime triggers.
 */
export type HumanApprovalResumeOutcome =
  | {
      status: "completed";
      id: string;
      approval: HumanApprovalRecord;
      blockedInboundItemIds: string[];
    }
  | {
      status: "notReady" | "failed";
      id: string;
      reason: string;
      approval?: HumanApprovalRecord;
    };

export class HumanApprovalResumeCoordinator {
  private readonly _options: HumanApprovalResumeCoordinatorOptions;

  constructor(options: HumanApprovalResumeCoordinatorOptions) {
    this._options = options;
  }

  async resumeHumanApproval(id: string): Promise<HumanApprovalResumeOutcome> {
    const now = this._options.now?.() ?? new Date().toISOString();
    const gate = await this._options.store.acquireApprovalForResume({
      id,
      leaseOwner: this._options.leaseOwner,
      leaseTtlMs: this._options.leaseTtlMs,
      now,
    });

    if (!gate) {
      return {
        status: "notReady",
        id,
        reason: "Approval is missing, not ready, or currently leased by another worker.",
      };
    }

    try {
      const resumeResult = await this._options.resumeApproval({ approval: gate });
      const blockedInboundItemIds = resumeResult.blockedInboundItemIds ?? [];
      const completed = await this._options.store.markApprovalCompleted({
        id,
        leaseOwner: this._options.leaseOwner,
        blockedInboundItemIds,
        now: this._options.now?.() ?? new Date().toISOString(),
      });
      return {
        status: "completed",
        id,
        approval: completed,
        blockedInboundItemIds,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const failed = await this._options.store.markApprovalFailed({
        id,
        reason,
        retryable: true,
        leaseOwner: this._options.leaseOwner,
        now: this._options.now?.() ?? new Date().toISOString(),
      });
      return {
        status: "failed",
        id,
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

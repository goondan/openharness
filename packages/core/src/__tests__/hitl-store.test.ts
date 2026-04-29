import { describe, expect, it } from "vitest";
import type { HitlBatchRecord, HitlBatchToolResult, HitlRequestRecord, ToolResult } from "@goondan/openharness-types";
import { InMemoryHitlStore } from "../hitl/store.js";

function requestRecord(overrides: Partial<HitlRequestRecord> = {}): HitlRequestRecord {
  const now = new Date().toISOString();
  const requestId = overrides.requestId ?? "request-1";
  return {
    requestId,
    status: "pending",
    agentName: "default",
    conversationId: `conversation-${requestId}`,
    turnId: "turn-1",
    stepNumber: 1,
    toolCallId: "tool-call-1",
    toolName: "tool",
    originalArgs: {},
    responseSchema: { type: "approval" },
    conversationEvents: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("InMemoryHitlStore", () => {
  it("keeps preparing batches as conversation barriers without exposing them as steer queues", async () => {
    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();
    const batch: HitlBatchRecord = {
      batchId: "preparing-batch-1",
      status: "preparing",
      agentName: "default",
      conversationId: "preparing-conversation",
      turnId: "turn-1",
      stepNumber: 1,
      toolCalls: [{
        toolCallId: "tool-call-1",
        toolCallIndex: 0,
        toolName: "tool",
        toolArgs: {},
        requiresHitl: true,
        requestId: "request-1",
      }],
      toolResults: [],
      toolExecutions: [],
      conversationEvents: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.createBatch({
      batch,
      requests: [requestRecord({
        requestId: "request-1",
        batchId: "preparing-batch-1",
        conversationId: "preparing-conversation",
      })],
    });

    expect(await store.getOpenBatchByConversation("default", "preparing-conversation")).toBeNull();

    const duplicate = await store.createBatch({
      batch: {
        ...batch,
        batchId: "preparing-batch-2",
        toolCalls: [{
          ...batch.toolCalls[0]!,
          toolCallId: "tool-call-2",
          requestId: "request-2",
        }],
      },
      requests: [requestRecord({
        requestId: "request-2",
        batchId: "preparing-batch-2",
        toolCallId: "tool-call-2",
        conversationId: "preparing-conversation",
      })],
    });
    expect(duplicate.status).toBe("conflict");
    if (duplicate.status !== "conflict") throw new Error("expected conflict");
    expect(duplicate.openBatch.batchId).toBe("preparing-batch-1");
  });

  it("lists only pending and resume-recoverable HITL requests", async () => {
    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();

    await store.create(requestRecord({ requestId: "pending-request", status: "pending" }));
    await store.create(requestRecord({ requestId: "resolved-request" }));
    await store.resolve("resolved-request", { decision: "approve", submittedAt: now });
    await store.create(requestRecord({ requestId: "rejected-request" }));
    await store.reject("rejected-request", { decision: "reject", submittedAt: now });
    await store.create(requestRecord({ requestId: "retryable-failed-request" }));
    await store.resolve("retryable-failed-request", { decision: "approve", submittedAt: now });
    const retryableLease = await store.acquireLease("retryable-failed-request", "owner-retryable", 1000);
    expect(retryableLease.acquired).toBe(true);
    if (!retryableLease.acquired) throw new Error("expected retryable lease");
    await store.fail("retryable-failed-request", {
      error: "temporary",
      retryable: true,
      failedAt: now,
    }, {
      ownerId: retryableLease.request.lease!.ownerId,
      token: retryableLease.request.lease!.token,
    });
    await store.create(requestRecord({ requestId: "blocked-request" }));
    await store.resolve("blocked-request", { decision: "approve", submittedAt: now });
    const blockedLease = await store.acquireLease("blocked-request", "owner-blocked", 1000);
    expect(blockedLease.acquired).toBe(true);
    if (!blockedLease.acquired) throw new Error("expected blocked lease");
    await store.startExecution("blocked-request", {
      ownerId: blockedLease.request.lease!.ownerId,
      token: blockedLease.request.lease!.token,
    }, now);
    await store.create(requestRecord({ requestId: "non-retryable-failed-request" }));
    await store.resolve("non-retryable-failed-request", { decision: "approve", submittedAt: now });
    const failedLease = await store.acquireLease("non-retryable-failed-request", "owner-failed", 1000);
    expect(failedLease.acquired).toBe(true);
    if (!failedLease.acquired) throw new Error("expected failed lease");
    await store.fail("non-retryable-failed-request", {
      error: "fatal",
      retryable: false,
      failedAt: now,
    }, {
      ownerId: failedLease.request.lease!.ownerId,
      token: failedLease.request.lease!.token,
    });

    expect((await store.listRecoverable()).map((record) => record.requestId).sort()).toEqual([
      "pending-request",
      "rejected-request",
      "resolved-request",
      "retryable-failed-request",
    ]);
  });

  it("does not reserve idempotency keys when result submission is rejected by state", async () => {
    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();

    await store.create(requestRecord({ requestId: "request-1" }));
    await store.resolve("request-1", { decision: "approve", submittedAt: now });
    const lease = await store.acquireLease("request-1", "owner-1", 1000);
    expect(lease.acquired).toBe(true);

    await expect(
      store.resolve("request-1", { decision: "approve", submittedAt: now }, "result-key-1"),
    ).rejects.toThrow("Cannot submit HITL result for batch in resuming");

    await store.create(requestRecord({ requestId: "request-2" }));
    const accepted = await store.resolve("request-2", {
      decision: "approve",
      submittedAt: now,
    }, "result-key-1");

    expect(accepted.requestId).toBe("request-2");
    expect(accepted.status).toBe("resolved");
  });

  it("rejects stale lease guards after a new owner acquires the request", async () => {
    const store = new InMemoryHitlStore();
    const toolResult: ToolResult = { type: "text", text: "done" };

    await store.create(requestRecord());
    await store.resolve("request-1", {
      decision: "approve",
      submittedAt: new Date().toISOString(),
    });

    const firstLease = await store.acquireLease("request-1", "owner-1", 1);
    expect(firstLease.acquired).toBe(true);
    if (!firstLease.acquired) throw new Error("expected first lease");

    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondLease = await store.acquireLease("request-1", "owner-2", 1000);
    expect(secondLease.acquired).toBe(true);
    if (!secondLease.acquired) throw new Error("expected second lease");

    await expect(
      store.complete("request-1", {
        toolResult,
        completedAt: new Date().toISOString(),
      }, {
        ownerId: firstLease.request.lease!.ownerId,
        token: firstLease.request.lease!.token,
      }),
    ).rejects.toThrow("HITL lease no longer belongs to this runtime");

    const completed = await store.complete("request-1", {
      toolResult,
      completedAt: new Date().toISOString(),
    }, {
      ownerId: secondLease.request.lease!.ownerId,
      token: secondLease.request.lease!.token,
    });

    expect(completed.status).toBe("completed");

    await expect(
      store.complete("request-1", {
        toolResult,
        completedAt: new Date().toISOString(),
      }, {
        ownerId: firstLease.request.lease!.ownerId,
        token: firstLease.request.lease!.token,
      }),
    ).rejects.toThrow("HITL lease no longer belongs to this runtime");
  });

  it("atomically stores HITL tool result and request completion", async () => {
    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();
    const toolResult: ToolResult = { type: "text", text: "done" };
    const batchId = "atomic-batch";
    const requestId = "atomic-request";

    await store.create(requestRecord({
      requestId,
      batchId,
      status: "pending",
      conversationId: "atomic-conversation",
    }));
    await store.resolve(requestId, { decision: "approve", submittedAt: now });
    const lease = await store.acquireLease(requestId, "atomic-owner", 1000);
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) throw new Error("expected lease");
    const guard = {
      ownerId: lease.request.lease!.ownerId,
      token: lease.request.lease!.token,
    };
    await store.startExecution(requestId, guard, now);

    const batchToolResult: HitlBatchToolResult = {
      batchId,
      toolCallId: "tool-call-1",
      toolCallIndex: 0,
      toolName: "tool",
      result: toolResult,
      finalArgs: { approved: true },
      recordedAt: now,
    };

    const completed = await store.completeRequestWithToolResult({
      batchId,
      requestId,
      toolResult: batchToolResult,
      completion: {
        toolResult,
        finalArgs: { approved: true },
        completedAt: now,
      },
      guard,
    });

    expect(completed.request.status).toBe("completed");
    expect(completed.batch.toolResults).toHaveLength(1);
    expect(completed.batch.toolResults[0]).toMatchObject({
      batchId,
      toolCallId: "tool-call-1",
      result: toolResult,
    });
  });
});

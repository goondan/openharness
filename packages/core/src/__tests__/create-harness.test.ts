import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  HarnessConfig,
  LlmClient,
  LlmResponse,
  Extension,
  TurnResult,
  Message,
  ToolDefinition,
  Connector,
  InboundEnvelope,
  ToolResult,
  HitlBatchAppendCommit,
  HitlBatchCompletion,
  HitlBatchFilter,
  HitlBatchRecord,
  HitlBatchToolResult,
  HitlCompletion,
  HitlFailure,
  HitlHumanResult,
  HitlLeaseGuard,
  HitlQueuedSteer,
  HitlQueuedSteerInput,
  HitlRequestRecord,
  HitlStore,
} from "@goondan/openharness-types";
import { defineHarness, env } from "@goondan/openharness-types";
import { createHarness } from "../create-harness.js";
import { HarnessError } from "../errors.js";
import { InMemoryHitlStore } from "../hitl/store.js";

// ---------------------------------------------------------------------------
// Mock LlmClient factory — returns a simple text response
// ---------------------------------------------------------------------------

function mockLlmClient(text = "Hello from mock"): LlmClient {
  return {
    chat: vi.fn().mockResolvedValue({ text, toolCalls: [] } satisfies LlmResponse),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    agents: {
      default: {
        model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
      },
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}


function firstPendingHitlRequestId(result: TurnResult): string {
  const requestId = result.pendingHitlRequestIds?.[0];
  if (!requestId) {
    throw new Error("Expected a pending HITL request id");
  }
  return requestId;
}

async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for assertion");
}

class LeaseStealingFailStore extends InMemoryHitlStore {
  override async failBatch(
    batchId: string,
    _failure: HitlFailure,
    guard?: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    if (!guard) {
      throw new Error("expected lease guard");
    }
    await super.releaseBatchLease(batchId, guard);
    await super.acquireBatchLease(batchId, "other-runtime", 1000);
    throw new Error("simulated stale failure write");
  }
}

class FailingFailStore extends InMemoryHitlStore {
  override async failBatch(
    _batchId: string,
    _failure: HitlFailure,
    _guard?: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    throw new Error("fail store write failed");
  }
}

class FailingResolveStore extends InMemoryHitlStore {
  override async resolveRequest(
    _requestId: string,
    _result: HitlHumanResult,
    _idempotencyKey?: string,
  ): Promise<HitlRequestRecord> {
    throw new Error("resolve store write failed");
  }
}

class FailingRecoverStore extends InMemoryHitlStore {
  override async listRecoverableBatches(_filter?: HitlBatchFilter): Promise<HitlBatchRecord[]> {
    throw new Error("recover store read failed");
  }
}

class DelayedCommitStore extends InMemoryHitlStore {
  readonly commitStarted = deferred<void>();
  readonly allowCommit = deferred<void>();

  override async commitBatchAppend(
    batchId: string,
    appendCommit: HitlBatchAppendCommit,
    guard: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    this.commitStarted.resolve();
    await this.allowCommit.promise;
    return super.commitBatchAppend(batchId, appendCommit, guard);
  }
}

class FailingOnceCommitStore extends InMemoryHitlStore {
  private failed = false;

  override async commitBatchAppend(
    batchId: string,
    appendCommit: HitlBatchAppendCommit,
    guard: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("commit store write failed");
    }
    return super.commitBatchAppend(batchId, appendCommit, guard);
  }
}

class FailingOnceRecordStore extends InMemoryHitlStore {
  private failed = false;

  override async recordBatchToolResult(
    batchId: string,
    result: HitlBatchToolResult,
  ): Promise<HitlBatchRecord> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("record store write failed");
    }
    return super.recordBatchToolResult(batchId, result);
  }
}

class FailingOnceCompleteRequestStore extends InMemoryHitlStore {
  private failed = false;

  override async completeRequestWithToolResult(
    input: Parameters<HitlStore["completeRequestWithToolResult"]>[0],
  ): ReturnType<HitlStore["completeRequestWithToolResult"]> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("complete request with tool result store write failed");
    }
    return super.completeRequestWithToolResult(input);
  }
}

class FailingOnceLegacyCompleteStore extends InMemoryHitlStore {
  private failed = false;

  override async completeRequest(
    requestId: string,
    completion: HitlCompletion,
    guard: HitlLeaseGuard,
  ): Promise<HitlRequestRecord> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("legacy complete request store write failed");
    }
    return super.completeRequest(requestId, completion, guard);
  }
}

class FailingOnceCompleteBatchStore extends InMemoryHitlStore {
  private failed = false;

  override async completeBatch(
    batchId: string,
    completion: HitlBatchCompletion,
    guard: HitlLeaseGuard,
  ): Promise<HitlBatchRecord> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("complete batch store write failed");
    }
    return super.completeBatch(batchId, completion, guard);
  }
}

class FailingOnceDispatchEnqueueStore extends InMemoryHitlStore {
  private failed = false;

  override async enqueueSteer(batchId: string, input: HitlQueuedSteerInput): Promise<HitlQueuedSteer> {
    if (!this.failed && input.source === "direct") {
      this.failed = true;
      throw new Error("dispatch steer enqueue failed");
    }
    return super.enqueueSteer(batchId, input);
  }
}

class BlockingDispatchEnqueueStore extends InMemoryHitlStore {
  readonly dispatchStarted = deferred<void>();
  readonly allowDispatch = deferred<void>();
  private blocked = false;

  override async enqueueSteer(batchId: string, input: HitlQueuedSteerInput): Promise<HitlQueuedSteer> {
    if (!this.blocked && input.source === "direct") {
      this.blocked = true;
      this.dispatchStarted.resolve();
      await this.allowDispatch.promise;
    }
    return super.enqueueSteer(batchId, input);
  }
}

// We need to mock createLlmClient so we don't need real API clients
vi.mock("../models/index.js", () => ({
  createLlmClient: vi.fn(() => mockLlmClient()),
}));

describe("createHarness", () => {
  beforeEach(async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockReset();
    vi.mocked(createLlmClient).mockImplementation(() => mockLlmClient());
  });

  // -----------------------------------------------------------------------
  // Test 1: createHarness with minimal config → returns HarnessRuntime
  // -----------------------------------------------------------------------
  it("returns a HarnessRuntime with all required surfaces", async () => {
    const runtime = await createHarness(minimalConfig());

    // Verify runtime has all required API surfaces
    const result = await runtime.processTurn("default", "verify surfaces");
    expect(result.status).toBe("completed");

    // Ingress pipeline is functional
    expect(runtime.ingress).toBeDefined();
    expect(typeof runtime.ingress.receive).toBe("function");

    // Runtime events surface is functional
    expect(runtime.events).toBeDefined();
    expect(typeof runtime.events.on).toBe("function");

    // Control surface is functional
    expect(runtime.control).toBeDefined();
    expect(typeof runtime.control.abortConversation).toBe("function");
    expect(typeof runtime.control.listPendingHitl).toBe("function");

    await runtime.close();
  });

  it("rejects HITL config without a store at runtime boundaries", async () => {
    const config = minimalConfig({
      hitl: {} as HarnessConfig["hitl"],
    });

    await expect(createHarness(config)).rejects.toThrow("hitl.store is required");
  });

  it("HITL required tool waits, survives runtime recreation, and resumes after approval", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-hitl-1", toolName: "dangerous_tool", args: { value: "original" } },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "approved result observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved result" }));
    const tool: ToolDefinition = {
      name: "dangerous_tool",
      description: "Requires approval",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler,
    };
    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    };

    const runtime1 = await createHarness(config);
    const result = await runtime1.processTurn("default", "run the dangerous tool", {
      conversationId: "hitl-conv",
    });

    expect(result.status).toBe("waitingForHuman");
    const requestId = firstPendingHitlRequestId(result);
    expect(requestId).not.toContain("call-hitl-1");
    expect(handler).not.toHaveBeenCalled();
    const pending = await runtime1.control.listPendingHitl({ conversationId: "hitl-conv" });
    expect(pending.map((request) => request.requestId)).toEqual([requestId]);
    await runtime1.close();

    const runtime2 = await createHarness(config);
    const recovered = await runtime2.control.listPendingHitl({ conversationId: "hitl-conv" });
    expect(recovered.map((request) => request.requestId)).toEqual([requestId]);

    const submitted = await runtime2.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    expect(submitted.status === "accepted" ? submitted.resume.status : null).toBe("scheduled");
    await waitUntil(() => expect(handler).toHaveBeenCalledOnce());

    const resumed = await runtime2.control.resumeHitl(requestId);
    expect(["completed", "alreadyCompleted"]).toContain(resumed.status);
    expect(handler).toHaveBeenCalledOnce();

    const duplicate = await runtime2.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(duplicate.status).toBe("duplicate");
    expect(handler).toHaveBeenCalledOnce();

    await runtime2.close();
  });

  it("executes non-HITL peer tool calls while HITL calls remain pending in the same step", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-hitl-stop-1", toolName: "approval_gate_tool", args: {} },
          { toolCallId: "call-hitl-stop-2", toolName: "must_not_run_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const approvalHandler = vi.fn(async () => ({ type: "text" as const, text: "approved" }));
    const laterHandler = vi.fn(async () => ({ type: "text" as const, text: "must not run" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            {
              name: "approval_gate_tool",
              description: "Requires approval",
              parameters: { type: "object", additionalProperties: false },
              hitl: {
                mode: "required",
                response: { type: "approval" },
              },
              handler: approvalHandler,
            },
            {
              name: "must_not_run_tool",
              description: "Must not run after HITL pending",
              parameters: { type: "object", additionalProperties: false },
              handler: laterHandler,
            },
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "stop at HITL", {
      conversationId: "hitl-stop-conv",
    });

    expect(result.status).toBe("waitingForHuman");
    expect(result.pendingHitlRequestIds).toHaveLength(1);
    expect(result.steps[0]?.toolCalls).toEqual([
      {
        toolName: "approval_gate_tool",
        args: {},
        result: undefined,
      },
      {
        toolName: "must_not_run_tool",
        args: {},
        result: {
          type: "text",
          text: "must not run",
        },
      },
    ]);
    expect(approvalHandler).not.toHaveBeenCalled();
    expect(laterHandler).toHaveBeenCalledOnce();

    await runtime.close();
  });

  it("waits for every HITL peer in a mixed step before resuming the batch", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-peer-1", toolName: "approval_peer_a", args: { value: "a" } },
          { toolCallId: "call-peer-2", toolName: "normal_peer_tool", args: {} },
          { toolCallId: "call-peer-3", toolName: "approval_peer_b", args: { value: "b" } },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "all peers done",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const approvalA = vi.fn(async () => ({ type: "text" as const, text: "approved-a" }));
    const approvalB = vi.fn(async () => ({ type: "text" as const, text: "approved-b" }));
    const normal = vi.fn(async () => ({ type: "text" as const, text: "normal-done" }));
    const approvalTool = (name: string, handler: ToolDefinition["handler"]): ToolDefinition => ({
      name,
      description: "Requires peer approval",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      hitl: { mode: "required", response: { type: "approval" } },
      handler,
    });

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            approvalTool("approval_peer_a", approvalA),
            {
              name: "normal_peer_tool",
              description: "Runs immediately inside the mixed HITL batch",
              parameters: { type: "object", additionalProperties: false },
              handler: normal,
            },
            approvalTool("approval_peer_b", approvalB),
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "run mixed peers", {
      conversationId: "hitl-mixed-peer-conv",
    });

    expect(result.status).toBe("waitingForHuman");
    expect(result.pendingHitlBatchId).toBeDefined();
    expect(result.pendingHitlRequestIds).toHaveLength(2);
    expect(normal).toHaveBeenCalledOnce();
    expect(approvalA).not.toHaveBeenCalled();
    expect(approvalB).not.toHaveBeenCalled();

    const [firstRequestId, secondRequestId] = result.pendingHitlRequestIds!;
    const first = await runtime.control.submitHitlResult({
      requestId: firstRequestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(first.status).toBe("accepted");
    expect(first.status === "accepted" ? first.resume.status : null).toBe("waitingForPeers");
    expect(approvalA).not.toHaveBeenCalled();
    expect(approvalB).not.toHaveBeenCalled();

    const second = await runtime.control.submitHitlResult({
      requestId: secondRequestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(second.status).toBe("accepted");
    expect(second.status === "accepted" ? second.resume.status : null).toBe("scheduled");

    await waitUntil(() => {
      expect(approvalA).toHaveBeenCalledOnce();
      expect(approvalB).toHaveBeenCalledOnce();
    });
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("completed");
      expect(batch?.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
        "approval_peer_a",
        "normal_peer_tool",
        "approval_peer_b",
      ]);
    });

    await runtime.close();
  });

  it("queues ingress steer while HITL is pending and drains it on resume", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-queued-steer-1", toolName: "queued_steer_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "queued steer observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const connector: Connector = {
      name: "hitl-queue-connector",
      normalize: vi.fn(async (ctx) => {
        return {
          name: "message",
          content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
          properties: {},
          conversationId: "hitl-queue-conv",
          source: {
            connector: "hitl-queue-connector",
            connectionName: ctx.connectionName,
            receivedAt: ctx.receivedAt,
          },
        } satisfies InboundEnvelope;
      }),
    };
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved queued steer tool" }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "queued_steer_tool",
            description: "Requires approval before queued steer drains",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      connections: {
        "hitl-queue": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start pending HITL", {
      conversationId: "hitl-queue-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const queued = await runtime.ingress.receive({
      connectionName: "hitl-queue",
      payload: { text: "queued while pending" },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].disposition).toBe("queuedForHitl");
    expect(queued[0].batchId).toBe(result.pendingHitlBatchId);
    expect(queued[0].pendingRequestIds).toEqual(result.pendingHitlRequestIds);

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");

    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("queued while pending");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("completed");
      expect(batch?.queuedSteerCount).toBe(0);
    });

    await runtime.close();
  });

  it("moves active-turn steered input into the HITL queue when the same step stops for HITL", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const firstChatStarted = deferred<void>();
    const releaseFirstChat = deferred<LlmResponse>();
    const chat = vi.fn()
      .mockImplementationOnce(async () => {
        firstChatStarted.resolve();
        return releaseFirstChat.promise;
      })
      .mockResolvedValue({
        text: "mid-step steer observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const connector: Connector = {
      name: "same-step-steer-connector",
      normalize: vi.fn(async (ctx) => ({
        name: "message",
        content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
        properties: {},
        conversationId: "same-step-steer-conv",
        source: {
          connector: "same-step-steer-connector",
          connectionName: ctx.connectionName,
          receivedAt: ctx.receivedAt,
        },
      } satisfies InboundEnvelope)),
    };
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved same-step tool" }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "same_step_hitl_tool",
            description: "Requires approval after same-step steering",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      connections: {
        "same-step-steer": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const turnPromise = runtime.processTurn("default", "start same-step HITL", {
      conversationId: "same-step-steer-conv",
    });
    await firstChatStarted.promise;

    const steered = await runtime.ingress.receive({
      connectionName: "same-step-steer",
      payload: { text: "steered before HITL return" },
    });
    expect(steered).toHaveLength(1);
    expect(steered[0].disposition).toBe("steered");

    releaseFirstChat.resolve({
      toolCalls: [
        { toolCallId: "call-same-step-steer-1", toolName: "same_step_hitl_tool", args: {} },
      ],
      finishReason: "tool-calls",
    } satisfies LlmResponse);

    const result = await turnPromise;
    expect(result.status).toBe("waitingForHuman");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.queuedSteerCount).toBe(1);
    });

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");

    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("steered before HITL return");

    await runtime.close();
  });

  it("rejects ingress while a HITL batch is still preparing", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const firstChatStarted = deferred<void>();
    const releaseFirstChat = deferred<LlmResponse>();
    const chat = vi.fn()
      .mockImplementationOnce(async () => {
        firstChatStarted.resolve();
        return releaseFirstChat.promise;
      })
      .mockResolvedValue({
        text: "preparing rejection observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const normalStarted = deferred<void>();
    const releaseNormal = deferred<ToolResult>();
    const connector: Connector = {
      name: "preparing-steer-connector",
      normalize: vi.fn(async (ctx) => ({
        name: "message",
        content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
        properties: {},
        conversationId: "preparing-steer-conv",
        source: {
          connector: "preparing-steer-connector",
          connectionName: ctx.connectionName,
          receivedAt: ctx.receivedAt,
        },
      } satisfies InboundEnvelope)),
    };
    const normal = vi.fn(async () => {
      normalStarted.resolve();
      return releaseNormal.promise;
    });
    const hitl = vi.fn(async () => ({ type: "text" as const, text: "approved preparing steer tool" }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            {
              name: "preparing_normal_tool",
              description: "Normal peer that delays preparation",
              parameters: { type: "object", additionalProperties: false },
              handler: normal,
            },
            {
              name: "preparing_hitl_tool",
              description: "Requires approval after preparation",
              parameters: { type: "object", additionalProperties: false },
              hitl: { mode: "required", response: { type: "approval" } },
              handler: hitl,
            },
          ],
        },
      },
      connections: {
        "preparing-steer": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const turnPromise = runtime.processTurn("default", "start preparing steer HITL", {
      conversationId: "preparing-steer-conv",
    });
    await firstChatStarted.promise;
    releaseFirstChat.resolve({
      toolCalls: [
        { toolCallId: "call-preparing-normal", toolName: "preparing_normal_tool", args: {} },
        { toolCallId: "call-preparing-hitl", toolName: "preparing_hitl_tool", args: {} },
      ],
      finishReason: "tool-calls",
    } satisfies LlmResponse);
    await normalStarted.promise;

    const rejected = await runtime.ingress.receive({
      connectionName: "preparing-steer",
      payload: { text: "steered while preparing" },
    });
    expect(rejected).toHaveLength(0);

    releaseNormal.resolve({ type: "text", text: "normal done" });
    const result = await turnPromise;
    expect(result.status).toBe("waitingForHuman");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.queuedSteerCount).toBe(0);
    });

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).not.toContain("steered while preparing");

    await runtime.close();
  });

  it("rejects direct processTurn input while a HITL batch is still preparing", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const releaseFirstChat = deferred<LlmResponse>();
    const chat = vi.fn()
      .mockImplementationOnce(async () => releaseFirstChat.promise)
      .mockResolvedValue({
        text: "direct preparing rejection observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const normalStarted = deferred<void>();
    const releaseNormal = deferred<ToolResult>();
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            {
              name: "direct_preparing_normal_tool",
              description: "Normal peer that delays preparation",
              parameters: { type: "object", additionalProperties: false },
              handler: vi.fn(async () => {
                normalStarted.resolve();
                return releaseNormal.promise;
              }),
            },
            {
              name: "direct_preparing_hitl_tool",
              description: "Requires approval after preparation",
              parameters: { type: "object", additionalProperties: false },
              hitl: { mode: "required", response: { type: "approval" } },
              handler: vi.fn(async () => ({ type: "text" as const, text: "approved direct preparing tool" })),
            },
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const turnPromise = runtime.processTurn("default", "start direct preparing HITL", {
      conversationId: "direct-preparing-steer-conv",
    });
    releaseFirstChat.resolve({
      toolCalls: [
        { toolCallId: "call-direct-preparing-normal", toolName: "direct_preparing_normal_tool", args: {} },
        { toolCallId: "call-direct-preparing-hitl", toolName: "direct_preparing_hitl_tool", args: {} },
      ],
      finishReason: "tool-calls",
    } satisfies LlmResponse);
    await normalStarted.promise;

    const second = await runtime.processTurn("default", "direct while preparing", {
      conversationId: "direct-preparing-steer-conv",
    });
    releaseNormal.resolve({ type: "text", text: "normal done" });

    const result = await turnPromise;
    expect(result.status).toBe("waitingForHuman");
    expect(second.status).toBe("error");
    expect(second.error?.message).toContain("active HITL barrier");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.queuedSteerCount).toBe(0);
    });

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).not.toContain("direct while preparing");

    await runtime.close();
  });

  it("retries dispatch steer persistence before settling a preparing turn for HITL", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const firstChatStarted = deferred<void>();
    const releaseFirstChat = deferred<LlmResponse>();
    const chat = vi.fn()
      .mockImplementationOnce(async () => {
        firstChatStarted.resolve();
        return releaseFirstChat.promise;
      })
      .mockResolvedValue({
        text: "retry dispatch steer observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceDispatchEnqueueStore();
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "retry_dispatch_hitl_tool",
            description: "Requires approval after dispatch steer retry",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler: vi.fn(async () => ({ type: "text" as const, text: "approved retry dispatch tool" })),
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const turnPromise = runtime.processTurn("default", "start retry dispatch HITL", {
      conversationId: "retry-dispatch-steer-conv",
    });
    await firstChatStarted.promise;
    const steered = runtime.processTurn("default", "dispatch steer survives transient write failure", {
      conversationId: "retry-dispatch-steer-conv",
    });
    releaseFirstChat.resolve({
      toolCalls: [
        { toolCallId: "call-retry-dispatch-hitl", toolName: "retry_dispatch_hitl_tool", args: {} },
      ],
      finishReason: "tool-calls",
    } satisfies LlmResponse);

    const result = await turnPromise;
    expect((await steered).status).toBe("waitingForHuman");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.queuedSteerCount).toBe(1);
    });

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("dispatch steer survives transient write failure");

    await runtime.close();
  });

  it("queues new direct input durably after HITL handoff closes active steering", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const firstChatStarted = deferred<void>();
    const releaseFirstChat = deferred<LlmResponse>();
    const chat = vi.fn()
      .mockImplementationOnce(async () => {
        firstChatStarted.resolve();
        return releaseFirstChat.promise;
      })
      .mockResolvedValue({
        text: "handoff steer observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new BlockingDispatchEnqueueStore();
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "handoff_hitl_tool",
            description: "Requires approval during handoff",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler: vi.fn(async () => ({ type: "text" as const, text: "approved handoff tool" })),
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const turnPromise = runtime.processTurn("default", "start handoff HITL", {
      conversationId: "handoff-steer-conv",
    });
    await firstChatStarted.promise;
    const beforeHandoff = runtime.processTurn("default", "direct before handoff", {
      conversationId: "handoff-steer-conv",
    });
    releaseFirstChat.resolve({
      toolCalls: [
        { toolCallId: "call-handoff-hitl", toolName: "handoff_hitl_tool", args: {} },
      ],
      finishReason: "tool-calls",
    } satisfies LlmResponse);

    await store.dispatchStarted.promise;
    const duringHandoff = await runtime.processTurn("default", "direct during handoff", {
      conversationId: "handoff-steer-conv",
    });
    expect(duringHandoff.status).toBe("waitingForHuman");

    store.allowDispatch.resolve();
    const result = await turnPromise;
    expect((await beforeHandoff).status).toBe("waitingForHuman");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.queuedSteerCount).toBe(2);
    });

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    const continuation = JSON.stringify(chat.mock.calls[1]?.[0]);
    expect(continuation).toContain("direct before handoff");
    expect(continuation).toContain("direct during handoff");

    await runtime.close();
  });

  it("fails a preparation batch when peer result recording fails after peer execution started", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-prep-normal", toolName: "prep_normal_tool", args: {} },
          { toolCallId: "call-prep-hitl", toolName: "prep_hitl_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "not blocked by failed preparing batch",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceRecordStore();
    const normal = vi.fn(async () => ({ type: "text" as const, text: "normal peer result" }));
    const hitl = vi.fn(async () => ({ type: "text" as const, text: "hitl result" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            {
              name: "prep_normal_tool",
              description: "Normal peer",
              parameters: { type: "object", additionalProperties: false },
              handler: normal,
            },
            {
              name: "prep_hitl_tool",
              description: "Requires approval",
              parameters: { type: "object", additionalProperties: false },
              hitl: { mode: "required", response: { type: "approval" } },
              handler: hitl,
            },
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const failed = await runtime.processTurn("default", "start preparation failure", {
      conversationId: "prep-failure-conv",
    });
    expect(failed.status).toBe("error");
    expect(normal).toHaveBeenCalledOnce();
    expect(hitl).not.toHaveBeenCalled();
    expect(await runtime.control.listPendingHitl({ conversationId: "prep-failure-conv" })).toHaveLength(0);
    expect(await store.getOpenBatchByConversation("default", "prep-failure-conv")).toBeNull();

    const next = await runtime.processTurn("default", "should not be blocked", {
      conversationId: "prep-failure-conv",
    });
    expect(next.status).toBe("completed");
    expect(next.text).toBe("not blocked by failed preparing batch");

    await runtime.close();
  });

  it("does not start a direct processTurn when a HITL barrier is pending", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-direct-barrier-1", toolName: "direct_barrier_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValueOnce({
        text: "approved with queued input",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "direct_barrier_tool",
            description: "Requires approval before direct barrier",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const first = await runtime.processTurn("default", "start direct barrier HITL", {
      conversationId: "direct-barrier-conv",
    });
    expect(first.status).toBe("waitingForHuman");

    const second = await runtime.processTurn("default", "must not append over barrier", {
      conversationId: "direct-barrier-conv",
    });
    expect(second.status).toBe("waitingForHuman");
    expect(second.pendingHitlBatchId).toBe(first.pendingHitlBatchId);
    expect(chat).toHaveBeenCalledOnce();
    const batchAfterSecondInput = await runtime.control.getHitlBatch(first.pendingHitlBatchId!);
    expect(batchAfterSecondInput?.queuedSteerCount).toBe(1);

    await runtime.control.submitHitlResult({
      requestId: firstPendingHitlRequestId(first),
      result: { kind: "approve" },
    });

    await waitUntil(() => {
      expect(handler).toHaveBeenCalledOnce();
      expect(chat).toHaveBeenCalledTimes(2);
    });
    const continuationMessages = chat.mock.calls[1]?.[0] as Message[] | undefined;
    const queuedMessage = continuationMessages?.find((message) =>
      message.data.role === "user" && message.data.content === "must not append over barrier",
    );
    expect(queuedMessage).toBeDefined();
    expect(queuedMessage?.metadata?.["__eventName"]).toBe("text");

    await runtime.close();
  });

  it("steers ingress into an active HITL continuation instead of queueing it to the completed append batch", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const continuationResponse = deferred<LlmResponse>();
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-active-continuation-1", toolName: "active_continuation_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockImplementationOnce(() => continuationResponse.promise)
      .mockResolvedValue({
        text: "steered continuation observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const connector: Connector = {
      name: "active-continuation-connector",
      normalize: vi.fn(async (ctx) => ({
        name: "message",
        content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
        properties: {},
        conversationId: "active-continuation-conv",
        source: {
          connector: "active-continuation-connector",
          connectionName: ctx.connectionName,
          receivedAt: ctx.receivedAt,
        },
      } satisfies InboundEnvelope)),
    };
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved active continuation tool" }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "active_continuation_tool",
            description: "Requires approval before active continuation",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      connections: {
        "active-continuation": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start active continuation HITL", {
      conversationId: "active-continuation-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));

    const steered = await runtime.ingress.receive({
      connectionName: "active-continuation",
      payload: { text: "steer during active continuation" },
    });
    expect(steered).toHaveLength(1);
    expect(steered[0].disposition).toBe("steered");

    continuationResponse.resolve({
      text: "continue after steering",
      toolCalls: [],
      finishReason: "stop",
    });

    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(chat.mock.calls[2]?.[0])).toContain("steer during active continuation");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("completed");
      expect(batch?.queuedSteerCount).toBe(0);
    });

    await runtime.close();
  });

  it("queues ingress during approved HITL handler execution before the drain cutoff", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-handler-window-1", toolName: "handler_window_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "handler window steer observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const handlerStarted = deferred<void>();
    const handlerResult = deferred<ToolResult>();
    const connector: Connector = {
      name: "handler-window-connector",
      normalize: vi.fn(async (ctx) => ({
        name: "message",
        content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
        properties: {},
        conversationId: "handler-window-conv",
        source: {
          connector: "handler-window-connector",
          connectionName: ctx.connectionName,
          receivedAt: ctx.receivedAt,
        },
      } satisfies InboundEnvelope)),
    };
    const handler = vi.fn(async () => {
      handlerStarted.resolve();
      return handlerResult.promise;
    });

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "handler_window_tool",
            description: "Requires approval before handler window",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      connections: {
        "handler-window": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start handler window HITL", {
      conversationId: "handler-window-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await handlerStarted.promise;

    const queued = await runtime.ingress.receive({
      connectionName: "handler-window",
      payload: { text: "queue while handler is running" },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].disposition).toBe("queuedForHitl");

    handlerResult.resolve({ type: "text", text: "handler done" });
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("queue while handler is running");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("completed");
      expect(batch?.queuedSteerCount).toBe(0);
    });

    await runtime.close();
  });

  it("rejects ingress that arrives after queued steer drain but before append commit", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-drain-cutoff-1", toolName: "drain_cutoff_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "drain cutoff steer observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new DelayedCommitStore();
    const connector: Connector = {
      name: "drain-cutoff-connector",
      normalize: vi.fn(async (ctx) => ({
        name: "message",
        content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
        properties: {},
        conversationId: "drain-cutoff-conv",
        source: {
          connector: "drain-cutoff-connector",
          connectionName: ctx.connectionName,
          receivedAt: ctx.receivedAt,
        },
      } satisfies InboundEnvelope)),
    };
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved drain cutoff tool" }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "drain_cutoff_tool",
            description: "Requires approval before drain cutoff",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      connections: {
        "drain-cutoff": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start drain cutoff HITL", {
      conversationId: "drain-cutoff-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await store.commitStarted.promise;

    const rejected = await runtime.ingress.receive({
      connectionName: "drain-cutoff",
      payload: { text: "steer after drain before commit" },
    });
    expect(rejected).toHaveLength(0);
    expect(chat).toHaveBeenCalledTimes(1);

    store.allowCommit.resolve();
    await waitUntil(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).not.toContain("steer after drain before commit");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("completed");
      expect(batch?.queuedSteerCount).toBe(0);
    });

    const steeredAfterCommit = await runtime.ingress.receive({
      connectionName: "drain-cutoff",
      payload: { text: "steer after commit" },
    });
    expect(steeredAfterCommit).toHaveLength(1);
    expect(steeredAfterCommit[0].disposition).toBe("started");

    await runtime.close();
  });

  it("keeps append commit failures retryable so accepted queued steer is recovered", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-commit-retry-1", toolName: "commit_retry_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "commit retry observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceCommitStore();
    const connector: Connector = {
      name: "commit-retry-connector",
      normalize: vi.fn(async (ctx) => ({
        name: "message",
        content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
        properties: {},
        conversationId: "commit-retry-conv",
        source: {
          connector: "commit-retry-connector",
          connectionName: ctx.connectionName,
          receivedAt: ctx.receivedAt,
        },
      } satisfies InboundEnvelope)),
    };
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved commit retry tool" }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "commit_retry_tool",
            description: "Requires approval before commit retry",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      connections: {
        "commit-retry": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start commit retry HITL", {
      conversationId: "commit-retry-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const queued = await runtime.ingress.receive({
      connectionName: "commit-retry",
      payload: { text: "queued before commit failure" },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].disposition).toBe("queuedForHitl");

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("failed");
      expect(batch?.failure?.retryable).toBe(true);
    });
    expect(chat).toHaveBeenCalledTimes(1);

    const resumed = await runtime.control.resumeHitlBatch(result.pendingHitlBatchId!);
    expect(resumed.status).toBe("completed");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain("queued before commit failure");

    await runtime.close();
  });

  it("does not leave partial HITL completion state when atomic result completion fails", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-complete-retry-1", toolName: "complete_retry_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "completion retry observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceCompleteRequestStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved complete retry tool" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "complete_retry_tool",
            description: "Requires approval before completion retry",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start complete retry HITL", {
      conversationId: "complete-retry-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("blocked");
      expect(batch?.failure?.retryable).toBe(false);
      expect(batch?.toolResults).toHaveLength(0);
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledTimes(1);

    const resumed = await runtime.control.resumeHitlBatch(result.pendingHitlBatchId!);
    expect(resumed.status).toBe("blocked");
    expect(handler).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledTimes(1);
    await waitUntil(async () => {
      const request = await runtime.control.getHitlRequest(result.pendingHitlRequestIds![0]!);
      expect(request?.status).toBe("failed");
    });

    await runtime.close();
  });

  it("keeps legacy stored-result completion failures retryable", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-legacy-complete-retry-1", toolName: "legacy_complete_retry_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "legacy completion retry observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceLegacyCompleteStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved legacy complete retry tool" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "legacy_complete_retry_tool",
            description: "Requires approval before legacy completion retry",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start legacy complete retry HITL", {
      conversationId: "legacy-complete-retry-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const batchId = result.pendingHitlBatchId!;
    const requestId = result.pendingHitlRequestIds![0]!;
    await store.resolveRequest(requestId, { decision: "approve", submittedAt: new Date().toISOString() });
    const lease = await store.acquireBatchLease(batchId, "legacy-partial-owner", 1000);
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") throw new Error("expected lease");
    await store.startRequestExecution(requestId, lease.guard, new Date().toISOString());
    await store.recordBatchToolResult(batchId, {
      batchId,
      toolCallId: "call-legacy-complete-retry-1",
      toolCallIndex: 0,
      toolName: "legacy_complete_retry_tool",
      result: { type: "text", text: "stored legacy result" },
      finalArgs: {},
      recordedAt: new Date().toISOString(),
    });
    await store.releaseBatchLease(batchId, lease.guard);

    const firstResume = await runtime.control.resumeHitlBatch(batchId);
    expect(firstResume.status).toBe("failed");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(batchId);
      expect(batch?.status).toBe("failed");
      expect(batch?.failure?.retryable).toBe(true);
    });
    expect(handler).not.toHaveBeenCalled();

    const secondResume = await runtime.control.resumeHitlBatch(batchId);
    expect(secondResume.status).toBe("completed");
    expect(handler).not.toHaveBeenCalled();
    await waitUntil(async () => {
      const request = await runtime.control.getHitlRequest(requestId);
      expect(request?.status).toBe("completed");
    });

    await runtime.close();
  });

  it("keeps rejected HITL completion persistence failures retryable because no handler side effect started", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-reject-complete-retry-1", toolName: "reject_complete_retry_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "reject retry observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceCompleteRequestStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "should not run" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "reject_complete_retry_tool",
            description: "Rejected before handler execution",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start reject retry HITL", {
      conversationId: "reject-complete-retry-conv",
    });
    expect(result.status).toBe("waitingForHuman");

    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "reject", reason: "no", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("failed");
      expect(batch?.failure?.retryable).toBe(true);
    });
    expect(handler).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);

    const resumed = await runtime.control.resumeHitlBatch(result.pendingHitlBatchId!);
    expect(resumed.status).toBe("completed");
    expect(handler).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(2);

    await runtime.close();
  });

  it("does not complete a batch when the HITL continuation returns an error", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-continuation-error-1", toolName: "continuation_error_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockRejectedValueOnce(new Error("continuation exploded"));
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved before continuation error" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "continuation_error_tool",
            description: "Requires approval before a failing continuation",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start continuation error HITL", {
      conversationId: "continuation-error-conv",
    });
    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");

    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("failed");
      expect(batch?.failure?.retryable).toBe(false);
      expect(batch?.completion).toBeUndefined();
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledTimes(2);

    const retried = await runtime.control.resumeHitlBatch(result.pendingHitlBatchId!);
    expect(retried.status).toBe("alreadyTerminal");
    expect(chat).toHaveBeenCalledTimes(2);

    await runtime.close();
  });

  it("does not rerun a continuation when completeBatch persistence fails after the continuation settles", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-complete-batch-fail-1", toolName: "complete_batch_fail_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValue({
        text: "continuation finished before complete batch failure",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new FailingOnceCompleteBatchStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "approved before complete batch failure" }));
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [{
            name: "complete_batch_fail_tool",
            description: "Requires approval before completeBatch failure",
            parameters: { type: "object", additionalProperties: false },
            hitl: { mode: "required", response: { type: "approval" } },
            handler,
          }],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "start complete batch failure HITL", {
      conversationId: "complete-batch-failure-conv",
    });
    const submitted = await runtime.control.submitHitlResult({
      requestId: result.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");

    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("continuing");
      expect(batch?.continuationOutcome?.outcome).toBe("completed");
      expect(batch?.completion).toBeUndefined();
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(chat).toHaveBeenCalledTimes(2);

    await waitUntil(async () => {
      const retried = await runtime.control.resumeHitlBatch(result.pendingHitlBatchId!);
      expect(["completed", "alreadyCompleted"]).toContain(retried.status);
      expect(handler).toHaveBeenCalledOnce();
      expect(chat).toHaveBeenCalledTimes(2);
      const batch = await runtime.control.getHitlBatch(result.pendingHitlBatchId!);
      expect(batch?.status).toBe("completed");
      expect(batch?.completion?.outcome).toBe("completed");
    });

    await runtime.close();
  });

  it("allows a HITL continuation to settle on a new pending HITL batch", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn()
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-first-stage-hitl", toolName: "first_stage_hitl_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse)
      .mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-second-stage-hitl", toolName: "second_stage_hitl_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const markBatchWaitingForHuman = store.markBatchWaitingForHuman.bind(store);
    vi.spyOn(store, "markBatchWaitingForHuman").mockImplementation(async (batchId) => {
      const batch = await store.getBatch(batchId);
      if (batch?.parentBatchId) {
        throw new Error("spawned child HITL batch should already be exposed atomically");
      }
      return markBatchWaitingForHuman(batchId);
    });
    const firstHandler = vi.fn(async () => ({ type: "text" as const, text: "first stage approved" }));
    const secondHandler = vi.fn(async () => ({ type: "text" as const, text: "second stage approved" }));
    const hitlTool = (name: string, handler: ToolDefinition["handler"]): ToolDefinition => ({
      name,
      description: "Requires staged approval",
      parameters: { type: "object", additionalProperties: false },
      hitl: { mode: "required", response: { type: "approval" } },
      handler,
    });

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            hitlTool("first_stage_hitl_tool", firstHandler),
            hitlTool("second_stage_hitl_tool", secondHandler),
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const first = await runtime.processTurn("default", "start staged HITL", {
      conversationId: "staged-hitl-conv",
    });
    expect(first.status).toBe("waitingForHuman");

    const submitted = await runtime.control.submitHitlResult({
      requestId: first.pendingHitlRequestIds![0]!,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");

    await waitUntil(async () => {
      const firstBatch = await runtime.control.getHitlBatch(first.pendingHitlBatchId!);
      expect(firstBatch?.status).toBe("completed");
      expect(firstBatch?.completion?.outcome).toBe("spawnedChild");
      const pending = await runtime.control.listPendingHitl({ conversationId: "staged-hitl-conv" });
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe("second_stage_hitl_tool");
      expect(pending[0].batchId).not.toBe(first.pendingHitlBatchId);
    });
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("startup recovery exposes a fully prepared HITL-only preparing batch", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn().mockResolvedValue({
      text: "should not start over recovered HITL",
      toolCalls: [],
      finishReason: "stop",
    } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();
    await store.createBatch({
      batch: {
        batchId: "preparing-recovery-batch",
        status: "preparing",
        agentName: "default",
        conversationId: "preparing-recovery-conv",
        turnId: "turn-preparing-recovery",
        stepNumber: 1,
        toolCalls: [{
          toolCallId: "call-preparing-recovery",
          toolCallIndex: 0,
          toolName: "preparing_recovery_tool",
          toolArgs: {},
          requiresHitl: true,
          requestId: "preparing-recovery-request",
        }],
        toolResults: [],
        toolExecutions: [],
        conversationEvents: [],
        createdAt: now,
        updatedAt: now,
      },
      requests: [{
        requestId: "preparing-recovery-request",
        batchId: "preparing-recovery-batch",
        status: "pending",
        agentName: "default",
        conversationId: "preparing-recovery-conv",
        turnId: "turn-preparing-recovery",
        stepNumber: 1,
        toolCallId: "call-preparing-recovery",
        toolCallIndex: 0,
        toolName: "preparing_recovery_tool",
        originalArgs: {},
        responseSchema: { type: "approval" },
        createdAt: now,
        updatedAt: now,
      }],
    });

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      hitl: { store, resumeOnStartup: true },
    });

    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch("preparing-recovery-batch");
      expect(batch?.status).toBe("waitingForHuman");
      expect(batch?.requests).toHaveLength(1);
    });
    const pending = await runtime.control.listPendingHitl({ conversationId: "preparing-recovery-conv" });
    expect(pending.map((request) => request.requestId)).toEqual(["preparing-recovery-request"]);
    expect(chat).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("startup recovery exposes preparing batches when all non-HITL peer results were recorded", async () => {
    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();
    await store.createBatch({
      batch: {
        batchId: "preparing-recorded-peer-batch",
        status: "preparing",
        agentName: "default",
        conversationId: "preparing-recorded-peer-conv",
        turnId: "turn-preparing-recorded-peer",
        stepNumber: 1,
        toolCalls: [
          {
            toolCallId: "call-preparing-recorded-normal",
            toolCallIndex: 0,
            toolName: "preparing_recorded_normal_tool",
            toolArgs: {},
            requiresHitl: false,
          },
          {
            toolCallId: "call-preparing-recorded-hitl",
            toolCallIndex: 1,
            toolName: "preparing_recorded_hitl_tool",
            toolArgs: {},
            requiresHitl: true,
            requestId: "preparing-recorded-peer-request",
          },
        ],
        toolResults: [],
        toolExecutions: [],
        conversationEvents: [],
        createdAt: now,
        updatedAt: now,
      },
      requests: [{
        requestId: "preparing-recorded-peer-request",
        batchId: "preparing-recorded-peer-batch",
        status: "pending",
        agentName: "default",
        conversationId: "preparing-recorded-peer-conv",
        turnId: "turn-preparing-recorded-peer",
        stepNumber: 1,
        toolCallId: "call-preparing-recorded-hitl",
        toolCallIndex: 1,
        toolName: "preparing_recorded_hitl_tool",
        originalArgs: {},
        responseSchema: { type: "approval" },
        createdAt: now,
        updatedAt: now,
      }],
    });
    await store.recordBatchToolResult("preparing-recorded-peer-batch", {
      batchId: "preparing-recorded-peer-batch",
      toolCallId: "call-preparing-recorded-normal",
      toolCallIndex: 0,
      toolName: "preparing_recorded_normal_tool",
      result: { type: "text", text: "normal result already durable" },
      recordedAt: now,
    });

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      hitl: { store, resumeOnStartup: true },
    });

    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch("preparing-recorded-peer-batch");
      expect(batch?.status).toBe("waitingForHuman");
      expect(batch?.toolResults).toHaveLength(1);
    });

    await runtime.close();
  });

  it("startup recovery fails preparing batches when peer execution started without a durable result", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn().mockResolvedValue({
      text: "not blocked by failed preparing marker",
      toolCalls: [],
      finishReason: "stop",
    } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();
    await store.createBatch({
      batch: {
        batchId: "preparing-marker-failed-batch",
        status: "preparing",
        agentName: "default",
        conversationId: "preparing-marker-failed-conv",
        turnId: "turn-preparing-marker-failed",
        stepNumber: 1,
        toolCalls: [
          {
            toolCallId: "call-preparing-marker-normal",
            toolCallIndex: 0,
            toolName: "preparing_marker_normal_tool",
            toolArgs: {},
            requiresHitl: false,
          },
          {
            toolCallId: "call-preparing-marker-hitl",
            toolCallIndex: 1,
            toolName: "preparing_marker_hitl_tool",
            toolArgs: {},
            requiresHitl: true,
            requestId: "preparing-marker-failed-request",
          },
        ],
        toolResults: [],
        toolExecutions: [],
        conversationEvents: [],
        createdAt: now,
        updatedAt: now,
      },
      requests: [{
        requestId: "preparing-marker-failed-request",
        batchId: "preparing-marker-failed-batch",
        status: "pending",
        agentName: "default",
        conversationId: "preparing-marker-failed-conv",
        turnId: "turn-preparing-marker-failed",
        stepNumber: 1,
        toolCallId: "call-preparing-marker-hitl",
        toolCallIndex: 1,
        toolName: "preparing_marker_hitl_tool",
        originalArgs: {},
        responseSchema: { type: "approval" },
        createdAt: now,
        updatedAt: now,
      }],
    });
    await store.startBatchToolExecution("preparing-marker-failed-batch", {
      batchId: "preparing-marker-failed-batch",
      phase: "pre-resume",
      toolCallId: "call-preparing-marker-normal",
      toolCallIndex: 0,
      toolName: "preparing_marker_normal_tool",
      startedAt: now,
    });

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      hitl: { store, resumeOnStartup: true },
    });

    await waitUntil(async () => {
      const batch = await runtime.control.getHitlBatch("preparing-marker-failed-batch");
      expect(batch?.status).toBe("failed");
      expect(batch?.failure?.retryable).toBe(false);
      expect(batch?.requests[0]?.status).toBe("failed");
    });
    expect(await runtime.control.listPendingHitl({ conversationId: "preparing-marker-failed-conv" })).toHaveLength(0);

    const next = await runtime.processTurn("default", "new turn after failed preparing marker", {
      conversationId: "preparing-marker-failed-conv",
    });
    expect(next.status).toBe("completed");
    expect(next.text).toBe("not blocked by failed preparing marker");

    await runtime.close();
  });

  it("startup recovery does not auto-rerun batches that already committed continuation append", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn().mockResolvedValue({
      text: "must not rerun committed continuation",
      toolCalls: [],
      finishReason: "stop",
    } satisfies LlmResponse);
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const store = new InMemoryHitlStore();
    const now = new Date().toISOString();
    await store.createBatch({
      batch: {
        batchId: "continuing-recovery-batch",
        status: "preparing",
        agentName: "default",
        conversationId: "continuing-recovery-conv",
        turnId: "turn-continuing-recovery",
        stepNumber: 1,
        toolCalls: [{
          toolCallId: "call-continuing-recovery",
          toolCallIndex: 0,
          toolName: "continuing_recovery_tool",
          toolArgs: {},
          requiresHitl: true,
          requestId: "continuing-recovery-request",
        }],
        toolResults: [],
        toolExecutions: [],
        conversationEvents: [],
        createdAt: now,
        updatedAt: now,
      },
      requests: [{
        requestId: "continuing-recovery-request",
        batchId: "continuing-recovery-batch",
        status: "pending",
        agentName: "default",
        conversationId: "continuing-recovery-conv",
        turnId: "turn-continuing-recovery",
        stepNumber: 1,
        toolCallId: "call-continuing-recovery",
        toolCallIndex: 0,
        toolName: "continuing_recovery_tool",
        originalArgs: {},
        responseSchema: { type: "approval" },
        createdAt: now,
        updatedAt: now,
      }],
    });
    await store.markBatchWaitingForHuman("continuing-recovery-batch");
    await store.rejectRequest("continuing-recovery-request", {
      decision: "reject",
      reason: "not approved",
      submittedAt: now,
    });
    const lease = await store.acquireBatchLease("continuing-recovery-batch", "previous-runtime", 1000);
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") throw new Error("expected lease");
    await store.completeRequestWithToolResult({
      batchId: "continuing-recovery-batch",
      requestId: "continuing-recovery-request",
      toolResult: {
        batchId: "continuing-recovery-batch",
        toolCallId: "call-continuing-recovery",
        toolCallIndex: 0,
        toolName: "continuing_recovery_tool",
        result: { type: "error", error: "not approved" },
        finalArgs: {},
        recordedAt: now,
      },
      completion: {
        toolResult: { type: "error", error: "not approved" },
        finalArgs: {},
        completedAt: now,
      },
      guard: lease.guard,
    });
    await store.commitBatchAppend("continuing-recovery-batch", {
      committedAt: now,
      toolResultEventIds: ["tool-result-continuing-recovery-batch-call-continuing-recovery"],
      queuedSteerEventIds: [],
      queuedSteerIds: [],
      continuationTurnId: "turn-continuing-recovery-continuation",
      conversationEvents: [],
    }, lease.guard);

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      hitl: { store, resumeOnStartup: true },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chat).not.toHaveBeenCalled();
    const batch = await runtime.control.getHitlBatch("continuing-recovery-batch");
    expect(batch?.status).toBe("continuing");

    const resumed = await runtime.control.resumeHitlBatch("continuing-recovery-batch");
    expect(resumed.status).toBe("notReady");
    expect(chat).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("startup recovery completes a durable rejected HITL request", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-rejected-recovery-1", toolName: "reject_recovery_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "rejection observed",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "should not run" }));
    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            {
              name: "reject_recovery_tool",
              description: "Rejected after restart",
              parameters: { type: "object", additionalProperties: false },
              hitl: {
                mode: "required",
                response: { type: "approval" },
              },
              handler,
            },
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    };

    const runtime1 = await createHarness(config);
    const result = await runtime1.processTurn("default", "create rejected recovery request", {
      conversationId: "rejected-recovery-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);
    await runtime1.close();

    await store.reject(requestId, {
      decision: "reject",
      reason: "not approved",
      submittedAt: new Date().toISOString(),
    });

    const runtime2 = await createHarness({
      ...config,
      hitl: { store, resumeOnStartup: true },
    });

    await waitUntil(async () => {
      const completed = await store.get(requestId);
      expect(completed?.status).toBe("completed");
      expect(completed?.completion?.toolResult).toEqual({
        type: "error",
        error: "not approved",
      });
    });
    expect(handler).not.toHaveBeenCalled();

    await runtime2.close();
  });

  it("startup recovery retries durable failed HITL requests marked retryable", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-retryable-recovery-1", toolName: "retryable_recovery_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "recovered",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const handler = vi.fn(async () => ({ type: "text" as const, text: "recovered" }));
    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [
            {
              name: "retryable_recovery_tool",
              description: "Retryable after restart",
              parameters: { type: "object", additionalProperties: false },
              hitl: {
                mode: "required",
                response: { type: "approval" },
              },
              handler,
            },
          ],
        },
      },
      hitl: { store, resumeOnStartup: false },
    };

    const runtime1 = await createHarness(config);
    const result = await runtime1.processTurn("default", "create retryable recovery request", {
      conversationId: "retryable-recovery-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);
    await runtime1.close();

    await store.resolve(requestId, {
      decision: "approve",
      submittedAt: new Date().toISOString(),
    });
    const lease = await store.acquireLease(requestId, "previous-runtime", 1000);
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) throw new Error("expected lease");
    await store.fail(requestId, {
      error: "temporary failure",
      retryable: true,
      failedAt: new Date().toISOString(),
    }, {
      ownerId: lease.request.lease!.ownerId,
      token: lease.request.lease!.token,
    });

    const runtime2 = await createHarness({
      ...config,
      hitl: { store, resumeOnStartup: true },
    });

    await waitUntil(async () => {
      const completed = await store.get(requestId);
      expect(completed?.status).toBe("completed");
      expect(completed?.completion?.toolResult).toEqual({
        type: "text",
        text: "recovered",
      });
    });
    expect(handler).toHaveBeenCalledOnce();

    await runtime2.close();
  });

  it("HITL form result replaces tool args before resumed handler execution", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-form-1", toolName: "form_tool", args: { value: "old" } },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "form handled",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const capturedArgs: unknown[] = [];
    const tool: ToolDefinition = {
      name: "form_tool",
      description: "Requires form input",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      hitl: {
        mode: "required",
        response: {
          type: "form",
          schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
      handler: vi.fn(async (args) => {
        capturedArgs.push(args);
        return { type: "text" as const, text: "form result" };
      }),
    };

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "run form tool", {
      conversationId: "form-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const invalid = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", value: { wrong: "shape" }, submittedAt: new Date().toISOString() },
    });
    expect(invalid.status).toBe("invalid");
    expect(tool.handler).not.toHaveBeenCalled();

    const submitted = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", value: { value: "new" }, submittedAt: new Date().toISOString() },
    });

    expect(submitted.status).toBe("accepted");
    expect(submitted.status === "accepted" ? submitted.resume.status : null).toBe("scheduled");
    await waitUntil(() => expect(tool.handler).toHaveBeenCalledOnce());
    expect(tool.handler).toHaveBeenCalledOnce();
    expect(capturedArgs[0]).toEqual({ value: "new" });

    const duplicateWithInvalidPayload = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", value: { wrong: "shape" }, submittedAt: new Date().toISOString() },
    });
    expect(duplicateWithInvalidPayload.status).toBe("duplicate");

    await runtime.close();
  });

  it("validates HITL approval result shape before resuming", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-approval-shape-1", toolName: "approval_shape_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "approval handled",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const tool: ToolDefinition = {
      name: "approval_shape_tool",
      description: "Requires approval only",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler: vi.fn(async () => ({ type: "text" as const, text: "approved" })),
    };
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "run approval tool", {
      conversationId: "approval-shape-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const invalid = await runtime.control.submitHitlResult({
      requestId,
      result: { kind: "text", value: "not an approval" },
    });
    expect(invalid.status).toBe("invalid");
    expect(tool.handler).not.toHaveBeenCalled();

    const accepted = await runtime.control.submitHitlResult({
      requestId,
      result: { kind: "approve" },
    });
    expect(accepted.status).toBe("accepted");
    await waitUntil(() => expect(tool.handler).toHaveBeenCalledOnce());

    await runtime.close();
  });

  it("validates HITL text length and passes submitted text as value by default", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-text-1", toolName: "text_tool", args: { prefix: "old", value: "old" } },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "text handled",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const capturedArgs: unknown[] = [];
    const tool: ToolDefinition = {
      name: "text_tool",
      description: "Requires text input",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string" },
          value: { type: "string" },
        },
        required: ["prefix", "value"],
        additionalProperties: false,
      },
      hitl: {
        mode: "required",
        response: { type: "text", minLength: 3, maxLength: 8 },
      },
      handler: vi.fn(async (args) => {
        capturedArgs.push(args);
        return { type: "text" as const, text: "text result" };
      }),
    };
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "run text tool", {
      conversationId: "text-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const tooShort = await runtime.control.submitHitlResult({
      requestId,
      result: { kind: "text", value: "no" },
    });
    expect(tooShort.status).toBe("invalid");

    const tooLong = await runtime.control.submitHitlResult({
      requestId,
      result: { kind: "text", value: "too-long-value" },
    });
    expect(tooLong.status).toBe("invalid");
    expect(tool.handler).not.toHaveBeenCalled();

    const accepted = await runtime.control.submitHitlResult({
      requestId,
      result: { kind: "text", value: "new" },
    });
    expect(accepted.status).toBe("accepted");
    await waitUntil(() => expect(tool.handler).toHaveBeenCalledOnce());
    expect(capturedArgs[0]).toEqual({ prefix: "old", value: "new" });

    await runtime.close();
  });

  it("keeps HITL blocked after external tool execution starts so recovery does not rerun the handler", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValueOnce({
        toolCalls: [
          { toolCallId: "call-blocked-1", toolName: "blocked_tool", args: { value: "original" } },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse).mockResolvedValue({
        text: "blocked tool finished",
        toolCalls: [],
        finishReason: "stop",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const handlerStarted = deferred<void>();
    const handlerResult = deferred<ToolResult>();
    const handler = vi.fn(async () => {
      handlerStarted.resolve();
      return handlerResult.promise;
    });
    const tool: ToolDefinition = {
      name: "blocked_tool",
      description: "Starts external execution",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler,
    };
    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, leaseTtlMs: 5, resumeOnStartup: false },
    };

    const runtime1 = await createHarness(config);
    const result = await runtime1.processTurn("default", "run blocked tool", {
      conversationId: "blocked-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const submitPromise = runtime1.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    await handlerStarted.promise;

    expect((await store.get(requestId))?.status).toBe("blocked");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const runtime2 = await createHarness({
      ...config,
      hitl: { store, leaseTtlMs: 5, resumeOnStartup: true },
    });
    const recovered = await runtime2.control.resumeHitl(requestId);
    expect(recovered.status).toBe("notReady");
    expect(handler).toHaveBeenCalledOnce();

    handlerResult.resolve({ type: "text", text: "finished" });
    const submitted = await submitPromise;
    expect(submitted.status).toBe("accepted");
    await waitUntil(async () => expect((await store.get(requestId))?.status).toBe("completed"));
    expect(handler).toHaveBeenCalledOnce();

    await runtime2.close();
    await runtime1.close();
  });

  it("aborts and waits for in-flight HITL resume when runtime closes", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-close-abort-1", toolName: "close_abort_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const handlerStarted = deferred<void>();
    const abortObserved = deferred<void>();
    const tool: ToolDefinition = {
      name: "close_abort_tool",
      description: "Observes close abort",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler: vi.fn(async (_args, context) => {
        handlerStarted.resolve();
        if (!context.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        abortObserved.resolve();
        throw new Error("aborted by close");
      }),
    };

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });
    const result = await runtime.processTurn("default", "create close abort request", {
      conversationId: "close-abort-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const submitted = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    await handlerStarted.promise;

    const closePromise = runtime.close();
    await abortObserved.promise;
    await closePromise;

    expect(tool.handler).toHaveBeenCalledOnce();
    const failed = await store.get(requestId);
    expect(failed?.status).toBe("failed");
    expect(failed?.failure?.error).toContain("aborted by close");
  });

  it("rejects HITL submit, resume, and cancel after runtime close", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-closed-control-1", toolName: "closed_control_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const tool: ToolDefinition = {
      name: "closed_control_tool",
      description: "Requires approval",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler: vi.fn(async () => ({ type: "text" as const, text: "should not run" })),
    };

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });
    const result = await runtime.processTurn("default", "create closed control request", {
      conversationId: "closed-control-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);
    await runtime.close();

    const submitted = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    const resumed = await runtime.control.resumeHitl(requestId);
    const canceled = await runtime.control.cancelHitl({ requestId });

    expect(submitted.status).toBe("error");
    expect(resumed.status).toBe("error");
    expect(canceled.status).toBe("error");
    expect((await store.get(requestId))?.status).toBe("pending");
    expect(tool.handler).not.toHaveBeenCalled();
  });

  it("marks unrecoverable HITL resume failures as non-retryable", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-missing-tool-1", toolName: "missing_after_restart", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new InMemoryHitlStore();
    const tool: ToolDefinition = {
      name: "missing_after_restart",
      description: "Exists only before restart",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler: vi.fn(async () => ({ type: "text" as const, text: "should not run" })),
    };

    const runtime1 = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });
    const result = await runtime1.processTurn("default", "create missing tool request", {
      conversationId: "missing-tool-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);
    await runtime1.close();

    const runtime2 = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const submitted = await runtime2.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });
    expect(submitted.status).toBe("accepted");
    expect(submitted.status === "accepted" ? submitted.resume.status : null).toBe("scheduled");

    await waitUntil(async () => {
      const failed = await store.get(requestId);
      expect(failed?.status).toBe("failed");
      expect(failed?.failure?.retryable).toBe(false);
      expect(failed?.failure?.error).toContain("Tool \"missing_after_restart\" not found");
    });

    const retried = await runtime2.control.resumeHitl(requestId);
    expect(retried.status).toBe("alreadyTerminal");

    await runtime2.close();
  });

  it("returns leaseConflict when failure persistence loses the lease instead of throwing invalid", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-stale-fail-1", toolName: "stale_fail_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new LeaseStealingFailStore();
    const tool: ToolDefinition = {
      name: "stale_fail_tool",
      description: "Fails during mapping after the lease can expire",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
        mapResult: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("mapper failed");
        },
      },
      handler: vi.fn(async () => ({ type: "text" as const, text: "should not run" })),
    };

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, leaseTtlMs: 1, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "create stale failure request", {
      conversationId: "stale-fail-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const submitted = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });

    expect(submitted.status).toBe("accepted");
    expect(submitted.status === "accepted" ? submitted.resume.status : null).toBe("scheduled");
    await waitUntil(async () => expect((await store.get(requestId))?.lease?.ownerId).toBe("other-runtime"));
    const resumed = await runtime.control.resumeHitl(requestId);
    expect(resumed.status).toBe("leaseConflict");
    expect(tool.handler).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("returns resume error when failure persistence fails without losing the lease", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-fail-write-1", toolName: "fail_write_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new FailingFailStore();
    const tool: ToolDefinition = {
      name: "fail_write_tool",
      description: "Fails before handler execution",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
        mapResult: async () => {
          throw new Error("mapper failed");
        },
      },
      handler: vi.fn(async () => ({ type: "text" as const, text: "should not run" })),
    };

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "create fail write request", {
      conversationId: "fail-write-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const submitted = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });

    expect(submitted.status).toBe("accepted");
    expect(submitted.status === "accepted" ? submitted.resume.status : null).toBe("scheduled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumed = await runtime.control.resumeHitl(requestId);
    expect(resumed.status).toBe("error");
    expect(resumed.status === "error" ? resumed.error : "").toContain("Failed to persist HITL failure");
    expect(tool.handler).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("returns submit error, not invalid, when the decision write fails", async () => {
    const { createLlmClient } = await import("../models/index.js");
    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn().mockResolvedValue({
        toolCalls: [
          { toolCallId: "call-resolve-fail-1", toolName: "resolve_fail_tool", args: {} },
        ],
        finishReason: "tool-calls",
      } satisfies LlmResponse),
    }));

    const store = new FailingResolveStore();
    const tool: ToolDefinition = {
      name: "resolve_fail_tool",
      description: "Resolve fails",
      parameters: { type: "object", additionalProperties: false },
      hitl: {
        mode: "required",
        response: { type: "approval" },
      },
      handler: vi.fn(async () => ({ type: "text" as const, text: "should not run" })),
    };

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          tools: [tool],
        },
      },
      hitl: { store, resumeOnStartup: false },
    });

    const result = await runtime.processTurn("default", "create resolve fail request", {
      conversationId: "resolve-fail-hitl-conv",
    });
    const requestId = firstPendingHitlRequestId(result);

    const submitted = await runtime.control.submitHitlResult({
      requestId,
      result: { decision: "approve", submittedAt: new Date().toISOString() },
    });

    expect(submitted.status).toBe("error");
    expect(submitted.status === "error" ? submitted.error : "").toContain("resolve store write failed");
    expect(tool.handler).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("does not leak unhandled rejections when startup recovery store read fails", async () => {
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
        },
      },
      hitl: { store: new FailingRecoverStore(), resumeOnStartup: true },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 2: env() refs resolved at createHarness time
  // -----------------------------------------------------------------------
  it("resolves env() refs at createHarness time", async () => {
    const original = process.env["TEST_API_KEY"];
    process.env["TEST_API_KEY"] = "resolved-key-123";

    try {
      const { createLlmClient } = await import("../models/index.js");
      const config = minimalConfig({
        agents: {
          default: {
            model: { provider: "openai", model: "gpt-4", apiKey: env("TEST_API_KEY") },
          },
        },
      });

      const runtime = await createHarness(config);

      // createLlmClient should have been called with the resolved key
      expect(createLlmClient).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai", model: "gpt-4" }),
        "resolved-key-123",
      );

      await runtime.close();
    } finally {
      if (original === undefined) {
        delete process.env["TEST_API_KEY"];
      } else {
        process.env["TEST_API_KEY"] = original;
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Missing env var → clear error message (ConfigError)
  // -----------------------------------------------------------------------
  it("throws ConfigError when env var is missing", async () => {
    delete process.env["MISSING_KEY_XYZ"];

    const config = minimalConfig({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: env("MISSING_KEY_XYZ") },
        },
      },
    });

    await expect(createHarness(config)).rejects.toThrow("MISSING_KEY_XYZ");
    await expect(createHarness(config)).rejects.toThrow(/not set/i);
  });

  it("allows model configs without top-level apiKey", async () => {
    const { createLlmClient } = await import("../models/index.js");

    const runtime = await createHarness({
      agents: {
        default: {
          model: {
            provider: "openai",
            model: "gpt-4.1-mini",
            providerOptions: {
              baseURL: "https://proxy.example.com/v1",
              project: "openharness",
            },
          },
        },
      },
    });

    expect(createLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4.1-mini",
        providerOptions: {
          baseURL: "https://proxy.example.com/v1",
          project: "openharness",
        },
      }),
      undefined,
    );

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 4: Extension registration order matches declaration order
  // -----------------------------------------------------------------------
  it("registers extensions in declaration order", async () => {
    const order: string[] = [];

    const ext1: Extension = {
      name: "ext-a",
      register: () => { order.push("ext-a"); },
    };
    const ext2: Extension = {
      name: "ext-b",
      register: () => { order.push("ext-b"); },
    };
    const ext3: Extension = {
      name: "ext-c",
      register: () => { order.push("ext-c"); },
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
          extensions: [ext1, ext2, ext3],
        },
      },
    };

    const runtime = await createHarness(config);
    expect(order).toEqual(["ext-a", "ext-b", "ext-c"]);
    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 5: Multiple agents — no crash
  // -----------------------------------------------------------------------
  it("handles multiple agents without error", async () => {
    const config: HarnessConfig = {
      agents: {
        agent1: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key1" },
        },
        agent2: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key2" },
        },
      },
    };

    const runtime = await createHarness(config);
    expect(runtime).toBeDefined();

    // Both agents should be usable — try processTurn with each
    const result1 = await runtime.processTurn("agent1", "hello");
    expect(result1.agentName).toBe("agent1");

    const result2 = await runtime.processTurn("agent2", "hello");
    expect(result2.agentName).toBe("agent2");

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 6: runtime.processTurn → calls executeTurn, returns TurnResult
  // -----------------------------------------------------------------------
  it("processTurn returns a TurnResult with correct values", async () => {
    const runtime = await createHarness(minimalConfig());

    const result = await runtime.processTurn("default", "test input");

    expect(result.agentName).toBe("default");
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Hello from mock");
    expect(typeof result.turnId).toBe("string");
    expect(result.turnId.length).toBeGreaterThan(0);
    expect(typeof result.conversationId).toBe("string");
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 7: runtime.close → rejects subsequent processTurn calls
  // -----------------------------------------------------------------------
  it("close() causes subsequent processTurn to throw", async () => {
    const runtime = await createHarness(minimalConfig());

    await runtime.close();

    await expect(runtime.processTurn("default", "hello")).rejects.toThrow(HarnessError);
    await expect(runtime.processTurn("default", "hello")).rejects.toThrow(/closed/i);
  });

  // -----------------------------------------------------------------------
  // Test 8: runtime.ingress.receive → delegates to IngressPipeline
  // -----------------------------------------------------------------------
  it("ingress.receive delegates to the IngressPipeline", async () => {
    const connector = {
      name: "test-connector",
      normalize: vi.fn().mockResolvedValue({
        name: "message",
        content: [{ type: "text" as const, text: "hello" }],
        properties: {},
        conversationId: "test-conv-1",
        source: { connector: "test-connector", connectionName: "test-conn", receivedAt: new Date().toISOString() },
      } satisfies InboundEnvelope),
    };

    const config: HarnessConfig = {
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        "test-conn": {
          connector,
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    };

    const runtime = await createHarness(config);

    const results = await runtime.ingress.receive({
      connectionName: "test-conn",
      payload: { text: "hello" },
    });

    expect(results.length).toBe(1);
    expect(results[0].accepted).toBe(true);
    expect(results[0].agentName).toBe("default");
    expect(connector.normalize).toHaveBeenCalled();

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 9: runtime.control.abortConversation → aborts correct conversation
  // -----------------------------------------------------------------------
  it("abortConversation aborts the correct conversation", async () => {
    // Use a slow mock to keep a turn in-flight
    const { createLlmClient } = await import("../models/index.js");
    let chatCalled: () => void;
    const chatStarted = new Promise<void>((resolve) => { chatCalled = resolve; });

    const slowClient: LlmClient = {
      chat: vi.fn().mockImplementation(
        (_msgs: Message[], _tools: ToolDefinition[], signal: AbortSignal) =>
          new Promise<LlmResponse>((resolve, reject) => {
            chatCalled!();
            const timer = setTimeout(() => resolve({ text: "done" }), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    (createLlmClient as ReturnType<typeof vi.fn>).mockReturnValue(slowClient);

    const runtime = await createHarness(minimalConfig());

    // Start a turn that will hang
    const turnPromise = runtime.processTurn("default", "long task", {
      conversationId: "conv-to-abort",
    });

    // Wait until the LLM mock is actually called (reliable latch, no sleep)
    await chatStarted;

    // Abort it
    const abortResult = await runtime.control.abortConversation({
      conversationId: "conv-to-abort",
      reason: "user cancelled",
    });

    expect(abortResult.conversationId).toBe("conv-to-abort");
    expect(abortResult.abortedTurns).toBeGreaterThanOrEqual(1);

    // The turn should resolve with aborted status
    const result = await turnPromise;
    expect(result.status).toBe("aborted");

    await runtime.close();
  });

  it("runtime.events exposes aborted turn.error payloads with status", async () => {
    const { createLlmClient } = await import("../models/index.js");
    let chatCalled: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      chatCalled = resolve;
    });
    const observedStatuses: Array<"aborted" | "error"> = [];

    const slowClient: LlmClient = {
      chat: vi.fn().mockImplementation(
        (_msgs: Message[], _tools: ToolDefinition[], signal: AbortSignal) =>
          new Promise<LlmResponse>((resolve, reject) => {
            chatCalled!();
            const timer = setTimeout(() => resolve({ text: "done" }), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    };
    (createLlmClient as ReturnType<typeof vi.fn>).mockReturnValue(slowClient);

    const runtime = await createHarness(minimalConfig());
    const unsubscribe = runtime.events.on("turn.error", (payload) => {
      observedStatuses.push(payload.status);
    });

    const turnPromise = runtime.processTurn("default", "long task", {
      conversationId: "conv-runtime-event-abort",
    });

    await chatStarted;

    await runtime.control.abortConversation({
      conversationId: "conv-runtime-event-abort",
      reason: "user cancelled",
    });

    const result = await turnPromise;
    unsubscribe();

    expect(result.status).toBe("aborted");
    expect(observedStatuses).toEqual(["aborted"]);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 10: defineHarness is identity function (no side effects)
  // -----------------------------------------------------------------------
  it("defineHarness is an identity function with no side effects", () => {
    const config = minimalConfig();
    const result = defineHarness(config);

    // Same reference (identity function)
    expect(result).toBe(config);
    // No mutation
    expect(result).toEqual(config);
  });

  // -----------------------------------------------------------------------
  // Test 11: runtime snapshots include all agents and connections
  // -----------------------------------------------------------------------
  it("builds complete api.runtime snapshots before registering extensions", async () => {
    const snapshots: Array<{
      agentName: string;
      agentKeys: string[];
      connectionKeys: string[];
    }> = [];

    const captureRuntime = (name: string): Extension => ({
      name,
      register(api) {
        snapshots.push({
          agentName: api.runtime.agent.name,
          agentKeys: Object.keys(api.runtime.agents).sort(),
          connectionKeys: Object.keys(api.runtime.connections).sort(),
        });
      },
    });

    const runtime = await createHarness({
      agents: {
        agentA: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-a" },
          extensions: [captureRuntime("capture-a")],
        },
        agentB: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-b" },
          extensions: [captureRuntime("capture-b")],
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "conv-1",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "agentA" }],
        },
      },
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual([
      {
        agentName: "agentA",
        agentKeys: ["agentA", "agentB"],
        connectionKeys: ["inbound"],
      },
      {
        agentName: "agentB",
        agentKeys: ["agentA", "agentB"],
        connectionKeys: ["inbound"],
      },
    ]);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 12: conversation state is isolated per agent
  // -----------------------------------------------------------------------
  it("isolates conversation state by agent even when conversationId is shared", async () => {
    const { createLlmClient } = await import("../models/index.js");

    const agentAClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "agent-a-response" }),
    };
    const agentBClient: LlmClient = {
      chat: vi.fn().mockResolvedValue({ text: "agent-b-response" }),
    };

    vi.mocked(createLlmClient)
      .mockReturnValueOnce(agentAClient)
      .mockReturnValueOnce(agentBClient);

    const runtime = await createHarness({
      agents: {
        agentA: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-a" },
        },
        agentB: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-b" },
        },
      },
    });

    await runtime.processTurn("agentA", "hello from agent A", {
      conversationId: "shared-conv",
    });
    await runtime.processTurn("agentB", "hello from agent B", {
      conversationId: "shared-conv",
    });

    const [messagesForAgentB] = vi.mocked(agentBClient.chat).mock.calls[0] as [
      Message[],
      unknown,
      unknown,
    ];

    expect(messagesForAgentB).toHaveLength(1);
    expect(messagesForAgentB[0]?.data.role).toBe("user");
    expect(messagesForAgentB[0]?.data.content).toBe("hello from agent B");

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 13: route middleware comes from the matched agent only
  // -----------------------------------------------------------------------
  it("runs route middleware only for the matched agent's extensions", async () => {
    const routeCalls: string[] = [];

    const routeExtension = (agentLabel: string): Extension => ({
      name: `route-${agentLabel}`,
      register(api) {
        api.pipeline.register("route", async (_ctx, next) => {
          routeCalls.push(agentLabel);
          return next();
        });
      },
    });

    const runtime = await createHarness({
      agents: {
        agentA: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-a" },
          extensions: [routeExtension("agentA")],
        },
        agentB: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key-b" },
          extensions: [routeExtension("agentB")],
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "conv-1",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "agentB" }],
        },
      },
    });

    const results = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "hello" },
    });

    expect(results).toHaveLength(1);
    expect(routeCalls).toEqual(["agentB"]);

    await runtime.close();
  });

  // -----------------------------------------------------------------------
  // Test 14: ingress accepted turnId matches turn.start turnId
  // -----------------------------------------------------------------------
  it("reuses the ingress turnId for the actual turn execution", async () => {
    let acceptedTurnId: string | undefined;
    let startedTurnId: string | undefined;

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
          extensions: [
            {
              name: "capture-turn-start",
              register(api) {
                api.on("turn.start", (payload) => {
                  startedTurnId = (payload as { turnId: string }).turnId;
                });
              },
            },
          ],
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "turn-id-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          extensions: [
            {
              name: "capture-ingress-accepted",
              register(api) {
                api.on("ingress.accepted", (payload) => {
                  acceptedTurnId = (payload as { turnId: string }).turnId;
                });
              },
            },
          ],
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });

    const results = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "hello" },
    });

    await Promise.resolve();

    expect(results).toHaveLength(1);
    expect(results[0]?.turnId).toBeTruthy();
    expect(acceptedTurnId).toBe(results[0]?.turnId);
    expect(startedTurnId).toBe(results[0]?.turnId);

    await runtime.close();
  });

  it("steers a second ingress message into an active turn for the same conversation", async () => {
    const { createLlmClient } = await import("../models/index.js");
    let releaseFirstResponse!: () => void;
    let firstChatStarted!: () => void;
    const firstChatStartedPromise = new Promise<void>((resolve) => {
      firstChatStarted = resolve;
    });
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const capturedMessages: Message[][] = [];
    let callCount = 0;

    vi.mocked(createLlmClient).mockImplementation(() => ({
      chat: vi.fn(async (messages) => {
        capturedMessages.push([...(messages as Message[])]);
        callCount++;
        if (callCount === 1) {
          firstChatStarted();
          await firstResponseGate;
          return { text: "first answer", toolCalls: [] };
        }
        return { text: "answer after steer", toolCalls: [] };
      }),
    }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async (ctx) => ({
              name: "message",
              content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
              properties: {},
              conversationId: "steer-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: ctx.receivedAt,
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });

    const first = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "first" },
    });
    await firstChatStartedPromise;

    const second = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "second" },
    });

    releaseFirstResponse();

    await new Promise<void>((resolve) => {
      const unsubscribe = runtime.events.on("turn.done", () => {
        unsubscribe();
        resolve();
      });
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].disposition).toBe("started");
    expect(second[0].disposition).toBe("steered");
    expect(second[0].turnId).toBe(first[0].turnId);
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1].some((message) =>
      message.data.role === "user" && message.data.content === "second",
    )).toBe(true);

    await runtime.close();
  });

  it("tracks an active turn before turn.start listeners run", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const chat = vi.fn().mockResolvedValue({ text: "should not run", toolCalls: [] });
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    let runtime: Awaited<ReturnType<typeof createHarness>>;
    let resolveAbortedTurns!: (value: number) => void;
    const abortedTurnsPromise = new Promise<number>((resolve) => {
      resolveAbortedTurns = resolve;
    });

    runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
          extensions: [
            {
              name: "abort-on-turn-start",
              register(api) {
                api.on("turn.start", () => {
                  void runtime.control.abortConversation({
                    conversationId: "early-active-conv",
                    reason: "test abort from turn.start",
                  }).then((result) => resolveAbortedTurns(result.abortedTurns));
                });
              },
            },
          ],
        },
      },
    });

    const result = await runtime.processTurn("default", "start", {
      conversationId: "early-active-conv",
    });

    expect(await abortedTurnsPromise).toBe(1);
    expect(result.status).toBe("aborted");
    expect(chat).not.toHaveBeenCalled();

    await runtime.close();
  });

  it("starts a new turn for ingress received while emitting turn.done", async () => {
    const { createLlmClient } = await import("../models/index.js");
    const capturedMessages: Message[][] = [];
    const chat = vi.fn(async (messages) => {
      capturedMessages.push([...(messages as Message[])]);
      return { text: `answer ${capturedMessages.length}`, toolCalls: [] };
    });
    vi.mocked(createLlmClient).mockImplementation(() => ({ chat }));

    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async (ctx) => ({
              name: "message",
              content: [{ type: "text", text: String((ctx.payload as { text: string }).text) }],
              properties: {},
              conversationId: "done-boundary-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: ctx.receivedAt,
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });

    let secondIngressPromise: Promise<Awaited<ReturnType<typeof runtime.ingress.receive>>> | undefined;
    let resolveSecondIngressScheduled!: () => void;
    const secondIngressScheduled = new Promise<void>((resolve) => {
      resolveSecondIngressScheduled = resolve;
    });
    let doneCount = 0;
    const twoTurnsDone = new Promise<void>((resolve) => {
      const unsubscribe = runtime.events.on("turn.done", () => {
        doneCount++;
        if (doneCount === 1) {
          secondIngressPromise = runtime.ingress.receive({
            connectionName: "inbound",
            payload: { text: "second" },
          });
          resolveSecondIngressScheduled();
        }
        if (doneCount === 2) {
          unsubscribe();
          resolve();
        }
      });
    });

    const first = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "first" },
    });

    await secondIngressScheduled;
    const second = await secondIngressPromise!;
    await twoTurnsDone;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].disposition).toBe("started");
    expect(second[0].disposition).toBe("started");
    expect(second[0].turnId).not.toBe(first[0].turnId);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(capturedMessages[1].some((message) =>
      message.data.role === "user" && message.data.content === "second",
    )).toBe(true);

    await runtime.close();
  });

  it("runtime.events receives processTurn lifecycle events", async () => {
    const runtime = await createHarness(minimalConfig());
    const observed: TurnResult[] = [];

    const unsubscribe = runtime.events.on("turn.done", (payload) => {
      observed.push(payload.result);
    });

    const result = await runtime.processTurn("default", "capture runtime events");

    unsubscribe();

    expect(observed).toHaveLength(1);
    expect(observed[0]?.turnId).toBe(result.turnId);
    expect(observed[0]?.conversationId).toBe(result.conversationId);

    await runtime.close();
  });

  it("runtime.events receives ingress lifecycle events", async () => {
    const runtime = await createHarness({
      agents: {
        default: {
          model: { provider: "openai", model: "gpt-4", apiKey: "key" },
        },
      },
      connections: {
        inbound: {
          connector: {
            name: "test-connector",
            normalize: async () => ({
              name: "message",
              content: [{ type: "text", text: "hello" }],
              properties: {},
              conversationId: "runtime-events-conv",
              source: {
                connector: "test-connector",
                connectionName: "inbound",
                receivedAt: new Date().toISOString(),
              },
            }),
          },
          rules: [{ match: { event: "message" }, agent: "default" }],
        },
      },
    });
    const receivedTypes: string[] = [];

    const unsubReceived = runtime.events.on("ingress.received", (payload) => {
      receivedTypes.push(payload.type);
    });
    const unsubAccepted = runtime.events.on("ingress.accepted", (payload) => {
      receivedTypes.push(payload.type);
    });

    const results = await runtime.ingress.receive({
      connectionName: "inbound",
      payload: { text: "hello" },
    });

    await Promise.resolve();

    unsubReceived();
    unsubAccepted();

    expect(results).toHaveLength(1);
    expect(receivedTypes).toEqual(["ingress.received", "ingress.accepted"]);

    await runtime.close();
  });
});

import type {
  StepContext,
  StepResult,
  LlmClient,
  AssistantModelMessage,
  ToolModelMessage,
  ToolResult,
  HitlStore,
  HitlRequestRecord,
  HitlResponseSchema,
  JsonObject,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { executeToolCall } from "./tool-call.js";
import { normalizeToolArgsResult } from "../tool-args.js";
import { createHitlBatchId, createHitlRequestId, toHitlBatchView, toHitlRequestView } from "../hitl/store.js";

interface CanonicalToolCall {
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  args: JsonObject;
  invalidReason?: string;
  malformedResult?: ToolResult;
}

interface PlannedToolCall extends CanonicalToolCall {
  requiresHitl: boolean;
  requestId?: string;
  prompt?: string;
  responseSchema?: HitlResponseSchema;
  expiresAt?: string;
}

function toToolResultOutput(toolResult: ToolResult) {
  return toolResult.type === "text"
    ? { type: "text" as const, value: toolResult.text }
    : toolResult.type === "json"
      ? { type: "json" as const, value: toolResult.data }
      : { type: "error-text" as const, value: toolResult.error };
}

/**
 * Execute a single step in the agentic loop.
 *
 * Flow (EXEC-STEP-01):
 * 1. Emit step.start
 * 2. Build step middleware chain with core handler
 * 3. Core handler:
 *    a. Get current messages from ctx.conversation.messages
 *    b. Get available tools from deps.toolRegistry.list()
 *    c. If streamChat available, use it with EventBus callbacks; else fallback to chat()
 *    d. FR-CORE-007: Append LLM response to conversation (assistant message)
 *    e. If LLM response has tool calls: execute each via executeToolCall
 *       FR-CORE-007: Append each tool result to conversation
 *    f. Return StepResult
 * 4. Emit step.done with result
 * 5. On error: emit step.error, rethrow
 */
export async function executeStep(
  ctx: StepContext,
  deps: {
    llmClient: LlmClient;
    toolRegistry: ToolRegistry;
    middlewareRegistry: MiddlewareRegistry;
    eventBus: EventBus;
    hitlStore?: HitlStore;
  }
): Promise<StepResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus, hitlStore } = deps;
  const { turnId, agentName, conversationId, stepNumber } = ctx;

  // 1. Emit step.start
  eventBus.emit("step.start", {
    type: "step.start",
    turnId,
    agentName,
    conversationId,
    stepNumber,
  });

  // 2. Core handler — the innermost logic
  const coreHandler = async (stepCtx: StepContext): Promise<StepResult> => {
    // a. Get current messages
    const messages = [...stepCtx.conversation.messages];

    // b. Get available tools
    const tools = toolRegistry.list() as ReturnType<ToolRegistry["list"]>;

    // c. Call LLM — prefer streamChat for real-time delta events (FR-CORE-010)
    const llmResponse = llmClient.streamChat
      ? await llmClient.streamChat(
          messages as Parameters<LlmClient["chat"]>[0],
          tools as Parameters<LlmClient["chat"]>[1],
          stepCtx.abortSignal,
          {
            onTextDelta: (delta) =>
              eventBus.emit("step.textDelta", {
                type: "step.textDelta",
                turnId,
                agentName,
                conversationId,
                stepNumber,
                delta,
              }),
            onToolCallDelta: (toolCallId, toolName, argsDelta) =>
              eventBus.emit("step.toolCallDelta", {
                type: "step.toolCallDelta",
                turnId,
                agentName,
                conversationId,
                stepNumber,
                toolCallId,
                toolName,
                argsDelta,
              }),
          },
        )
      : await llmClient.chat(
          messages as Parameters<LlmClient["chat"]>[0],
          tools as Parameters<LlmClient["chat"]>[1],
          stepCtx.abortSignal,
        );

    // d. FR-CORE-007: Record the LLM assistant response as a non-system message
    const assistantContent: NonNullable<AssistantModelMessage["content"]> extends infer T
      ? T extends string
        ? never
        : T
      : never = [];

    if (llmResponse.text) {
      assistantContent.push({ type: "text", text: llmResponse.text });
    }

    const canonicalToolCalls =
      llmResponse.toolCalls?.map((tc, index) => {
        const normalized = normalizeToolArgsResult(tc.args);
        const invalidReason = tc.invalidReason ?? (normalized.ok ? undefined : normalized.error);
        const malformedResult: ToolResult | undefined = invalidReason
          ? {
              type: "error",
              error: invalidReason,
            }
          : undefined;

        return {
          toolCallId: tc.toolCallId,
          toolCallIndex: index,
          toolName: tc.toolName,
          args: normalized.args,
          invalidReason,
          malformedResult,
        };
      }) ?? [];

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      for (const tc of canonicalToolCalls) {
        assistantContent.push({
          type: "tool-call",
          toolName: tc.toolName,
          input: tc.args,
          toolCallId: tc.toolCallId,
        });
      }
    }

    // Append assistant message (even if no content parts, e.g. empty response)
    // Only append if there's something to say
    if (assistantContent.length > 0) {
      stepCtx.conversation.emit({
        type: "appendMessage",
        message: {
          id: `assistant-${stepCtx.turnId}-${stepCtx.stepNumber}`,
          data: {
            role: "assistant",
            content: assistantContent,
          },
          metadata: {
            __createdBy: "core",
          },
        },
      });
    }

    // e. Execute tool calls if any
    const toolCallResults: StepResult["toolCalls"] = [];
    let pendingHitlBatchId: string | undefined;
    const pendingHitlRequestIds: string[] = [];

    if (canonicalToolCalls.length > 0) {
      const plannedToolCalls = await planToolCallsForHitl(canonicalToolCalls, stepCtx, {
        toolRegistry,
      });
      const hasHitl = plannedToolCalls.some((tc) => tc.requiresHitl);

      if (hasHitl) {
        if (!hitlStore) {
          throw new Error("HITL tool call requires a configured HitlStore");
        }

        const now = new Date().toISOString();
        const batchId = createHitlBatchId();
        pendingHitlBatchId = batchId;

        const requests: HitlRequestRecord[] = plannedToolCalls
          .filter((tc) => tc.requiresHitl)
          .map((tc) => {
            const requestId = tc.requestId ?? createHitlRequestId();
            pendingHitlRequestIds.push(requestId);
            return {
              requestId,
              batchId,
              status: "pending",
              agentName,
              conversationId,
              turnId,
              stepNumber,
              toolCallId: tc.toolCallId,
              toolCallIndex: tc.toolCallIndex,
              toolName: tc.toolName,
              originalArgs: tc.args,
              ...(tc.prompt ? { prompt: tc.prompt } : {}),
              responseSchema: tc.responseSchema ?? { type: "approval" },
              createdAt: now,
              updatedAt: now,
              ...(tc.expiresAt ? { expiresAt: tc.expiresAt } : {}),
            };
          });

        const created = await hitlStore.createBatch({
          batch: {
            batchId,
            status: "preparing",
            agentName,
            conversationId,
            turnId,
            stepNumber,
            toolCalls: plannedToolCalls.map((tc) => ({
              toolCallId: tc.toolCallId,
              toolCallIndex: tc.toolCallIndex,
              toolName: tc.toolName,
              toolArgs: tc.args,
              requiresHitl: tc.requiresHitl,
              ...(tc.requestId ? { requestId: tc.requestId } : {}),
            })),
            toolResults: [],
            toolExecutions: [],
            conversationEvents: [...stepCtx.conversation.events],
            createdAt: now,
            updatedAt: now,
          },
          requests,
        });
        if (created.status === "conflict") {
          throw new Error(`Conversation already has an open HITL batch: ${created.openBatch.batchId}`);
        }

        let exposedForHuman = false;
        try {
          for (const tc of plannedToolCalls) {
            if (tc.requiresHitl) {
              toolCallResults.push({
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.args,
              });
              continue;
            }

            const result = tc.malformedResult ?? (await executeNonHitlToolCall(tc, stepCtx, {
              toolRegistry,
              middlewareRegistry,
              eventBus,
              hitlStore,
              batchId,
            }));

            await hitlStore.recordBatchToolResult(batchId, {
              batchId,
              toolCallId: tc.toolCallId,
              toolCallIndex: tc.toolCallIndex,
              toolName: tc.toolName,
              result,
              recordedAt: new Date().toISOString(),
            });

            toolCallResults.push({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
              result,
            });
          }

          const waitingBatch = await hitlStore.markBatchWaitingForHuman(batchId);
          exposedForHuman = true;
          const waitingRequests = await hitlStore.listBatchRequests(batchId);
          eventBus.emit("hitl.batch.requested", {
            type: "hitl.batch.requested",
            batch: toHitlBatchView(waitingBatch, waitingRequests),
          });
          for (const request of waitingRequests) {
            eventBus.emit("hitl.requested", {
              type: "hitl.requested",
              request: toHitlRequestView(request),
            });
          }
        } catch (err) {
          if (!exposedForHuman) {
            await hitlStore.cancelBatch(batchId, "HITL batch preparation failed").catch(() => undefined);
          }
          throw err;
        }
      } else {
        for (const tc of plannedToolCalls) {
          const toolResult =
            tc.malformedResult ??
            (await executeNonHitlToolCall(tc, stepCtx, {
              toolRegistry,
              middlewareRegistry,
              eventBus,
              hitlStore,
            }));

          if (tc.malformedResult) {
            eventBus.emit("tool.start", {
              type: "tool.start",
              turnId,
              agentName,
              conversationId,
              stepNumber,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            });
            eventBus.emit("tool.done", {
              type: "tool.done",
              turnId,
              agentName,
              conversationId,
              stepNumber,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
              result: tc.malformedResult,
            });
          }

          stepCtx.conversation.emit({
            type: "appendMessage",
            message: {
              id: `tool-result-${tc.toolCallId}`,
              data: {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    output: toToolResultOutput(toolResult),
                  },
                ],
              } satisfies ToolModelMessage,
              metadata: {
                __createdBy: "core",
              },
            },
          });

          toolCallResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
            ...(tc.invalidReason ? { invalidReason: tc.invalidReason } : {}),
            result: toolResult,
          });
        }
      }
    }

    // f. Return StepResult
    return {
      text: llmResponse.text,
      finishReason: llmResponse.finishReason,
      rawFinishReason: llmResponse.rawFinishReason,
      toolCalls: toolCallResults,
      ...(llmResponse.usage ? { usage: llmResponse.usage } : {}),
      ...(pendingHitlBatchId ? { pendingHitlBatchId } : {}),
      ...(pendingHitlRequestIds.length > 0 ? { pendingHitlRequestIds } : {}),
    };
  };

  // 3. Build step middleware chain
  const chain = middlewareRegistry.buildChain<StepContext, StepResult>("step", coreHandler);

  // 4. Run chain, handling errors
  try {
    const result = await chain(ctx);

    // Emit step.done on success
    eventBus.emit("step.done", {
      type: "step.done",
      turnId,
      agentName,
      conversationId,
      stepNumber,
      result,
    });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // 5. Emit step.error on failure
    eventBus.emit("step.error", {
      type: "step.error",
      turnId,
      agentName,
      conversationId,
      stepNumber,
      error,
    });

    throw error;
  }
}

async function planToolCallsForHitl(
  toolCalls: CanonicalToolCall[],
  stepCtx: StepContext,
  deps: { toolRegistry: ToolRegistry },
): Promise<PlannedToolCall[]> {
  const planned: PlannedToolCall[] = [];

  for (const tc of toolCalls) {
    const base: PlannedToolCall = {
      ...tc,
      requiresHitl: false,
    };

    if (tc.malformedResult) {
      planned.push(base);
      continue;
    }

    const tool = deps.toolRegistry.get(tc.toolName);
    if (!tool || !tool.hitl || tool.hitl.mode === "never") {
      planned.push(base);
      continue;
    }

    const validation = deps.toolRegistry.validate(tc.toolName, tc.args);
    if (!validation.valid) {
      planned.push(base);
      continue;
    }

    const toolCallCtx = {
      ...stepCtx,
      toolName: tc.toolName,
      toolArgs: tc.args,
    };
    const requiresHitl =
      tool.hitl.mode === "required" ||
      (tool.hitl.mode === "conditional" &&
        (tool.hitl.when ? await tool.hitl.when(toolCallCtx) : true));

    if (!requiresHitl) {
      planned.push(base);
      continue;
    }

    const prompt =
      typeof tool.hitl.prompt === "function"
        ? tool.hitl.prompt(toolCallCtx)
        : tool.hitl.prompt;

    planned.push({
      ...base,
      requiresHitl: true,
      requestId: createHitlRequestId(),
      ...(prompt ? { prompt } : {}),
      responseSchema: tool.hitl.response,
      ...(tool.hitl.ttlMs
        ? { expiresAt: new Date(Date.now() + tool.hitl.ttlMs).toISOString() }
        : {}),
    });
  }

  return planned;
}

async function executeNonHitlToolCall(
  tc: CanonicalToolCall,
  stepCtx: StepContext,
  deps: {
    toolRegistry: ToolRegistry;
    middlewareRegistry: MiddlewareRegistry;
    eventBus: EventBus;
    hitlStore?: HitlStore;
    batchId?: string;
  },
): Promise<ToolResult> {
  if (deps.batchId && deps.hitlStore) {
    await deps.hitlStore.startBatchToolExecution(deps.batchId, {
      batchId: deps.batchId,
      toolCallId: tc.toolCallId,
      toolCallIndex: tc.toolCallIndex,
      toolName: tc.toolName,
      startedAt: new Date().toISOString(),
    });
  }

  const result = await executeToolCall(
    tc.toolCallId,
    {
      ...stepCtx,
      toolName: tc.toolName,
      toolArgs: tc.args,
    },
    {
      toolRegistry: deps.toolRegistry,
      middlewareRegistry: deps.middlewareRegistry,
      eventBus: deps.eventBus,
      hitlStore: deps.hitlStore,
      skipHitl: true,
    },
  );

  if (result.type === "pendingHitl") {
    return {
      type: "error",
      error: `Tool "${tc.toolName}" unexpectedly returned pending HITL outside batch planning`,
    };
  }

  return result;
}

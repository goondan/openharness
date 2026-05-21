import type {
  StepContext,
  StepResult,
  LlmClient,
  AssistantModelMessage,
  ToolModelMessage,
  ToolResult,
  HumanApprovalReferenceStore,
  ToolCallContext,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { executeToolCall, isHumanApprovalPendingError, probeHumanApprovalGate } from "./tool-call.js";
import { normalizeToolArgsResult } from "../tool-args.js";

type ToolResultContentPart = Extract<ToolModelMessage["content"][number], { type: "tool-result" }>;

function toToolResultOutput(toolResult: ToolResult) {
  return toolResult.type === "text"
    ? { type: "text" as const, value: toolResult.text }
    : toolResult.type === "json"
      ? { type: "json" as const, value: toolResult.data }
      : toolResult.type === "content"
        ? { type: "content" as const, value: toolResult.content }
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
 *    e. If LLM response has tool calls: execute them via executeToolCall and
 *       append one ordered tool message for the committed tool-call batch.
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
    humanApprovalStore?: HumanApprovalReferenceStore;
  }
): Promise<StepResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus, humanApprovalStore } = deps;
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
      llmResponse.toolCalls?.map((tc) => {
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
          toolName: tc.toolName,
          args: normalized.args,
          invalidReason,
          malformedResult,
        };
      }) ?? [];

    const canOpenHumanApprovalBarrier = (tc: (typeof canonicalToolCalls)[number]) => {
      if (tc.malformedResult) return false;
      if (!humanApprovalStore) return false;
      const tool = toolRegistry.get(tc.toolName);
      if (!tool?.humanApproval || tool.humanApproval.required === false) return false;
      return toolRegistry.validate(tc.toolName, tc.args).valid;
    };

    const humanApprovalToolCallIndexes = canonicalToolCalls.flatMap((tc, index) =>
      canOpenHumanApprovalBarrier(tc) ? [index] : []
    );

    const appendAssistantMessage = (committedToolCalls: typeof canonicalToolCalls) => {
      const committedAssistantContent = [...assistantContent];
      for (const tc of committedToolCalls) {
        committedAssistantContent.push({
          type: "tool-call",
          toolName: tc.toolName,
          input: tc.args,
          toolCallId: tc.toolCallId,
        });
      }

      // Append assistant message (even if no content parts, e.g. empty response)
      // Only append if there's something to say
      if (committedAssistantContent.length > 0) {
        stepCtx.conversation.emit({
          type: "appendMessage",
          message: {
            id: `assistant-${stepCtx.turnId}-${stepCtx.stepNumber}`,
            data: {
              role: "assistant",
              content: committedAssistantContent,
            },
            metadata: {
              __createdBy: "core",
            },
          },
        });
      }
    };

    const emitSuppressedToolCalls = (committedToolCall: (typeof canonicalToolCalls)[number]) => {
      const suppressedToolCalls = canonicalToolCalls.filter((tc) => tc.toolCallId !== committedToolCall.toolCallId);
      if (suppressedToolCalls.length === 0) {
        return;
      }

      eventBus.emit("step.toolCallsSuppressed", {
        type: "step.toolCallsSuppressed",
        turnId,
        agentName,
        conversationId,
        stepNumber,
        reason: "humanApprovalBarrier",
        committedToolCallId: committedToolCall.toolCallId,
        suppressedToolCalls: suppressedToolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
        })),
      });
    };

    const appendSingleAssistantToolCall = (tc: (typeof canonicalToolCalls)[number]) => {
      appendAssistantMessage([tc]);
    };

    const appendAllAssistantToolCalls = () => {
      appendAssistantMessage(canonicalToolCalls);
    };

    const appendTextOnlyAssistantMessage = () => {
      appendAssistantMessage([]);
    };

    if (canonicalToolCalls.length === 0) {
      appendTextOnlyAssistantMessage();
    }

    // e. Execute committed tool calls (EXEC-CONST-003).
    //    - If ANY tool in the LLM-returned batch can open a humanApproval gate,
    //      only the first approval tool call is committed to the model history.
    //      Sibling tool calls are explicitly surfaced through step.toolCallsSuppressed
    //      and are not recorded because a pending approval cannot emit a same-step
    //      result, and provider adapters require the next tool message to answer
    //      the immediately previous assistant tool-call batch.
    //    - Otherwise execute all handlers in parallel. Result/appendMessage order still
    //      follows the LLM-returned tool call order.
    const toolCallResults: StepResult["toolCalls"] = [];
    const pendingToolResultParts: ToolResultContentPart[] = [];

    const emitMalformedEvents = (tc: (typeof canonicalToolCalls)[number]) => {
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
      // biome-ignore lint/style/noNonNullAssertion: only called when malformedResult exists
      const result = tc.malformedResult!;
      eventBus.emit("tool.done", {
        type: "tool.done",
        turnId,
        agentName,
        conversationId,
        stepNumber,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        result,
      });
    };

    const recordToolResult = (
      tc: (typeof canonicalToolCalls)[number],
      toolResult: ToolResult,
    ) => {
      pendingToolResultParts.push({
        type: "tool-result",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: toToolResultOutput(toolResult),
      });
      toolCallResults.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        ...(tc.invalidReason ? { invalidReason: tc.invalidReason } : {}),
        result: toolResult,
      });
    };

    const appendPendingToolResultMessage = () => {
      if (pendingToolResultParts.length === 0) {
        return;
      }

      const firstToolCallId = pendingToolResultParts[0]?.toolCallId;
      stepCtx.conversation.emit({
        type: "appendMessage",
        message: {
          id: pendingToolResultParts.length === 1 && firstToolCallId
            ? `tool-result-${firstToolCallId}`
            : `tool-results-${stepCtx.turnId}-${stepCtx.stepNumber}`,
          data: {
            role: "tool",
            content: [...pendingToolResultParts],
          } satisfies ToolModelMessage,
          metadata: {
            __createdBy: "core",
          },
        },
      });
      pendingToolResultParts.length = 0;
    };

    const executeCanonicalToolCall = async (
      tc: (typeof canonicalToolCalls)[number],
    ): Promise<ToolResult> => {
      if (tc.malformedResult) {
        emitMalformedEvents(tc);
        return tc.malformedResult;
      }

      const toolCallCtx = {
        ...stepCtx,
        toolName: tc.toolName,
        toolArgs: tc.args,
      };

      return await executeToolCall(tc.toolCallId, toolCallCtx, {
        toolRegistry,
        middlewareRegistry,
        eventBus,
        humanApprovalStore,
      });
    };

    const executeProbedToolResult = async (
      tc: (typeof canonicalToolCalls)[number],
      probedResult: ToolResult,
    ): Promise<ToolResult> => {
      const toolCallCtx: ToolCallContext = {
        ...stepCtx,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        toolArgs: tc.args,
      };

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

      const chain = middlewareRegistry.buildChain<ToolCallContext, ToolResult>(
        "toolCall",
        async () => probedResult,
      );

      try {
        const result = await chain(toolCallCtx);
        eventBus.emit("tool.done", {
          type: "tool.done",
          turnId,
          agentName,
          conversationId,
          stepNumber,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
          result,
        });
        return result;
      } catch (err) {
        if (isHumanApprovalPendingError(err)) {
          throw err;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        eventBus.emit("tool.error", {
          type: "tool.error",
          turnId,
          agentName,
          conversationId,
          stepNumber,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
          error,
        });
        return { type: "error", error: error.message };
      }
    };

    const recordSettledToolCalls = (
      toolCalls: typeof canonicalToolCalls,
      settled: readonly PromiseSettledResult<ToolResult>[],
    ) => {
      // Append fulfilled results in LLM-returned order.
      for (let i = 0; i < toolCalls.length; i++) {
        const entry = settled[i];
        if (entry.status === "fulfilled") {
          recordToolResult(toolCalls[i], entry.value);
        }
      }
      appendPendingToolResultMessage();

      // Surface the first error (HITL pending or unexpected) in LLM order.
      for (const entry of settled) {
        if (entry.status === "rejected") {
          throw entry.reason;
        }
      }
    };

    if (canonicalToolCalls.length > 0) {
      if (humanApprovalToolCallIndexes.length > 0) {
        // Probe declared approval candidates in LLM order before committing the
        // assistant batch. The probe only attempts approval-gate creation; it
        // deliberately does not run toolCall middleware or the tool handler,
        // because any candidate may later become a suppressed sibling if another
        // approval call reaches pending state.
        const probedApprovalResults = new Map<number, ToolResult>();
        for (const approvalIndex of humanApprovalToolCallIndexes) {
          const approvalToolCall = canonicalToolCalls[approvalIndex];
          const probeResult = await probeHumanApprovalGate(
            {
              ...stepCtx,
              toolCallId: approvalToolCall.toolCallId,
              toolName: approvalToolCall.toolName,
              toolArgs: approvalToolCall.args,
            },
            {
              toolRegistry,
              eventBus,
              humanApprovalStore,
            },
          );
          if (probeResult.status === "pending") {
            emitSuppressedToolCalls(approvalToolCall);
            appendSingleAssistantToolCall(approvalToolCall);
            throw probeResult.error;
          }

          probedApprovalResults.set(approvalIndex, probeResult.result);
        }

        appendAllAssistantToolCalls();
        const settled = await Promise.allSettled(
          canonicalToolCalls.map(async (tc, index) => {
            const probedApprovalResult = probedApprovalResults.get(index);
            if (probedApprovalResult) {
              return await executeProbedToolResult(tc, probedApprovalResult);
            }
            return await executeCanonicalToolCall(tc);
          }),
        );
        recordSettledToolCalls(canonicalToolCalls, settled);
      } else {
        appendAllAssistantToolCalls();
        // Parallel path — no tool in this batch can open a declared humanApproval
        // gate, so the single-approval invariant cannot be violated by static
        // policy.
        //
        // We use Promise.allSettled (not Promise.all) so that if a non-pending
        // error or a *dynamic* HumanApprovalPendingError (thrown by middleware
        // not visible at pre-flight) bubbles out of one handler, the completed
        // siblings still get their tool-result appended in LLM order. After the
        // batch settles we surface the first error (HITL or otherwise) in LLM
        // order. Multi-gate dynamic approvals in the same batch are an
        // unsupported pattern; tools/extensions should declare `humanApproval`
        // on the ToolDefinition so the pre-flight check routes the batch to the
        // sequential path.
        const settled = await Promise.allSettled(
          canonicalToolCalls.map(async (tc) => await executeCanonicalToolCall(tc)),
        );
        recordSettledToolCalls(canonicalToolCalls, settled);
      }
    }

    // f. Return StepResult
    return {
      text: llmResponse.text,
      finishReason: llmResponse.finishReason,
      rawFinishReason: llmResponse.rawFinishReason,
      toolCalls: toolCallResults,
      ...(llmResponse.usage ? { usage: llmResponse.usage } : {}),
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
    if (isHumanApprovalPendingError(err)) {
      throw err;
    }

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

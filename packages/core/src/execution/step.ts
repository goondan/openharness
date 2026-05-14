import type {
  StepContext,
  StepResult,
  LlmClient,
  AssistantModelMessage,
  ToolModelMessage,
  ToolResult,
  HumanApprovalReferenceStore,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { executeToolCall, isHumanApprovalPendingError } from "./tool-call.js";
import { normalizeToolArgsResult } from "../tool-args.js";

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

    // e. Execute tool calls in parallel (EXEC-CONST-003).
    //    Result/appendMessage order still follows the LLM-returned tool call order.
    //    If any tool throws HumanApprovalPendingError, skip all tool-result appendMessage
    //    and rethrow the FIRST pending error (in LLM order) after all parallel work settles.
    const toolCallResults: StepResult["toolCalls"] = [];

    if (canonicalToolCalls.length > 0) {
      type Settled =
        | { kind: "result"; result: ToolResult }
        | { kind: "pending"; error: unknown }
        | { kind: "error"; error: unknown };

      const settled = await Promise.all(
        canonicalToolCalls.map(async (tc): Promise<Settled> => {
          // Malformed args: skip the handler, but still emit tool.start/done so observers
          // see one event pair per LLM-returned tool call.
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
            return { kind: "result", result: tc.malformedResult };
          }

          const toolCallCtx = {
            ...stepCtx,
            toolName: tc.toolName,
            toolArgs: tc.args,
          };

          try {
            const result = await executeToolCall(tc.toolCallId, toolCallCtx, {
              toolRegistry,
              middlewareRegistry,
              eventBus,
              humanApprovalStore,
            });
            return { kind: "result", result };
          } catch (err) {
            if (isHumanApprovalPendingError(err)) {
              return { kind: "pending", error: err };
            }
            // executeToolCall already normalizes non-pending errors into ToolResult,
            // so reaching this branch means an unexpected throw — let it bubble up
            // after the rest of the parallel batch has finished.
            return { kind: "error", error: err };
          }
        }),
      );

      // Append tool-result messages for every settled handler in LLM-returned order.
      // Pending tools (HumanApprovalPendingError) do NOT get a tool-result here — their
      // result is appended on resume via the human-approval workflow. Appending the
      // siblings preserves their work; without this, a parallel batch like
      // [A(normal), B(requires approval)] would lose A's result on the continuation Turn.
      for (let i = 0; i < canonicalToolCalls.length; i++) {
        const tc = canonicalToolCalls[i];
        const entry = settled[i];
        if (entry.kind !== "result") continue;
        const toolResult = entry.result;

        // FR-CORE-007: Record the tool result as a non-system message
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

      // If any tool requires human approval, rethrow the first pending error in
      // LLM-returned order so the Turn loop can hand control to the approval flow.
      const firstPending = settled.find((s) => s.kind === "pending");
      if (firstPending && firstPending.kind === "pending") {
        throw firstPending.error;
      }
      const firstUnexpected = settled.find((s) => s.kind === "error");
      if (firstUnexpected && firstUnexpected.kind === "error") {
        throw firstUnexpected.error;
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

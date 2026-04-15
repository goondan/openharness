import type {
  StepContext,
  StepResult,
  LlmClient,
  AssistantModelMessage,
  ToolModelMessage,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { executeToolCall } from "./tool-call.js";

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
  }
): Promise<StepResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus } = deps;
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

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      for (const tc of llmResponse.toolCalls) {
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

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      for (const tc of llmResponse.toolCalls) {
        const toolCallCtx = {
          ...stepCtx,
          toolName: tc.toolName,
          toolArgs: tc.args,
        };

        const toolResult = await executeToolCall(tc.toolCallId, toolCallCtx, {
          toolRegistry,
          middlewareRegistry,
          eventBus,
        });

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
                  output:
                    toolResult.type === "text"
                      ? { type: "text", value: toolResult.text }
                      : toolResult.type === "json"
                        ? { type: "json", value: toolResult.data }
                        : { type: "error-text", value: toolResult.error },
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
          result: toolResult,
        });
      }
    }

    // f. Return StepResult
    return {
      text: llmResponse.text,
      toolCalls: toolCallResults,
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

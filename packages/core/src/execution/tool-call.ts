import type {
  ToolCallContext,
  ToolResult,
  ToolContext,
  HumanApprovalReferenceStore,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { normalizeToolArgs } from "../tool-args.js";

export class HumanApprovalPendingError extends Error {
  readonly humanApprovalId: string;

  constructor(humanApprovalId: string) {
    super(`Human Approval is waiting for human input: ${humanApprovalId}`);
    this.name = "HumanApprovalPendingError";
    this.humanApprovalId = humanApprovalId;
  }
}

export function isHumanApprovalPendingError(error: unknown): error is HumanApprovalPendingError {
  return error instanceof HumanApprovalPendingError || (
    error instanceof Error && error.name === "HumanApprovalPendingError"
  );
}

/**
 * Execute a single tool call with full middleware chain, validation, event emission.
 *
 * Flow:
 * 1. Emit tool.start
 * 2. Build toolCall middleware chain around core handler
 * 3. Core handler: validate args → if invalid return error → call tool handler → catch errors
 * 4. On success: emit tool.done
 * 5. On error thrown from middleware/handler: emit tool.error, return error result
 */
export async function executeToolCall(
  toolCallId: string,
  ctx: ToolCallContext,
  deps: {
    toolRegistry: ToolRegistry;
    middlewareRegistry: MiddlewareRegistry;
    eventBus: EventBus;
    humanApprovalStore?: HumanApprovalReferenceStore;
    skipHumanApproval?: boolean;
  }
): Promise<ToolResult> {
  const { toolRegistry, middlewareRegistry, eventBus, humanApprovalStore, skipHumanApproval } = deps;
  const { toolName, toolArgs, turnId, agentName, conversationId, stepNumber, abortSignal } = ctx;
  const normalizedToolArgs = normalizeToolArgs(toolArgs);
  const normalizedCtx: ToolCallContext = { ...ctx, toolArgs: normalizedToolArgs };

  // 1. Emit tool.start before building / running chain
  eventBus.emit("tool.start", {
    type: "tool.start",
    turnId,
    agentName,
    conversationId,
    stepNumber,
    toolCallId,
    toolName,
    args: normalizedToolArgs,
  });

  // 2. Core handler — the innermost logic run when all middleware has called next()
  const coreHandler = async (_ctx: ToolCallContext): Promise<ToolResult> => {
    // Check tool exists
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { type: "error", error: `Tool "${toolName}" not found` };
    }

    // Validate args via JSON Schema
    const validation = toolRegistry.validate(toolName, normalizedToolArgs);
    if (!validation.valid) {
      return { type: "error", error: `Invalid arguments: ${validation.errors}` };
    }

    const humanApproval = tool.humanApproval;
    if (!skipHumanApproval && humanApproval && humanApproval.required !== false) {
      if (!humanApprovalStore) {
        return { type: "error", error: `Tool "${toolName}" requires a Human Approval store` };
      }

      const created = await humanApprovalStore.createApproval({
        id: `${turnId}:${toolCallId}:humanApproval`,
        toolCall: {
          turnId,
          agentName,
          conversationId,
          stepNumber,
          toolCallId,
          toolName,
          toolArgs: normalizedToolArgs,
        },
        prompt: humanApproval.prompt,
        expectedResultSchema: humanApproval.responseSchema,
        tasks: (humanApproval.tasks?.length
          ? humanApproval.tasks.map((task, index) => ({
              humanTaskId: `${turnId}:${toolCallId}:task:${index + 1}`,
              taskType: task.taskType,
              title: task.title,
              prompt: task.prompt ?? humanApproval.prompt,
              required: task.required,
              responseSchema: task.responseSchema,
            }))
          : [{
              humanTaskId: `${turnId}:${toolCallId}:task:1`,
              taskType: "approval" as const,
              prompt: humanApproval.prompt,
              required: true,
              responseSchema: humanApproval.responseSchema,
            }]),
      });

      if (!created.duplicate) {
        eventBus.emit("humanApproval.created", {
          type: "humanApproval.created",
          humanApprovalId: created.approval.id,
          agentName,
          conversationId,
          turnId,
          toolCallId,
        });
        for (const task of created.tasks) {
          eventBus.emit("humanTask.created", {
            type: "humanTask.created",
            humanApprovalId: created.approval.id,
            humanTaskId: task.id,
            taskType: task.taskType,
            agentName,
            conversationId,
          });
        }
      }

      throw new HumanApprovalPendingError(created.approval.id);
    }

    // Build the simpler ToolContext that the handler receives
    const toolContext: ToolContext = {
      conversationId,
      agentName,
      abortSignal,
    };

    // Call the tool handler — errors propagate up
    return await tool.handler(normalizedToolArgs, toolContext);
  };

  // 3. Build the full middleware chain
  const chain = middlewareRegistry.buildChain<ToolCallContext, ToolResult>("toolCall", coreHandler);

  // 4. Run the chain, handling errors
  try {
    const result = await chain(normalizedCtx);

    // Emit tool.done on success
    eventBus.emit("tool.done", {
      type: "tool.done",
      turnId,
      agentName,
      conversationId,
      stepNumber,
      toolCallId,
      toolName,
      args: normalizedToolArgs,
      result,
    });

    return result;
  } catch (err) {
    if (isHumanApprovalPendingError(err)) {
      throw err;
    }
    const error = err instanceof Error ? err : new Error(String(err));

    // Emit tool.error on failure
    eventBus.emit("tool.error", {
      type: "tool.error",
      turnId,
      agentName,
      conversationId,
      stepNumber,
      toolCallId,
      toolName,
      args: normalizedToolArgs,
      error,
    });

    return { type: "error", error: error.message };
  }
}

import type { ToolCallContext, ToolResult, ToolContext } from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import type { HumanGateReferenceStore } from "../hitl/types.js";
import { normalizeToolArgs } from "../tool-args.js";

export class HumanGatePendingError extends Error {
  readonly humanGateId: string;

  constructor(humanGateId: string) {
    super(`Human Gate is waiting for human input: ${humanGateId}`);
    this.name = "HumanGatePendingError";
    this.humanGateId = humanGateId;
  }
}

export function isHumanGatePendingError(error: unknown): error is HumanGatePendingError {
  return error instanceof HumanGatePendingError || (
    error instanceof Error && error.name === "HumanGatePendingError"
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
    humanGateStore?: HumanGateReferenceStore;
  }
): Promise<ToolResult> {
  const { toolRegistry, middlewareRegistry, eventBus, humanGateStore } = deps;
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

    if (tool.humanGate && tool.humanGate.required !== false) {
      if (!humanGateStore) {
        return { type: "error", error: `Tool "${toolName}" requires a Human Gate store` };
      }

      const created = await humanGateStore.createGate({
        id: `${turnId}:${toolCallId}:humanGate`,
        humanGateId: `${turnId}:${toolCallId}:humanGate`,
        toolCall: {
          turnId,
          agentName,
          conversationId,
          stepNumber,
          toolCallId,
          toolName,
          toolArgs: normalizedToolArgs,
        },
        policy: tool.humanGate,
        prompt: tool.humanGate?.prompt,
        expectedResultSchema: tool.humanGate?.responseSchema,
        tasks: (tool.humanGate?.tasks?.length
          ? tool.humanGate.tasks.map((task, index) => ({
              humanTaskId: `${turnId}:${toolCallId}:task:${index + 1}`,
              type: task.type,
              taskType: task.type,
              title: task.title,
              prompt: task.prompt ?? tool.humanGate?.prompt,
              required: task.required,
              responseSchema: task.responseSchema,
            }))
          : [{
              humanTaskId: `${turnId}:${toolCallId}:task:1`,
              type: "approval" as const,
              taskType: "approval" as const,
              prompt: tool.humanGate?.prompt,
              required: true,
              responseSchema: tool.humanGate?.responseSchema,
            }]),
      });

      eventBus.emit("humanGate.created", {
        type: "humanGate.created",
        humanGateId: created.gate.id,
        agentName,
        conversationId,
        turnId,
        toolCallId,
      });
      for (const task of created.tasks) {
        eventBus.emit("humanTask.created", {
          type: "humanTask.created",
          humanGateId: created.gate.id,
          humanTaskId: task.id,
          taskType: task.taskType as "approval" | "text" | "form",
          agentName,
          conversationId,
        });
      }

      throw new HumanGatePendingError(created.gate.id);
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
    if (isHumanGatePendingError(err)) {
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

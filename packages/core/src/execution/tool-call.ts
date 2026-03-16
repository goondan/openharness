import type { ToolCallContext, ToolResult, ToolContext } from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";

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
  }
): Promise<ToolResult> {
  const { toolRegistry, middlewareRegistry, eventBus } = deps;
  const { toolName, toolArgs, turnId, agentName, conversationId, stepNumber, abortSignal } = ctx;

  // 1. Emit tool.start before building / running chain
  eventBus.emit("tool.start", {
    type: "tool.start",
    turnId,
    agentName,
    conversationId,
    stepNumber,
    toolCallId,
    toolName,
    args: toolArgs,
  });

  // 2. Core handler — the innermost logic run when all middleware has called next()
  const coreHandler = async (_ctx: ToolCallContext): Promise<ToolResult> => {
    // Check tool exists
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { type: "error", error: `Tool "${toolName}" not found` };
    }

    // Validate args via JSON Schema
    const validation = toolRegistry.validate(toolName, toolArgs);
    if (!validation.valid) {
      return { type: "error", error: `Invalid arguments: ${validation.errors}` };
    }

    // Build the simpler ToolContext that the handler receives
    const toolContext: ToolContext = {
      conversationId,
      agentName,
      abortSignal,
    };

    // Call the tool handler — errors propagate up
    return await tool.handler(toolArgs, toolContext);
  };

  // 3. Build the full middleware chain
  const chain = middlewareRegistry.buildChain<ToolCallContext, ToolResult>("toolCall", coreHandler);

  // 4. Run the chain, handling errors
  try {
    const result = await chain(ctx);

    // Emit tool.done on success
    eventBus.emit("tool.done", {
      type: "tool.done",
      turnId,
      agentName,
      conversationId,
      stepNumber,
      toolCallId,
      toolName,
      args: toolArgs,
      result,
    });

    return result;
  } catch (err) {
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
      args: toolArgs,
      error,
    });

    return { type: "error", error: error.message };
  }
}

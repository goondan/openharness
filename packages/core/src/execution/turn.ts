import type {
  TurnContext,
  TurnResult,
  StepContext,
  StepResult,
  StepSummary,
  InboundEnvelope,
  LlmClient,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import type { ConversationStateImpl } from "../conversation-state.js";
import type { ProcessTurnOptions } from "@goondan/openharness-types";
import { randomUUID } from "node:crypto";
import { executeStep } from "./step.js";

type ExecuteTurnOptions = ProcessTurnOptions & { turnId?: string };

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function generateTurnId(): string {
  return `turn-${randomUUID()}`;
}

function generateMessageId(): string {
  return `msg-${randomUUID()}`;
}

/**
 * Extract text from an InboundEnvelope's content parts.
 */
function extractText(envelope: InboundEnvelope): string {
  return envelope.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

// -----------------------------------------------------------------------
// executeTurn
// -----------------------------------------------------------------------

/**
 * Execute a full turn in the agentic loop.
 *
 * Flow (EXEC-TURN-01):
 * 1. Generate unique turnId
 * 2. Create AbortController
 * 3. Convert string input → InboundEnvelope if needed
 * 4. Set conversationState._turnActive = true
 * 5. FR-CORE-007: Append inbound message to conversation
 * 6. Emit turn.start
 * 7. Build turn middleware chain with core handler
 * 8. Core handler: loop Steps
 * 9. Set conversationState._turnActive = false
 * 10. Emit turn.done (or turn.error on exception)
 * 11. Return TurnResult
 */
export async function executeTurn(
  agentName: string,
  input: string | InboundEnvelope,
  options: ExecuteTurnOptions | undefined,
  deps: {
    llmClient: LlmClient;
    toolRegistry: ToolRegistry;
    middlewareRegistry: MiddlewareRegistry;
    eventBus: EventBus;
    conversationState: ConversationStateImpl;
    maxSteps: number;
    abortController?: AbortController;
  }
): Promise<TurnResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus, conversationState, maxSteps } =
    deps;

  // 1. Generate unique turnId
  const turnId = options?.turnId ?? generateTurnId();

  // 2. Determine conversationId
  const conversationId =
    options?.conversationId ??
    (typeof input !== "string" && input.conversationId ? input.conversationId : `conv-${turnId}`);

  // 3. Convert string input → InboundEnvelope if needed
  let envelope: InboundEnvelope;
  if (typeof input === "string") {
    envelope = {
      name: "text",
      content: [{ type: "text", text: input }],
      properties: {},
      source: {
        connector: "programmatic",
        connectionName: "programmatic",
        receivedAt: new Date().toISOString(),
      },
    };
  } else {
    envelope = input;
  }

  // Use external AbortController if provided, otherwise create a new one
  const abortController = deps.abortController ?? new AbortController();

  // Build TurnContext
  const turnCtx: TurnContext = {
    turnId,
    agentName,
    conversationId,
    conversation: conversationState,
    abortSignal: abortController.signal,
    input: envelope,
    llm: llmClient,
  };

  // 6. Emit turn.start
  eventBus.emit("turn.start", {
    type: "turn.start",
    turnId,
    agentName,
    conversationId,
  });

  // Core handler: the step loop
  const coreHandler = async (ctx: TurnContext): Promise<TurnResult> => {
    const steps: StepSummary[] = [];
    let lastStepResult: StepResult | undefined;

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      // Check abortSignal before each step
      if (ctx.abortSignal.aborted) {
        return {
          turnId,
          agentName,
          conversationId,
          status: "aborted",
          steps,
        };
      }

      const stepCtx: StepContext = {
        ...ctx,
        stepNumber,
      };

      lastStepResult = await executeStep(stepCtx, {
        llmClient,
        toolRegistry,
        middlewareRegistry,
        eventBus,
      });

      const stepSummary: StepSummary = {
        stepNumber,
        toolCalls: lastStepResult.toolCalls.map((tc) => ({
          toolName: tc.toolName,
          args: tc.args,
          result: tc.result,
        })),
        finishReason: lastStepResult.finishReason,
        rawFinishReason: lastStepResult.rawFinishReason,
      };
      steps.push(stepSummary);

      // If no tool calls → turn is done (text response)
      if (!lastStepResult.toolCalls || lastStepResult.toolCalls.length === 0) {
        return {
          turnId,
          agentName,
          conversationId,
          status: "completed",
          text: lastStepResult.text,
          finishReason: lastStepResult.finishReason,
          rawFinishReason: lastStepResult.rawFinishReason,
          steps,
        };
      }

      // Otherwise continue to the next step
    }

    // maxSteps reached
    return {
      turnId,
      agentName,
      conversationId,
      status: "maxStepsReached",
      text: lastStepResult?.text,
      finishReason: lastStepResult?.finishReason,
      rawFinishReason: lastStepResult?.rawFinishReason,
      steps,
    };
  };

  // 7. Build turn middleware chain with core handler
  const chain = middlewareRegistry.buildChain<TurnContext, TurnResult>("turn", coreHandler);

  // Execute the chain and handle errors
  let result: TurnResult;
  try {
    // 4. Set conversationState._turnActive = true (inside try so errors reset it)
    conversationState._turnActive = true;

    // 5. FR-CORE-007: Record inbound message as a non-system conversation event
    const text = extractText(envelope);
    conversationState.emit({
      type: "appendMessage",
      message: {
        id: generateMessageId(),
        data: {
          role: "user",
          content: text,
        },
        metadata: {
          __createdBy: "core",
        },
      },
    });

    result = await chain(turnCtx);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // Set turnActive to false
    conversationState._turnActive = false;

    // Check if this was an abort (AbortError from aborted signal)
    if (turnCtx.abortSignal.aborted || error.name === "AbortError") {
      eventBus.emit("turn.error", {
        type: "turn.error",
        turnId,
        agentName,
        conversationId,
        status: "aborted",
        error,
      });

      return {
        turnId,
        agentName,
        conversationId,
        status: "aborted",
        steps: [],
      };
    }

    // Emit turn.error
    eventBus.emit("turn.error", {
      type: "turn.error",
      turnId,
      agentName,
      conversationId,
      status: "error",
      error,
    });

    return {
      turnId,
      agentName,
      conversationId,
      status: "error",
      steps: [],
      error,
    };
  }

  // 9. Set conversationState._turnActive = false
  conversationState._turnActive = false;

  // 10. Emit turn.done
  eventBus.emit("turn.done", {
    type: "turn.done",
    turnId,
    agentName,
    conversationId,
    result,
  });

  // 11. Return TurnResult
  return result;
}

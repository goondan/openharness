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
import { executeStep } from "./step.js";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

let _idCounter = 0;

function generateTurnId(): string {
  return `turn-${++_idCounter}-${Date.now()}`;
}

function generateMessageId(): string {
  return `msg-${++_idCounter}-${Date.now()}`;
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
  options: ProcessTurnOptions | undefined,
  deps: {
    llmClient: LlmClient;
    toolRegistry: ToolRegistry;
    middlewareRegistry: MiddlewareRegistry;
    eventBus: EventBus;
    conversationState: ConversationStateImpl;
    maxSteps: number;
  }
): Promise<TurnResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus, conversationState, maxSteps } =
    deps;

  // 1. Generate unique turnId
  const turnId = generateTurnId();

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

  // Build TurnContext
  const turnCtx: TurnContext = {
    turnId,
    agentName,
    conversationId,
    conversation: conversationState,
    abortSignal: new AbortController().signal,
    input: envelope,
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

    // 5. FR-CORE-007: Append inbound message to conversation
    const text = extractText(envelope);
    conversationState.emit({
      type: "append",
      message: {
        id: generateMessageId(),
        role: "user",
        content: text,
      },
    });

    result = await chain(turnCtx);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // Set turnActive to false
    conversationState._turnActive = false;

    // Emit turn.error
    eventBus.emit("turn.error", {
      type: "turn.error",
      turnId,
      agentName,
      conversationId,
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

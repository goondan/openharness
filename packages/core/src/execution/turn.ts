import type {
  TurnContext,
  TurnResult,
  StepContext,
  StepResult,
  StepSummary,
  InboundEnvelope,
  LlmClient,
  LlmUsage,
  HitlStore,
  HitlLeaseGuard,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import type { ConversationStateImpl } from "../conversation-state.js";
import type { ProcessTurnOptions } from "@goondan/openharness-types";
import { randomUUID } from "node:crypto";
import { executeStep } from "./step.js";

type ExecuteTurnOptions = ProcessTurnOptions & { turnId?: string };

export interface TurnSteeringController {
  drain(): InboundEnvelope[];
  seal?(): void;
  peek?(): readonly InboundEnvelope[];
  ack?(count: number): void;
  close?(): void;
}

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

function appendEnvelopeAsUserMessage(
  conversationState: ConversationStateImpl,
  envelope: InboundEnvelope,
  metadata?: Record<string, unknown>,
): void {
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
        ...metadata,
      },
    },
  });
}

function appendSteeredInputs(
  conversationState: ConversationStateImpl,
  steering: TurnSteeringController | undefined,
): number {
  if (!steering) {
    return 0;
  }

  const inputs = steering.drain();
  for (const input of inputs) {
    appendEnvelopeAsUserMessage(conversationState, input, {
      __steered: true,
      __eventName: input.name,
    });
  }
  return inputs.length;
}

async function queueSteeredInputsForHitl(
  hitlStore: HitlStore | undefined,
  batchId: string | undefined,
  agentName: string,
  conversationId: string,
  steering: TurnSteeringController | undefined,
): Promise<number> {
  if (!hitlStore || !batchId || !steering) {
    return 0;
  }

  if (steering.peek && steering.ack) {
    steering.seal?.();
    const inputs = steering.peek();
    let queued = 0;
    for (const input of inputs) {
      await enqueueSteerWithRetry(hitlStore, batchId, agentName, conversationId, input);
      steering.ack(1);
      queued++;
    }
    return queued;
  }

  const inputs = steering.drain();
  let queued = 0;
  for (const input of inputs) {
    await enqueueSteerWithRetry(hitlStore, batchId, agentName, conversationId, input);
    queued++;
  }
  return queued;
}

async function enqueueSteerWithRetry(
  hitlStore: HitlStore,
  batchId: string,
  agentName: string,
  conversationId: string,
  input: InboundEnvelope,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await hitlStore.enqueueSteer(batchId, {
        source: "direct",
        input: {
          agentName,
          conversationId,
          content: input,
          options: {},
        },
        receivedAt: new Date().toISOString(),
        metadata: {
          envelopeName: input.name,
        },
      });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function closeSteering(steering: TurnSteeringController | undefined): void {
  steering?.close?.();
}

function addTokenCounts(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return a + b;
}

function addUsage(
  total: LlmUsage | undefined,
  usage: LlmUsage | undefined,
): LlmUsage | undefined {
  if (!usage) {
    return total;
  }
  if (!total) {
    return usage;
  }

  return {
    inputTokens: addTokenCounts(total.inputTokens, usage.inputTokens),
    outputTokens: addTokenCounts(total.outputTokens, usage.outputTokens),
    totalTokens: addTokenCounts(total.totalTokens, usage.totalTokens),
    inputTokenDetails: {
      cacheReadTokens: addTokenCounts(
        total.inputTokenDetails?.cacheReadTokens,
        usage.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: addTokenCounts(
        total.inputTokenDetails?.cacheWriteTokens,
        usage.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokenDetails: {
      reasoningTokens: addTokenCounts(
        total.outputTokenDetails?.reasoningTokens,
        usage.outputTokenDetails?.reasoningTokens,
      ),
    },
  };
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
    hitlStore?: HitlStore;
    abortController?: AbortController;
    steering?: TurnSteeringController;
  }
): Promise<TurnResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus, conversationState, maxSteps, hitlStore, steering } =
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
    let totalUsage: LlmUsage | undefined;

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      appendSteeredInputs(conversationState, steering);

      // Check abortSignal before each step
      if (ctx.abortSignal.aborted) {
        return {
          turnId,
          agentName,
          conversationId,
          status: "aborted",
          steps,
          ...(totalUsage ? { totalUsage } : {}),
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
        hitlStore,
      });

      const stepSummary: StepSummary = {
        stepNumber,
        toolCalls: lastStepResult.toolCalls.map((tc) => ({
          toolName: tc.toolName,
          args: tc.args,
          invalidReason: tc.invalidReason,
          result: tc.result,
        })),
        finishReason: lastStepResult.finishReason,
        rawFinishReason: lastStepResult.rawFinishReason,
        ...(lastStepResult.usage ? { usage: lastStepResult.usage } : {}),
      };
      steps.push(stepSummary);
      totalUsage = addUsage(totalUsage, lastStepResult.usage);

      if (lastStepResult.pendingHitlRequestIds && lastStepResult.pendingHitlRequestIds.length > 0) {
        await queueSteeredInputsForHitl(hitlStore, lastStepResult.pendingHitlBatchId, agentName, conversationId, steering);
        const waitingResult: TurnResult = {
          turnId,
          agentName,
          conversationId,
          status: "waitingForHuman",
          steps,
          ...(lastStepResult.pendingHitlBatchId ? { pendingHitlBatchId: lastStepResult.pendingHitlBatchId } : {}),
          pendingHitlRequestIds: lastStepResult.pendingHitlRequestIds,
          ...(totalUsage ? { totalUsage } : {}),
        };
        return waitingResult;
      }

      const steeredInputCount = appendSteeredInputs(conversationState, steering);

      // If no tool calls → turn is done (text response)
      if (!lastStepResult.toolCalls || lastStepResult.toolCalls.length === 0) {
        if (steeredInputCount > 0) {
          continue;
        }

        return {
          turnId,
          agentName,
          conversationId,
          status: "completed",
          text: lastStepResult.text,
          finishReason: lastStepResult.finishReason,
          rawFinishReason: lastStepResult.rawFinishReason,
          steps,
          ...(totalUsage ? { totalUsage } : {}),
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
      ...(totalUsage ? { totalUsage } : {}),
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
    appendEnvelopeAsUserMessage(conversationState, envelope);

    result = await chain(turnCtx);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // Set turnActive to false
    conversationState._turnActive = false;

    // Check if this was an abort (AbortError from aborted signal)
    if (turnCtx.abortSignal.aborted || error.name === "AbortError") {
      closeSteering(steering);
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
    closeSteering(steering);
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

  closeSteering(steering);

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

export async function executeContinuationTurn(
  agentName: string,
  options: { conversationId: string; turnId: string },
  deps: {
    llmClient: LlmClient;
    toolRegistry: ToolRegistry;
    middlewareRegistry: MiddlewareRegistry;
    eventBus: EventBus;
    conversationState: ConversationStateImpl;
    maxSteps: number;
    hitlStore?: HitlStore;
    abortController?: AbortController;
    steering?: TurnSteeringController;
    parentHitlBatch?: {
      batchId: string;
      guard: HitlLeaseGuard;
    };
  },
): Promise<TurnResult> {
  const { llmClient, toolRegistry, middlewareRegistry, eventBus, conversationState, maxSteps, hitlStore, steering } =
    deps;
  const { turnId, conversationId } = options;
  const abortController = deps.abortController ?? new AbortController();

  const turnCtx: TurnContext = {
    turnId,
    agentName,
    conversationId,
    conversation: conversationState,
    abortSignal: abortController.signal,
    input: {
      name: "hitl.resume",
      content: [],
      properties: {},
      conversationId,
      source: {
        connector: "hitl",
        connectionName: "hitl",
        receivedAt: new Date().toISOString(),
      },
    },
    llm: llmClient,
  };

  eventBus.emit("turn.start", {
    type: "turn.start",
    turnId,
    agentName,
    conversationId,
  });

  const coreHandler = async (activeTurnCtx: TurnContext): Promise<TurnResult> => {
    const steps: StepSummary[] = [];
    let lastStepResult: StepResult | undefined;
    let totalUsage: LlmUsage | undefined;

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      appendSteeredInputs(conversationState, steering);

      if (activeTurnCtx.abortSignal.aborted) {
        return {
          turnId,
          agentName,
          conversationId,
          status: "aborted",
          steps,
          ...(totalUsage ? { totalUsage } : {}),
        };
      }

      lastStepResult = await executeStep({ ...activeTurnCtx, stepNumber }, {
        llmClient,
        toolRegistry,
        middlewareRegistry,
        eventBus,
        hitlStore,
        parentHitlBatch: deps.parentHitlBatch,
      });

      const stepSummary: StepSummary = {
        stepNumber,
        toolCalls: lastStepResult.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
          result: tc.result,
        })),
        finishReason: lastStepResult.finishReason,
        rawFinishReason: lastStepResult.rawFinishReason,
        ...(lastStepResult.usage ? { usage: lastStepResult.usage } : {}),
      };
      steps.push(stepSummary);
      totalUsage = addUsage(totalUsage, lastStepResult.usage);

      if (lastStepResult.pendingHitlRequestIds && lastStepResult.pendingHitlRequestIds.length > 0) {
        await queueSteeredInputsForHitl(hitlStore, lastStepResult.pendingHitlBatchId, agentName, conversationId, steering);
        return {
          turnId,
          agentName,
          conversationId,
          status: "waitingForHuman",
          steps,
          ...(lastStepResult.pendingHitlBatchId ? { pendingHitlBatchId: lastStepResult.pendingHitlBatchId } : {}),
          pendingHitlRequestIds: lastStepResult.pendingHitlRequestIds,
          ...(totalUsage ? { totalUsage } : {}),
        };
      }

      const steeredInputCount = appendSteeredInputs(conversationState, steering);
      if (!lastStepResult.toolCalls || lastStepResult.toolCalls.length === 0) {
        if (steeredInputCount > 0) {
          continue;
        }
        return {
          turnId,
          agentName,
          conversationId,
          status: "completed",
          text: lastStepResult.text,
          finishReason: lastStepResult.finishReason,
          rawFinishReason: lastStepResult.rawFinishReason,
          steps,
          ...(totalUsage ? { totalUsage } : {}),
        };
      }
    }

    return {
      turnId,
      agentName,
      conversationId,
      status: "maxStepsReached",
      text: lastStepResult?.text,
      finishReason: lastStepResult?.finishReason,
      rawFinishReason: lastStepResult?.rawFinishReason,
      steps,
      ...(totalUsage ? { totalUsage } : {}),
    };
  };

  const chain = middlewareRegistry.buildChain<TurnContext, TurnResult>("turn", coreHandler);
  try {
    conversationState._turnActive = true;
    const result = await chain(turnCtx);
    conversationState._turnActive = false;
    closeSteering(steering);
    eventBus.emit("turn.done", {
      type: "turn.done",
      turnId,
      agentName,
      conversationId,
      result,
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    conversationState._turnActive = false;
    closeSteering(steering);
    eventBus.emit("turn.error", {
      type: "turn.error",
      turnId,
      agentName,
      conversationId,
      status: turnCtx.abortSignal.aborted || error.name === "AbortError" ? "aborted" : "error",
      error,
    });
    return {
      turnId,
      agentName,
      conversationId,
      status: turnCtx.abortSignal.aborted || error.name === "AbortError" ? "aborted" : "error",
      steps: [],
      error,
    };
  }
}

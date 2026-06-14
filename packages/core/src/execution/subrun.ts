import type {
  ExtensionStore,
  InboundEnvelope,
  LlmClient,
  LlmUsage,
  Message,
  MessageEvent,
  StepContext,
  StepResult,
  SubrunFn,
  SubrunOptions,
  SubrunResult,
  ToolDefinition,
  TurnContext,
} from "@goondan/openharness-types";
import { ToolRegistry } from "../tool-registry.js";
import { MiddlewareRegistry } from "../middleware-chain.js";
import { EventBus } from "../event-bus.js";
import type { ModelInputRegistry } from "../model-input.js";
import { createConversationState } from "../conversation-state.js";
import { executeStep } from "./step.js";
import { isHumanApprovalPendingError } from "./tool-call.js";
import { addUsage } from "./turn.js";

/**
 * The slice of the parent turn an ` extends-agent-config` sub-run needs to seed
 * its own context. We keep the parent's identity/store/input so the agent's
 * `useModelInput` projection behaves exactly as in the main turn.
 */
export interface SubrunParentContext {
  agentName: string;
  conversationId: string;
  turnId: string;
  store: ExtensionStore;
  input: InboundEnvelope;
  abortSignal: AbortSignal;
}

/** Agent-scoped dependencies the sub-run inherits (unless overridden). */
export interface SubrunDeps {
  llmClient: LlmClient;
  toolRegistry: ToolRegistry;
  modelInputRegistry: ModelInputRegistry;
}

/** Convert a seed message into the event that re-creates it on replay. */
function toSeedEvent(message: Message): MessageEvent {
  return message.data.role === "system"
    ? { type: "appendSystem", message: message as Extract<Message, { data: { role: "system" } }> }
    : { type: "appendMessage", message: message as Extract<Message, { data: { role: Exclude<Message["data"]["role"], "system"> } }> };
}

function toolRegistryFrom(tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

/**
 * Build the `ctx.subrun` capability for a turn/step/toolCall context.
 *
 * It runs a **bounded step loop** over a throwaway conversation seeded from the
 * caller's `messages`, inheriting the agent's model, tools and `useModelInput`
 * projection. It deliberately does NOT reuse `executeTurn` (that would re-enter
 * turn middleware/steering and, since compaction itself runs in step middleware,
 * recurse). It runs `executeStep` with an **empty middleware registry** (so no
 * `useStep` handler — including the compaction one that may have spawned it —
 * runs) and a **silent event bus** (so observers of the main turn aren't polluted
 * by sub-run step/tool events). The agent's `modelInputRegistry` IS passed, so
 * the projection assembles the system prompt etc. exactly as a normal step would.
 *
 * Nothing is written to the parent conversation.
 */
export function makeSubrun(parent: SubrunParentContext, deps: SubrunDeps): SubrunFn {
  const subrun: SubrunFn = async (
    messages: Message[],
    options?: SubrunOptions,
  ): Promise<SubrunResult> => {
    const maxSteps = options?.maxSteps ?? 1;
    const signal = options?.signal ?? parent.abortSignal;

    // Seed a throwaway conversation from the caller-given messages. This *is* the
    // non-persisting fork — the parent conversation is never touched.
    const conversation = createConversationState();
    conversation.restore(messages.map(toSeedEvent));

    const llmClient = options?.overrideModel ?? deps.llmClient;
    const toolRegistry = options?.overrideTools
      ? toolRegistryFrom(options.overrideTools)
      : deps.toolRegistry;

    // Sampling knobs are forwarded to the LLM call (e.g. prewarm's maxTokens:1).
    // `model` is intentionally not set here — overrideModel swaps the client itself.
    const llmChatOptions =
      options?.temperature !== undefined || options?.maxTokens !== undefined
        ? {
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          }
        : undefined;

    const subCtxBase: TurnContext = {
      turnId: parent.turnId,
      agentName: parent.agentName,
      conversationId: parent.conversationId,
      conversation,
      abortSignal: signal,
      input: parent.input,
      store: parent.store,
      subrun,
    };

    const stepDeps = {
      llmClient,
      toolRegistry,
      // Empty: no `useStep`/`useToolCall` middleware runs in a sub-run, so a
      // compaction sub-run cannot recurse into the compaction step middleware.
      middlewareRegistry: new MiddlewareRegistry(),
      // Silent: sub-run step/tool events never reach the main turn's observers.
      eventBus: new EventBus(),
      // Inherited: the agent's projection assembles the model input (system
      // prompt, media hydration, …) just like a normal step.
      modelInputRegistry: deps.modelInputRegistry,
      // Sub-runs do not block on human approval; tools execute directly.
      humanApprovalStore: undefined,
      // Forward the caller's sampling options (temperature/maxTokens) to the LLM.
      ...(llmChatOptions ? { llmChatOptions } : {}),
    };

    const steps: StepResult[] = [];
    let lastStep: StepResult | undefined;
    let totalUsage: LlmUsage | undefined;

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      if (signal.aborted) {
        return finalize("aborted", lastStep, steps, totalUsage);
      }

      const stepCtx: StepContext = { ...subCtxBase, stepNumber };

      try {
        lastStep = await executeStep(stepCtx, stepDeps);
      } catch (err) {
        if (isHumanApprovalPendingError(err)) {
          return finalize("waitingForHuman", lastStep, steps, totalUsage);
        }
        return {
          status: "error",
          steps,
          ...(lastStep?.text !== undefined ? { text: lastStep.text } : {}),
          ...(totalUsage ? { totalUsage } : {}),
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }

      steps.push(lastStep);
      totalUsage = addUsage(totalUsage, lastStep.usage);

      // No tool calls → the sub-run produced its text answer and is done.
      if (!lastStep.toolCalls || lastStep.toolCalls.length === 0) {
        return finalize("completed", lastStep, steps, totalUsage);
      }
    }

    return finalize("maxStepsReached", lastStep, steps, totalUsage);
  };

  return subrun;
}

function finalize(
  status: SubrunResult["status"],
  lastStep: StepResult | undefined,
  steps: StepResult[],
  totalUsage: LlmUsage | undefined,
): SubrunResult {
  return {
    status,
    steps,
    ...(lastStep?.text !== undefined ? { text: lastStep.text } : {}),
    ...(totalUsage ? { totalUsage } : {}),
  };
}

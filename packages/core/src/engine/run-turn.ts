import { Console } from "node:console";

import {
  isJsonObject,
  type AgentEvent,
  type AgentToolRuntime,
  type JsonObject,
  type JsonValue,
  type Message,
  type MessageEvent,
  type MiddlewareAgentsApi,
  type RuntimeContext,
  type StepResult,
  type ToolCallResult,
  type ToolCatalogItem,
  type TurnResult,
} from "../types.js";
import { ConversationStateImpl } from "../conversation/state.js";
import { PipelineRegistryImpl } from "../pipeline/registry.js";
import { createMinimalToolContext, type ToolExecutor } from "../tools/executor.js";
import type { ToolRegistryImpl } from "../tools/registry.js";
import { toConversationTurns } from "../runner/conversation-state.js";
import { buildMalformedToolCallRetryMessage, classifyModelStepRetryKind, requestModelMessage } from "../llm/model-step.js";

export interface StepLimitResponseInput {
  maxSteps: number;
  lastText: string;
}

export function buildStepLimitResponse(input: StepLimitResponseInput): string {
  const trimmedLastText = input.lastText.trim();
  return trimmedLastText.length > 0 ? trimmedLastText : `최대 step(${input.maxSteps})에 도달하여 응답을 마무리했습니다.`;
}

export interface RunTurnModelConfig {
  provider: string;
  apiKey: string;
  modelName: string;
  temperature: number;
  maxTokens: number;
}

export interface RunTurnInput {
  agentName: string;
  instanceKey: string;
  turnId: string;
  traceId: string;
  inputEvent: AgentEvent;
  conversationState: ConversationStateImpl;
  pipelineRegistry: PipelineRegistryImpl;
  agents: MiddlewareAgentsApi;
  runtime: RuntimeContext;

  model: RunTurnModelConfig;
  maxSteps: number;

  baseToolCatalog: ToolCatalogItem[];
  extensionToolRegistry?: ToolRegistryImpl;
  extensionToolExecutor?: ToolExecutor;
  toolExecutor: ToolExecutor;

  workdir: string;
  logger?: Console;
  toolRuntime?: AgentToolRuntime;

  stepLimitResponse?: (input: StepLimitResponseInput) => string;
  beforeEachStep?: () => void | Promise<void>;
}

export interface RunTurnOutput {
  turnResult: TurnResult;
  finalResponseText: string;
  stepCount: number;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergeToolCatalog(primary: ToolCatalogItem[], secondary: ToolCatalogItem[]): ToolCatalogItem[] {
  const merged = [...primary];
  for (const item of secondary) {
    if (!merged.some((existing) => existing.name === item.name)) {
      merged.push(item);
    }
  }
  return merged;
}

function ensureJsonObject(value: unknown): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }
  return {};
}

function cloneAsJsonObject(value: unknown): JsonObject {
  return ensureJsonObject(structuredClone(value));
}

function createConversationUserMessage(content: unknown, metadata?: Record<string, JsonValue>): Message {
  return {
    id: createId("msg"),
    data: { role: "user", content },
    metadata: metadata ?? {},
    createdAt: new Date(),
    source: { type: "user" },
  };
}

function createConversationAssistantMessage(content: unknown, stepId: string): Message {
  return {
    id: createId("msg"),
    data: { role: "assistant", content },
    metadata: {},
    createdAt: new Date(),
    source: { type: "assistant", stepId },
  };
}

function createToolContextMessage(content: string): Message {
  return {
    id: createId("msg"),
    data: { role: "user", content },
    metadata: {},
    createdAt: new Date(),
    source: { type: "user" },
  };
}

function readStringMetadata(metadata: Record<string, JsonValue>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function deriveFinalResponseText(
  conversationState: ConversationStateImpl,
  stepResult: StepResult,
  fallbackText: string,
): string {
  const explicit = readStringMetadata(stepResult.metadata, "opencode.finalResponseText");
  if (explicit !== undefined) {
    return explicit;
  }

  if (fallbackText.trim().length > 0) {
    return fallbackText;
  }

  const messages = conversationState.nextMessages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.data.role !== "assistant") {
      continue;
    }

    const content = message.data.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (isJsonObject(part) && part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
  const logger = input.logger ?? new Console({ stdout: process.stdout, stderr: process.stderr });
  const stepLimit = input.stepLimitResponse ?? buildStepLimitResponse;

  let finalResponseText = "";
  let step = 0;
  let lastText = "";
  const userInputText = input.inputEvent.input ?? "";

  const turnResult = await input.pipelineRegistry.runTurn(
    {
      agentName: input.agentName,
      instanceKey: input.instanceKey,
      turnId: input.turnId,
      traceId: input.traceId,
      inputEvent: input.inputEvent,
      conversationState: input.conversationState,
      agents: input.agents,
      runtime: input.runtime,
      emitMessageEvent(ev: MessageEvent): void {
        input.conversationState.emitMessageEvent(ev);
      },
      metadata: {},
    },
    async (): Promise<TurnResult> => {
      while (true) {
        if (input.beforeEachStep) {
          await input.beforeEachStep();
        }

        if (step >= input.maxSteps) {
          const responseText = stepLimit({ maxSteps: input.maxSteps, lastText });
          finalResponseText = responseText;
          return {
            turnId: input.turnId,
            finishReason: "max_steps",
            responseMessage: createConversationAssistantMessage(responseText, `${input.turnId}-step-limit`),
          };
        }

        step += 1;
        const extensionCatalog = input.extensionToolRegistry ? input.extensionToolRegistry.getCatalog() : [];
        const baseToolCatalog = mergeToolCatalog(input.baseToolCatalog, extensionCatalog);

        const stepMetadata: Record<string, JsonValue> = {};

        const stepResult = await input.pipelineRegistry.runStep(
          {
            agentName: input.agentName,
            instanceKey: input.instanceKey,
            turnId: input.turnId,
            traceId: input.traceId,
            turn: {
              id: input.turnId,
              agentName: input.agentName,
              inputEvent: input.inputEvent,
              messages: input.conversationState.nextMessages,
              steps: [],
              status: "running",
              metadata: {},
            },
            stepIndex: step,
            conversationState: input.conversationState,
            agents: input.agents,
            runtime: input.runtime,
            emitMessageEvent(ev: MessageEvent): void {
              input.conversationState.emitMessageEvent(ev);
            },
            toolCatalog: baseToolCatalog,
            metadata: stepMetadata,
          },
          async (stepCtx): Promise<StepResult> => {
            const response = await requestModelMessage({
              provider: input.model.provider,
              apiKey: input.model.apiKey,
              model: input.model.modelName,
              temperature: input.model.temperature,
              maxTokens: input.model.maxTokens,
              toolCatalog: stepCtx.toolCatalog,
              turns: toConversationTurns(input.conversationState.nextMessages),
            });

            if (response.assistantContent.length > 0) {
              input.conversationState.emitMessageEvent({
                type: "append",
                message: createConversationAssistantMessage(response.assistantContent, `${input.turnId}-step-${step}`),
              });
            }

            if (response.textBlocks.length > 0) {
              lastText = response.textBlocks.join("\n").trim();
            }

            const retryKind = classifyModelStepRetryKind({
              assistantContent: response.assistantContent,
              textBlocks: response.textBlocks,
              toolUseBlocks: response.toolUseBlocks,
              toolCallInputIssues: response.toolCallInputIssues,
              finishReason: response.finishReason,
            });
            if (retryKind !== undefined) {
              if (retryKind === "malformed_tool_calls") {
                input.conversationState.emitMessageEvent({
                  type: "append",
                  message: createConversationUserMessage(buildMalformedToolCallRetryMessage(response.toolCallInputIssues)),
                });
              } else {
                input.conversationState.emitMessageEvent({
                  type: "append",
                  message: createConversationUserMessage(
                    "직전 응답이 비어 있습니다. 다음 응답에서는 텍스트 또는 tool-call 중 최소 하나를 반드시 생성하세요.",
                  ),
                });
              }
              return {
                status: "completed",
                shouldContinue: true,
                toolCalls: [],
                toolResults: [],
                metadata: {},
              };
            }

            if (response.toolUseBlocks.length === 0) {
              return {
                status: "completed",
                shouldContinue: false,
                toolCalls: [],
                toolResults: [],
                metadata: {},
              };
            }

            const toolCalls: Array<{ id: string; name: string; args: JsonObject }> = [];
            const toolResults: ToolCallResult[] = [];

            for (const toolUse of response.toolUseBlocks) {
              const toolArgs = cloneAsJsonObject(toolUse.input);
              toolCalls.push({ id: toolUse.id, name: toolUse.name, args: toolArgs });

              const toolResult = await input.pipelineRegistry.runToolCall(
                {
                  agentName: input.agentName,
                  instanceKey: input.instanceKey,
                  turnId: input.turnId,
                  traceId: input.traceId,
                  stepIndex: step,
                  toolName: toolUse.name,
                  toolCallId: toolUse.id,
                  runtime: input.runtime,
                  args: toolArgs,
                  metadata: {},
                },
                async (toolCallCtx): Promise<ToolCallResult> => {
                  const toolContext = createMinimalToolContext({
                    agentName: input.agentName,
                    instanceKey: input.instanceKey,
                    turnId: input.turnId,
                    traceId: input.traceId,
                    toolCallId: toolCallCtx.toolCallId,
                    message: createToolContextMessage(userInputText),
                    workdir: input.workdir,
                    logger,
                    runtime: input.toolRuntime,
                  });

                  const executor =
                    input.extensionToolRegistry?.has(toolCallCtx.toolName) === true && input.extensionToolExecutor
                      ? input.extensionToolExecutor
                      : input.toolExecutor;

                  return executor.execute({
                    toolCallId: toolCallCtx.toolCallId,
                    toolName: toolCallCtx.toolName,
                    args: toolCallCtx.args,
                    catalog: stepCtx.toolCatalog,
                    context: toolContext,
                  });
                },
              );

              toolResults.push(toolResult);
            }

            const toolResultBlocks: unknown[] = toolResults.map((tr, idx) => ({
              type: "tool-result",
              toolCallId: toolCalls[idx]?.id,
              toolName: toolCalls[idx]?.name,
              output:
                tr.status === "ok"
                  ? {
                      type: "text",
                      value: typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output),
                    }
                  : { type: "text", value: tr.error?.message ?? "error" },
            }));

            input.conversationState.emitMessageEvent({
              type: "append",
              message: createConversationUserMessage(toolResultBlocks),
            });

            return {
              status: "completed",
              shouldContinue: true,
              toolCalls,
              toolResults,
              metadata: {},
            };
          },
        );

        if (stepResult.shouldContinue) {
          continue;
        }

        const responseText = deriveFinalResponseText(input.conversationState, stepResult, lastText);
        finalResponseText = responseText;
        return {
          turnId: input.turnId,
          finishReason: "text_response",
          responseMessage: createConversationAssistantMessage(responseText, `${input.turnId}-final`),
        };
      }
    },
  );

  return {
    turnResult,
    finalResponseText,
    stepCount: step,
  };
}

import type {
  JsonObject,
  JsonValue,
  Message,
  StepMiddlewareContext,
  StepResult,
  ToolCall,
  ToolCallResult,
  ToolCatalogItem,
  TurnMiddlewareContext,
  TurnProcessor,
  TurnProcessorContext,
  TurnResult,
} from "@goondan/openharness";
import type { ModelMessage } from "ai";

import { compactMessages, pruneMessages, shouldCompact } from "./compaction.js";
import { createStreamingStep } from "./llm.js";
import {
  createAssistantMessage,
  createUserMessage,
  extractAssistantText,
  normalizeUsageMetadata,
  readAssistantParts,
  replaceAssistantMessage,
  stringifyJson,
  toModelMessages,
} from "./messages.js";
import { PermissionDeniedError, PermissionRejectedError, requestPermission } from "./permission.js";
import { type AssistantPart, readToolPayload } from "./protocol.js";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots, type WorkspaceSnapshot } from "./snapshot.js";
import { filterToolCatalogForModel } from "./tool-catalog.js";

const DOOM_LOOP_THRESHOLD = 3;
const LLM_INPUT_PREVIEW_LIMIT = 1_000;

type BlockedReason = "doom_loop" | "permission";

interface AssistantAttemptResult {
  assistantMessage: Message;
  outcome: "continue" | "compact" | "stop";
  finalResponseText: string;
  stepCount: number;
  turnResult: TurnResult;
  lastStepTotalTokens?: number;
}

export const opencodeTurnProcessor: TurnProcessor = async (ctx) => {
  let finalResponseText = "";
  let stepCount = 0;
  let turnResult: TurnResult = {
    turnId: ctx.turnId,
    finishReason: "error",
    error: {
      message: "turn did not start",
      code: "E_TURN_NOT_STARTED",
    },
  };

  await ctx.runTurn(async (turnCtx) => {
    let attempt = 0;

    while (true) {
      attempt += 1;
      let assistantMessage = createAssistantMessage([], `${ctx.turnId}-assistant-${attempt}`);
      turnCtx.emitMessageEvent({
        type: "append",
        message: assistantMessage,
      });

      const attemptResult = await processAssistantAttempt({
        processorCtx: ctx,
        assistantMessage,
      });

      assistantMessage = attemptResult.assistantMessage;
      finalResponseText = attemptResult.finalResponseText;
      stepCount += attemptResult.stepCount;
      turnResult = attemptResult.turnResult;

      if (attemptResult.outcome !== "compact") {
        return turnResult;
      }

      const compactBaseMessages = turnCtx.conversationState.nextMessages.filter((message) => message.id !== assistantMessage.id);
      const replayCandidate = [...compactBaseMessages].reverse().find((message) => message.data.role === "user");
      const compacted = await compactMessages({
        provider: ctx.model.provider,
        apiKey: ctx.model.apiKey,
        modelName: ctx.model.modelName,
        baseMessages: compactBaseMessages,
        toolCatalog: ctx.resolveToolCatalog(),
      });

      if (!compacted.summaryText.trim()) {
        turnResult = {
          turnId: ctx.turnId,
          finishReason: "error",
          error: {
            message: "conversation compaction failed",
            code: "E_COMPACTION_FAILED",
          },
          responseMessage: assistantMessage,
        };
        finalResponseText = extractFinalAssistantText(assistantMessage);
        return turnResult;
      }

      rewriteConversation(turnCtx, compacted.compactedMessages);
      const replayAlreadyIncluded =
        replayCandidate !== undefined && compacted.compactedMessages.some((message) => message.id === replayCandidate.id);
      if (replayCandidate && !replayAlreadyIncluded) {
        turnCtx.emitMessageEvent({
          type: "append",
          message: {
            ...replayCandidate,
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date(),
            metadata: {
              ...replayCandidate.metadata,
              "__opencode.replay": true,
            },
          },
        });
      } else {
        turnCtx.emitMessageEvent({
          type: "append",
          message: createUserMessage(
            "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          ),
        });
      }
    }
  });

  return {
    turnResult,
    finalResponseText,
    stepCount,
  };
};

interface ProcessAssistantAttemptInput {
  processorCtx: TurnProcessorContext;
  assistantMessage: Message;
}

async function processAssistantAttempt(input: ProcessAssistantAttemptInput): Promise<AssistantAttemptResult> {
  const { processorCtx } = input;
  let assistantMessage = input.assistantMessage;
  let accumulatedStepCount = 0;
  let turnError: TurnResult["error"] | undefined;
  let turnFinishReason: TurnResult["finishReason"] = "text_response";
  let needsCompaction = false;
  let lastStepTotalTokens: number | undefined;
  let blockedReason: BlockedReason | undefined;

  while (accumulatedStepCount < processorCtx.maxSteps) {
    const stepIndex = accumulatedStepCount + 1;
    const fullToolCatalog = processorCtx.resolveToolCatalog();
    const toolCatalog = filterToolCatalogForModel(fullToolCatalog, processorCtx.model.modelName);
    const conversationMessages = processorCtx.conversationState.nextMessages.filter(
      (message) => message.id !== assistantMessage.id || readAssistantParts(assistantMessage).length > 0,
    );
    const modelMessages = await buildModelMessages({
      messages: pruneMessages([...conversationMessages]),
      toolCatalog: fullToolCatalog,
    });

    let stepBlockedReason: BlockedReason | undefined;
    let stepNeedsCompaction = false;

    let stepResult: StepResult;
    try {
      stepResult = await processorCtx.runStep(
        {
          stepIndex,
          toolCatalog,
          metadata: {
            "runtime.llmInputMessages": summarizeModelMessages(modelMessages),
          },
        },
        async (stepCtx) => {
          return processStreamingStep({
            stepCtx,
            processorCtx,
            assistantMessage,
            modelMessages,
            toolCatalog,
            fullToolCatalog,
            onAssistantMessage(nextMessage) {
              assistantMessage = nextMessage;
            },
            onBlocked(reason) {
              stepBlockedReason = reason;
            },
            onNeedsCompaction() {
              stepNeedsCompaction = true;
            },
          });
        },
      );
    } catch (error) {
      turnError = {
        message: error instanceof Error ? error.message : String(error),
        code: "E_STEP_FAILED",
      };
      turnFinishReason = "error";
      break;
    }

    accumulatedStepCount += 1;
    blockedReason ??= stepBlockedReason;
    needsCompaction ||= stepNeedsCompaction;
    lastStepTotalTokens = readTotalTokens(stepResult.metadata) ?? lastStepTotalTokens;

    if (
      !needsCompaction
      && shouldCompact({
        provider: processorCtx.model.provider,
        modelName: processorCtx.model.modelName,
        maxTokens: processorCtx.model.maxTokens,
        messages: [...processorCtx.conversationState.nextMessages],
        lastStepTotalTokens,
      })
    ) {
      needsCompaction = true;
    }

    if (stepResult.status === "failed") {
      turnError = {
        message: "streaming step failed",
        code: "E_STEP_FAILED",
      };
      turnFinishReason = "error";
      break;
    }

    if (needsCompaction) {
      break;
    }

    if (blockedReason) {
      turnError = {
        message: blockedReason === "doom_loop" ? "doom loop detected" : "tool execution blocked by permission flow",
        code: blockedReason === "doom_loop" ? "E_DOOM_LOOP" : "E_PERMISSION_REJECTED",
      };
      turnFinishReason = "error";
      break;
    }

    if (!stepResult.shouldContinue) {
      turnFinishReason = stepResult.toolCalls.length > 0 ? "max_steps" : "text_response";
      break;
    }
  }

  if (!needsCompaction && !turnError && accumulatedStepCount >= processorCtx.maxSteps) {
    turnFinishReason = "max_steps";
  }

  return {
    assistantMessage,
    outcome: needsCompaction ? "compact" : turnError ? "stop" : "continue",
    finalResponseText: extractFinalAssistantText(assistantMessage),
    stepCount: accumulatedStepCount,
    lastStepTotalTokens,
    turnResult: {
      turnId: processorCtx.turnId,
      finishReason: turnError ? "error" : turnFinishReason,
      error: turnError,
      responseMessage: assistantMessage,
    },
  };
}

interface ProcessStreamingStepInput {
  stepCtx: StepMiddlewareContext;
  processorCtx: TurnProcessorContext;
  assistantMessage: Message;
  modelMessages: ModelMessage[];
  toolCatalog: ToolCatalogItem[];
  fullToolCatalog: ToolCatalogItem[];
  onAssistantMessage(message: Message): void;
  onBlocked(reason: BlockedReason): void;
  onNeedsCompaction(): void;
}

async function processStreamingStep(input: ProcessStreamingStepInput): Promise<StepResult> {
  const {
    stepCtx,
    processorCtx,
    modelMessages,
    toolCatalog,
    fullToolCatalog,
    onAssistantMessage,
    onBlocked,
    onNeedsCompaction,
  } = input;

  let assistantMessage = input.assistantMessage;
  let snapshotBefore: WorkspaceSnapshot | undefined;
  let finishReason = "stop";
  let stepStatus: StepResult["status"] = "completed";
  let stepFinished = false;
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolCallResult[] = [];
  let stepMetadata: Record<string, JsonValue> = {};

  try {
    const stream = createStreamingStep({
      provider: processorCtx.model.provider,
      apiKey: processorCtx.model.apiKey,
      modelName: processorCtx.model.modelName,
      temperature: processorCtx.model.temperature,
      maxTokens: processorCtx.model.maxTokens,
      toolCatalog: fullToolCatalog,
      activeToolNames: toolCatalog.map((item) => item.name),
      messages: modelMessages,
      executeTool: async ({ toolName, toolCallId, args }) => {
        if (isDoomLoop(readAssistantParts(assistantMessage), toolName, args)) {
          try {
            await requestPermission({
              workdir: processorCtx.workdir,
              permission: "doom_loop",
              patterns: [toolName],
              always: [toolName],
              metadata: {
                tool: toolName,
                input: args,
              },
            });
          } catch (error) {
            if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
              onBlocked("permission");
              return {
                toolCallId,
                toolName,
                status: "error",
                error: {
                  name: error.name,
                  code: "E_PERMISSION_REJECTED",
                  message: error.message,
                  suggestion: "현재 상태를 요약하고 사용자에게 확인을 요청하세요.",
                },
              };
            }
            throw error;
          }
        }

        return processorCtx.runToolCall({
          stepIndex: stepCtx.stepIndex,
          toolName,
          toolCallId,
          args,
        });
      },
    });

    for await (const event of stream.fullStream) {
      switch (event.type) {
        case "start-step": {
          snapshotBefore = await captureWorkspaceSnapshot(processorCtx.workdir);
          assistantMessage = appendAssistantPart(stepCtx, assistantMessage, {
            type: "step-start",
            stepIndex: stepCtx.stepIndex,
            startedAt: new Date().toISOString(),
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "reasoning-start": {
          assistantMessage = appendAssistantPart(stepCtx, assistantMessage, {
            type: "reasoning",
            id: `reasoning-${event.id}`,
            text: "",
            state: "streaming",
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "reasoning-delta": {
          assistantMessage = mutateAssistantPart(stepCtx, assistantMessage, `reasoning-${event.id}`, (part) => {
            if (part.type !== "reasoning") {
              return part;
            }
            return {
              ...part,
              text: part.text + event.text,
            };
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "reasoning-end": {
          assistantMessage = mutateAssistantPart(stepCtx, assistantMessage, `reasoning-${event.id}`, (part) => {
            if (part.type !== "reasoning") {
              return part;
            }
            return {
              ...part,
              text: part.text.trimEnd(),
              state: "done",
            };
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "text-start": {
          assistantMessage = appendAssistantPart(stepCtx, assistantMessage, {
            type: "text",
            id: `text-${event.id}`,
            text: "",
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "text-delta": {
          assistantMessage = mutateAssistantPart(stepCtx, assistantMessage, `text-${event.id}`, (part) => {
            if (part.type !== "text") {
              return part;
            }
            return {
              ...part,
              text: part.text + event.text,
            };
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "text-end": {
          assistantMessage = mutateAssistantPart(stepCtx, assistantMessage, `text-${event.id}`, (part) => {
            if (part.type !== "text") {
              return part;
            }
            return {
              ...part,
              text: part.text.trimEnd(),
            };
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "tool-input-start": {
          assistantMessage = appendAssistantPart(stepCtx, assistantMessage, {
            type: "tool",
            tool: event.toolName,
            callID: event.id,
            state: {
              status: "pending",
              input: {},
              raw: "",
              time: {
                start: new Date().toISOString(),
              },
            },
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "tool-input-delta": {
          assistantMessage = mutateToolPart(stepCtx, assistantMessage, event.id, (part) => {
            if (part.state.status !== "pending") {
              return part;
            }
            return {
              ...part,
              state: {
                ...part.state,
                raw: `${part.state.raw ?? ""}${event.delta}`,
              },
            };
          });
          onAssistantMessage(assistantMessage);
          break;
        }
        case "tool-call": {
          toolCalls.push({
            id: event.toolCallId,
            name: event.toolName,
            args: ensureJsonObject(event.input),
          });

          assistantMessage = mutateToolPart(stepCtx, assistantMessage, event.toolCallId, (part) => ({
            ...part,
            tool: event.toolName,
            state: {
              status: "running",
              input: ensureJsonObject(event.input),
              raw: part.state.status === "pending" ? part.state.raw : undefined,
              time: {
                start: part.state.time.start ?? new Date().toISOString(),
              },
            },
          }));
          onAssistantMessage(assistantMessage);
          break;
        }
        case "tool-result": {
          const payload = readToolPayload(event.output);
          toolResults.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "ok",
            output: event.output,
          });

          assistantMessage = mutateToolPart(stepCtx, assistantMessage, event.toolCallId, (part) => ({
            ...part,
            tool: event.toolName,
            state: {
              status: "completed",
              input: ensureJsonObject(event.input),
              output: payload.output,
              title: payload.title,
              metadata: payload.metadata,
              attachments: payload.attachments,
              truncated: payload.truncated,
              outputPath: payload.outputPath,
              time: {
                start: part.state.time.start,
                end: new Date().toISOString(),
              },
            },
          }));
          onAssistantMessage(assistantMessage);
          break;
        }
        case "tool-error": {
          const error = toToolResultError(event.error);
          if (error.code === "E_DOOM_LOOP") {
            onBlocked("doom_loop");
          }
          if (error.code === "E_PERMISSION_REJECTED" || error.code === "E_PERMISSION_DENIED") {
            onBlocked("permission");
          }

          toolResults.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "error",
            error,
          });

          assistantMessage = mutateToolPart(stepCtx, assistantMessage, event.toolCallId, (part) => ({
            ...part,
            tool: event.toolName,
            state: {
              status: "error",
              input: ensureJsonObject(event.input),
              error: error.message,
              time: {
                start: part.state.time.start,
                end: new Date().toISOString(),
              },
            },
          }));
          onAssistantMessage(assistantMessage);
          break;
        }
        case "finish-step": {
          finishReason = event.finishReason;
          stepFinished = true;
          stepMetadata = {
            "runtime.tokenUsage": {
              promptTokens: event.usage.inputTokens ?? 0,
              completionTokens: event.usage.outputTokens ?? 0,
              totalTokens: event.usage.totalTokens ?? 0,
            },
            "opencode.finishReason": event.finishReason,
            "opencode.usage": normalizeUsageMetadata(event.usage),
          };
          assistantMessage = appendAssistantPart(stepCtx, assistantMessage, {
            type: "step-finish",
            stepIndex: stepCtx.stepIndex,
            finishReason: event.finishReason,
            finishedAt: new Date().toISOString(),
            usage: normalizeUsageMetadata(event.usage),
          });
          if (snapshotBefore) {
            assistantMessage = await appendPatchPart(stepCtx, assistantMessage, snapshotBefore, processorCtx.workdir);
          }
          onAssistantMessage(assistantMessage);
          break;
        }
        case "error": {
          if (isContextOverflowError(event.error)) {
            onNeedsCompaction();
            break;
          }
          throw event.error;
        }
        case "abort": {
          stepStatus = "failed";
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (isContextOverflowError(error)) {
      onNeedsCompaction();
    } else {
      stepStatus = "failed";
      throw error;
    }
  } finally {
    if (!stepFinished) {
      assistantMessage = appendAssistantPart(stepCtx, assistantMessage, {
        type: "step-finish",
        stepIndex: stepCtx.stepIndex,
        finishReason: "error",
        finishedAt: new Date().toISOString(),
      });
      if (snapshotBefore) {
        assistantMessage = await appendPatchPart(stepCtx, assistantMessage, snapshotBefore, processorCtx.workdir);
      }
      onAssistantMessage(assistantMessage);
    }

    assistantMessage = closeIncompleteToolParts(stepCtx, assistantMessage);
    onAssistantMessage(assistantMessage);
  }

  return {
    status: stepStatus,
    shouldContinue: finishReason === "tool-calls" && toolCalls.length > 0,
    toolCalls,
    toolResults,
    metadata: stepMetadata,
  };
}

async function buildModelMessages(input: {
  messages: Message[];
  toolCatalog: readonly ToolCatalogItem[];
}): Promise<ModelMessage[]> {
  return toModelMessages(input.messages, input.toolCatalog);
}

function summarizeModelMessages(messages: readonly ModelMessage[]): JsonValue[] {
  return messages.map((message) => ({
    role: message.role,
    content: truncatePreview(renderModelMessageContent(message.content), LLM_INPUT_PREVIEW_LIMIT),
  }));
}

function renderModelMessageContent(content: ModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stringifyJson(content);
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "reasoning") {
        return part.text;
      }
      if (part.type === "tool-call") {
        return `[tool-call ${part.toolName}] ${stringifyJson(part.input)}`;
      }
      if (part.type === "tool-result") {
        return `[tool-result ${part.toolName}] ${stringifyJson(part.output)}`;
      }
      if (part.type === "file") {
        return `[file ${part.mediaType}]`;
      }
      return stringifyJson(part);
    })
    .join("\n");
}

function truncatePreview(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function rewriteConversation(turnCtx: TurnMiddlewareContext, messages: readonly Message[]): void {
  turnCtx.emitMessageEvent({ type: "truncate" });
  for (const message of messages) {
    turnCtx.emitMessageEvent({
      type: "append",
      message,
    });
  }
}

function appendAssistantPart(stepCtx: StepMiddlewareContext, assistantMessage: Message, part: AssistantPart): Message {
  const nextMessage = replaceAssistantMessage(assistantMessage, [...readAssistantParts(assistantMessage), part]);
  stepCtx.emitMessageEvent({
    type: "replace",
    targetId: assistantMessage.id,
    message: nextMessage,
  });
  return nextMessage;
}

function mutateAssistantPart(
  stepCtx: StepMiddlewareContext,
  assistantMessage: Message,
  partId: string,
  updater: (part: AssistantPart) => AssistantPart,
): Message {
  const nextParts = readAssistantParts(assistantMessage).map((part) => ("id" in part && part.id === partId ? updater(part) : part));
  const nextMessage = replaceAssistantMessage(assistantMessage, nextParts);
  stepCtx.emitMessageEvent({
    type: "replace",
    targetId: assistantMessage.id,
    message: nextMessage,
  });
  return nextMessage;
}

function mutateToolPart(
  stepCtx: StepMiddlewareContext,
  assistantMessage: Message,
  toolCallId: string,
  updater: (part: Extract<AssistantPart, { type: "tool" }>) => Extract<AssistantPart, { type: "tool" }>,
): Message {
  const nextParts = readAssistantParts(assistantMessage).map((part) => {
    if (part.type !== "tool" || part.callID !== toolCallId) {
      return part;
    }
    return updater(part);
  });

  const nextMessage = replaceAssistantMessage(assistantMessage, nextParts);
  stepCtx.emitMessageEvent({
    type: "replace",
    targetId: assistantMessage.id,
    message: nextMessage,
  });
  return nextMessage;
}

async function appendPatchPart(
  stepCtx: StepMiddlewareContext,
  assistantMessage: Message,
  snapshotBefore: WorkspaceSnapshot,
  workdir: string,
): Promise<Message> {
  const patch = diffWorkspaceSnapshots(snapshotBefore, await captureWorkspaceSnapshot(workdir));
  if (patch.files.length === 0) {
    return assistantMessage;
  }
  return appendAssistantPart(stepCtx, assistantMessage, {
    type: "patch",
    files: patch.files,
    hash: patch.hash,
  });
}

function closeIncompleteToolParts(stepCtx: StepMiddlewareContext, assistantMessage: Message): Message {
  const nextParts = readAssistantParts(assistantMessage).map((part) => {
    if (part.type !== "tool") {
      return part;
    }
    if (part.state.status === "completed" || part.state.status === "error") {
      return part;
    }
    return {
      ...part,
      state: {
        status: "error" as const,
        input: part.state.input,
        error: "Tool execution aborted",
        time: {
          start: part.state.time.start,
          end: new Date().toISOString(),
        },
      },
    };
  });

  const nextMessage = replaceAssistantMessage(assistantMessage, nextParts);
  stepCtx.emitMessageEvent({
    type: "replace",
    targetId: assistantMessage.id,
    message: nextMessage,
  });
  return nextMessage;
}

function ensureJsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function readTotalTokens(metadata: Record<string, JsonValue>): number | undefined {
  const tokenUsage = metadata["runtime.tokenUsage"];
  if (typeof tokenUsage !== "object" || tokenUsage === null || Array.isArray(tokenUsage)) {
    return undefined;
  }
  const totalTokens = (tokenUsage as Record<string, unknown>).totalTokens;
  return typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : undefined;
}

function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context|too large|too long|maximum context|input is too long|token/i.test(message);
}

function extractFinalAssistantText(message: Message): string {
  const parts = readAssistantParts(message);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "text" && part.text.trim().length > 0) {
      return part.text.trim();
    }
  }
  return extractAssistantText(message.data.content);
}

function isDoomLoop(parts: readonly AssistantPart[], toolName: string, args: JsonObject): boolean {
  const signature = JSON.stringify(args);
  const recent = parts
    .filter((part): part is Extract<AssistantPart, { type: "tool" }> => part.type === "tool" && part.state.status !== "pending")
    .slice(-DOOM_LOOP_THRESHOLD);

  return (
    recent.length >= DOOM_LOOP_THRESHOLD
    && recent.every((part) => part.tool === toolName && JSON.stringify(part.state.input) === signature)
  );
}

function toToolResultError(error: unknown): { message: string; code?: string; suggestion?: string } {
  if (error instanceof Error) {
    const code = typeof Reflect.get(error, "code") === "string" ? (Reflect.get(error, "code") as string) : undefined;
    const suggestion =
      typeof Reflect.get(error, "suggestion") === "string" ? (Reflect.get(error, "suggestion") as string) : undefined;
    return {
      message: error.message,
      code,
      suggestion,
    };
  }
  return {
    message: String(error),
  };
}

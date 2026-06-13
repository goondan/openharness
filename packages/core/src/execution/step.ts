import { randomUUID } from "node:crypto";
import type {
  StepContext,
  StepResult,
  LlmClient,
  AssistantModelMessage,
  ToolModelMessage,
  ToolResult,
  HumanApprovalReferenceStore,
  ToolCallContext,
  JsonObject,
  NonSystemMessage,
} from "@goondan/openharness-types";
import type { ToolRegistry } from "../tool-registry.js";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import type { ModelInputRegistry } from "../model-input.js";
import type { WrapCtxFor } from "./store-injection.js";
import {
  executeToolCall,
  isHumanApprovalPendingError,
  probeHumanApprovalGate,
  type HumanApprovalGateProbeResult,
} from "./tool-call.js";
import { normalizeToolArgsResult } from "../tool-args.js";
import { createMessage, CORE_CREATED_BY } from "@goondan/openharness-types";

// ─── XML invoke recovery ──────────────────────────────────────────────────────
// Some models, instead of emitting a real tool call, write the call out as an
// XML-style block inside their text response:
//
//   call <invoke name="bash"><parameter name="command">["node","--version"]</parameter></invoke>
//
// When that happens the model returns text but no `toolCalls`, so the harness
// would otherwise just record the assistant text and stop. The functions below
// let us detect such blocks, surface them as canonical tool calls, and strip
// the raw block from the assistant text so it isn't persisted to history.

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g,
    (entity, decimal?: string, hex?: string) => {
      if (decimal) {
        const cp = Number.parseInt(decimal, 10);
        return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff
          ? String.fromCodePoint(cp)
          : entity;
      }
      if (hex) {
        const cp = Number.parseInt(hex, 16);
        return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff
          ? String.fromCodePoint(cp)
          : entity;
      }
      switch (entity) {
        case "&amp;":
          return "&";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        default:
          return entity;
      }
    },
  );
}

function readXmlAttribute(attributes: string, name: string): string | null {
  const pattern = /\b([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1] === name) {
      return decodeXmlEntities(match[2] ?? match[3] ?? "");
    }
  }
  return null;
}

function parseXmlParameterValue(raw: string): unknown {
  const value = decodeXmlEntities(raw.trim());
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Compute byte ranges in `text` that should be treated as code (so any
 * `<invoke>` block inside them is descriptive markup, not an execution
 * request). Without this guard, a model that explains tool call syntax —
 * e.g. ``` ```Use <invoke name="bash">…</invoke> to call``` ``` — would
 * actually invoke `bash`.
 *
 * We exclude:
 *   - Fenced code blocks with any fence length >= 3 (``` / ~~~ / `````` / etc.)
 *     The closing fence must be the same character & length as the opening one
 *     (standard CommonMark) so that a long fence can intentionally contain a
 *     short fence as a literal example.
 *   - Inline code spans (`…`).
 *
 * 4-space / tab indented code blocks are handled separately on a per-match
 * basis (see `isInsideIndentedCodeLine`) because their boundaries are
 * line-anchored rather than range-delimited.
 */
function collectCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Fenced code blocks. Backreference \1 forces the closing fence to be the
  // same character sequence as the opening one, so a long fence can wrap a
  // shorter fence as an example.
  const fencePattern = /(?<=^|\n)([`~]{3,})[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g;
  for (const m of text.matchAll(fencePattern)) {
    if (m.index === undefined) continue;
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline code spans.
  const inlinePattern = /`[^`\n]+`/g;
  for (const m of text.matchAll(inlinePattern)) {
    if (m.index === undefined) continue;
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInsideAnyRange(index: number, ranges: ReadonlyArray<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Returns true when `index` sits on a line whose leading whitespace is at
 * least one tab or four spaces — the CommonMark threshold for an indented
 * code block. We deliberately err toward false-positives (treating heavily
 * indented invoke markup as code) because the canonical recovery target
 * starts at column 0 inside the assistant message, not deeply indented.
 */
function isInsideIndentedCodeLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  if (lineStart === index) return false;
  // Look at the leading run of whitespace on this line.
  let spaces = 0;
  for (let i = lineStart; i < index; i += 1) {
    const ch = text[i];
    if (ch === "\t") return true;
    if (ch === " ") {
      spaces += 1;
      if (spaces >= 4) return true;
      continue;
    }
    break;
  }
  return false;
}

function parseXmlInvokeBlocks(
  text: string,
): Array<{ toolName: string; args: Record<string, unknown>; start: number; end: number }> {
  const invokePattern = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
  const paramPattern = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
  const codeRanges = collectCodeRanges(text);
  const result: Array<{
    toolName: string;
    args: Record<string, unknown>;
    start: number;
    end: number;
  }> = [];

  for (const m of text.matchAll(invokePattern)) {
    if (m.index === undefined) continue;
    if (isInsideAnyRange(m.index, codeRanges)) continue;
    if (isInsideIndentedCodeLine(text, m.index)) continue;

    const toolName = readXmlAttribute(m[1] ?? "", "name");
    if (!toolName) continue;

    const args: Record<string, unknown> = {};
    for (const p of (m[2] ?? "").matchAll(paramPattern)) {
      const paramName = readXmlAttribute(p[1] ?? "", "name");
      if (paramName) {
        args[paramName] = parseXmlParameterValue(p[2] ?? "");
      }
    }
    result.push({ toolName, args, start: m.index, end: m.index + m[0].length });
  }
  return result;
}

/**
 * Remove the exact byte ranges occupied by parsed (i.e. actually-executed)
 * `<invoke>` blocks, preserving everything else verbatim — including
 * surrounding whitespace, newlines, and any `<invoke>` blocks that lived
 * inside code spans (those were never executed, so they stay in the text).
 */
function removeParsedInvokeBlocks(
  text: string,
  parsed: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (parsed.length === 0) return text;
  // Sort by start so we walk through `text` once. Ranges from
  // `parseXmlInvokeBlocks` are already in order because `matchAll` yields
  // matches in source order, but sort defensively.
  const sorted = [...parsed].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const { start, end } of sorted) {
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

type ToolResultContentPart = Extract<ToolModelMessage["content"][number], { type: "tool-result" }>;
type HumanApprovalGateProbeErrorResult = Extract<HumanApprovalGateProbeResult, { status: "error" }>;
type ExecutedToolCallResult = {
  result: ToolResult;
  args: JsonObject;
};

function toToolResultOutput(toolResult: ToolResult) {
  return toolResult.type === "text"
    ? { type: "text" as const, value: toolResult.text }
    : toolResult.type === "json"
      ? { type: "json" as const, value: toolResult.data }
      : toolResult.type === "content"
        ? { type: "content" as const, value: toolResult.content }
        : { type: "error-text" as const, value: toolResult.error };
}

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
 *    e. If LLM response has tool calls: execute them via executeToolCall and
 *       append one ordered tool message for the committed tool-call batch.
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
    modelInputRegistry: ModelInputRegistry;
    humanApprovalStore?: HumanApprovalReferenceStore;
    /** Per-layer ctx.store injection for the step chain. */
    storeWrapCtxFor?: WrapCtxFor<StepContext>;
    /** Per-layer ctx.store injection for the toolCall chains spawned by this step. */
    storeWrapCtxForToolCall?: WrapCtxFor<ToolCallContext>;
  }
): Promise<StepResult> {
  const {
    llmClient,
    toolRegistry,
    middlewareRegistry,
    eventBus,
    modelInputRegistry,
    humanApprovalStore,
    storeWrapCtxFor,
    storeWrapCtxForToolCall,
  } = deps;
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
    // a. Assemble the model input. The conversation event log is durable truth;
    //    `useModelInput` projects a per-step, throwaway view of it (windowing,
    //    hydration, redaction) immediately before the model call. It runs once,
    //    is pure with respect to durable state, and never touches `conversation`.
    const base = stepCtx.conversation.getMessages();
    const messages = modelInputRegistry.isEmpty
      ? [...base]
      : [...(await modelInputRegistry.apply(base, stepCtx))];

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

    const canonicalToolCalls =
      llmResponse.toolCalls?.map((tc) => {
        const normalized = normalizeToolArgsResult(tc.args);
        const invalidReason = tc.invalidReason ?? (normalized.ok ? undefined : normalized.error);
        const malformedResult: ToolResult | undefined = invalidReason
          ? {
              type: "error",
              error: invalidReason,
            }
          : undefined;

        return {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: normalized.args,
          invalidReason,
          malformedResult,
        };
      }) ?? [];

    // FR-CORE-007 (xml-invoke recovery): if the model produced no real tool
    // calls but its text contains <invoke> blocks, parse them and surface the
    // calls so the rest of the step (middleware, tool execution, persistence)
    // treats them like first-class tool calls. We only run recovery when the
    // canonical list is empty so we never override a provider that did return
    // real tool calls.
    const parsedInvokes =
      canonicalToolCalls.length === 0 && llmResponse.text
        ? parseXmlInvokeBlocks(llmResponse.text)
        : [];
    const hadInvokeBlocks = parsedInvokes.length > 0;
    for (const block of parsedInvokes) {
      const normalized = normalizeToolArgsResult(block.args);
      const invalidReason = normalized.ok ? undefined : normalized.error;
      const malformedResult: ToolResult | undefined = invalidReason
        ? {
            type: "error",
            error: invalidReason,
          }
        : undefined;

      canonicalToolCalls.push({
        toolCallId: `xml-invoke-${randomUUID()}`,
        toolName: block.toolName,
        args: normalized.args,
        invalidReason,
        malformedResult,
      });
    }

    // Persist assistant text. When invoke recovery rewrote calls out of the
    // text, strip only the exact byte ranges of the parsed <invoke> blocks
    // (preserving surrounding whitespace, newlines, and any <invoke> blocks
    // that lived inside code spans). Otherwise preserve the original text
    // byte-for-byte.
    const assistantText = hadInvokeBlocks
      ? removeParsedInvokeBlocks(llmResponse.text ?? "", parsedInvokes)
      : llmResponse.text;
    if (assistantText) {
      assistantContent.push({ type: "text", text: assistantText });
    }

    const isHumanApprovalPreflightCandidate = (tc: (typeof canonicalToolCalls)[number]) => {
      if (tc.malformedResult) return false;
      if (!humanApprovalStore) return false;
      const tool = toolRegistry.get(tc.toolName);
      if (!tool?.humanApproval || tool.humanApproval.required === false) return false;
      return true;
    };

    const humanApprovalToolCallIndexes = canonicalToolCalls.flatMap((tc, index) =>
      isHumanApprovalPreflightCandidate(tc) ? [index] : []
    );

    const assistantMessageId = `assistant-${stepCtx.turnId}-${stepCtx.stepNumber}`;
    const buildAssistantMessage = (committedToolCalls: typeof canonicalToolCalls): NonSystemMessage | undefined => {
      const committedAssistantContent = [...assistantContent];
      for (const tc of committedToolCalls) {
        committedAssistantContent.push({
          type: "tool-call",
          toolName: tc.toolName,
          input: tc.args,
          toolCallId: tc.toolCallId,
        });
      }

      if (committedAssistantContent.length === 0) {
        return undefined;
      }

      return createMessage<AssistantModelMessage>({
        id: assistantMessageId,
        data: {
          role: "assistant",
          content: committedAssistantContent,
        },
        createdBy: CORE_CREATED_BY,
      });
    };

    const appendAssistantMessage = (committedToolCalls: typeof canonicalToolCalls) => {
      const message = buildAssistantMessage(committedToolCalls);
      if (message) {
        stepCtx.conversation.append({
          type: "appendMessage",
          message,
        });
      }
    };

    const replaceAssistantMessage = (committedToolCalls: typeof canonicalToolCalls) => {
      const message = buildAssistantMessage(committedToolCalls);
      if (message) {
        stepCtx.conversation.append({
          type: "replace",
          messageId: assistantMessageId,
          message,
        });
      }
    };
    const emitSuppressedToolCalls = (committedToolCall: (typeof canonicalToolCalls)[number]) => {
      const suppressedToolCalls = canonicalToolCalls.filter((tc) => tc.toolCallId !== committedToolCall.toolCallId);
      if (suppressedToolCalls.length === 0) {
        return;
      }

      eventBus.emit("step.toolCallsSuppressed", {
        type: "step.toolCallsSuppressed",
        turnId,
        agentName,
        conversationId,
        stepNumber,
        reason: "humanApprovalBarrier",
        committedToolCallId: committedToolCall.toolCallId,
        suppressedToolCalls: suppressedToolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
        })),
      });
    };

    const appendSingleAssistantToolCall = (tc: (typeof canonicalToolCalls)[number]) => {
      appendAssistantMessage([tc]);
    };

    const appendAllAssistantToolCalls = () => {
      appendAssistantMessage(canonicalToolCalls);
    };

    const appendTextOnlyAssistantMessage = () => {
      appendAssistantMessage([]);
    };

    if (canonicalToolCalls.length === 0) {
      appendTextOnlyAssistantMessage();
    }

    // e. Execute committed tool calls (EXEC-CONST-003).
    //    - If ANY tool in the LLM-returned batch can open a humanApproval gate,
    //      only the first approval tool call is committed to the model history.
    //      Sibling tool calls are explicitly surfaced through step.toolCallsSuppressed
    //      and are not recorded because a pending approval cannot emit a same-step
    //      result, and provider adapters require the next tool message to answer
    //      the immediately previous assistant tool-call batch.
    //    - Otherwise execute all handlers in parallel. Result/appendMessage order still
    //      follows the LLM-returned tool call order.
    const toolCallResults: StepResult["toolCalls"] = [];
    const pendingToolResultParts: ToolResultContentPart[] = [];

    const emitMalformedEvents = (tc: (typeof canonicalToolCalls)[number]) => {
      eventBus.emit("tool.start", {
        type: "tool.start",
        turnId,
        agentName,
        conversationId,
        stepNumber,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      });
      // biome-ignore lint/style/noNonNullAssertion: only called when malformedResult exists
      const result = tc.malformedResult!;
      eventBus.emit("tool.done", {
        type: "tool.done",
        turnId,
        agentName,
        conversationId,
        stepNumber,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        result,
      });
    };

    const recordToolResult = (
      tc: (typeof canonicalToolCalls)[number],
      executed: ExecutedToolCallResult,
    ) => {
      const toolResult = executed.result;
      pendingToolResultParts.push({
        type: "tool-result",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: toToolResultOutput(toolResult),
      });
      toolCallResults.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: executed.args,
        ...(tc.invalidReason ? { invalidReason: tc.invalidReason } : {}),
        result: toolResult,
      });
    };

    const appendPendingToolResultMessage = () => {
      if (pendingToolResultParts.length === 0) {
        return;
      }

      const firstToolCallId = pendingToolResultParts[0]?.toolCallId;
      stepCtx.conversation.append({
        type: "appendMessage",
        message: createMessage<ToolModelMessage>({
          id: pendingToolResultParts.length === 1 && firstToolCallId
            ? `tool-result-${firstToolCallId}`
            : `tool-results-${stepCtx.turnId}-${stepCtx.stepNumber}`,
          data: {
            role: "tool",
            content: [...pendingToolResultParts],
          },
          createdBy: CORE_CREATED_BY,
        }),
      });
      pendingToolResultParts.length = 0;
    };

    const executeCanonicalToolCall = async (
      tc: (typeof canonicalToolCalls)[number],
    ): Promise<ExecutedToolCallResult> => {
      if (tc.malformedResult) {
        emitMalformedEvents(tc);
        return { result: tc.malformedResult, args: tc.args };
      }
      let effectiveArgs = tc.args;

      const toolCallCtx = {
        ...stepCtx,
        toolName: tc.toolName,
        toolArgs: tc.args,
      };

      const result = await executeToolCall(tc.toolCallId, toolCallCtx, {
        toolRegistry,
        middlewareRegistry,
        eventBus,
        humanApprovalStore,
        storeWrapCtxFor: storeWrapCtxForToolCall,
        onToolArgsResolved: (toolArgs) => {
          effectiveArgs = toolArgs;
        },
      });
      return { result, args: effectiveArgs };
    };

    const executeProbedToolResult = async (
      tc: (typeof canonicalToolCalls)[number],
      probeResult: HumanApprovalGateProbeErrorResult,
    ): Promise<ExecutedToolCallResult> => {
      const probedResult = probeResult.result;
      const eventArgs = probeResult.toolArgs ?? tc.args;
      const toolCallCtx: ToolCallContext = {
        ...stepCtx,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        toolArgs: eventArgs,
      };

      eventBus.emit("tool.start", {
        type: "tool.start",
        turnId,
        agentName,
        conversationId,
        stepNumber,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: eventArgs,
      });

      const runProbedResult = probeResult.middlewareApplied
        ? async () => probedResult
        : middlewareRegistry.buildChain<ToolCallContext, ToolResult>(
            "toolCall",
            async () => probedResult,
            storeWrapCtxForToolCall ? { wrapCtxFor: storeWrapCtxForToolCall } : undefined,
          );

      try {
        const result = await runProbedResult(toolCallCtx);
        eventBus.emit("tool.done", {
          type: "tool.done",
          turnId,
          agentName,
          conversationId,
          stepNumber,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: eventArgs,
          result,
        });
        return { result, args: eventArgs };
      } catch (err) {
        if (isHumanApprovalPendingError(err)) {
          throw err;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        eventBus.emit("tool.error", {
          type: "tool.error",
          turnId,
          agentName,
          conversationId,
          stepNumber,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: eventArgs,
          error,
        });
        return { result: { type: "error", error: error.message }, args: eventArgs };
      }
    };

    const recordSettledToolCalls = (
      toolCalls: typeof canonicalToolCalls,
      settled: readonly PromiseSettledResult<ExecutedToolCallResult>[],
    ) => {
      replaceAssistantMessage(toolCalls.map((tc, index) => {
        const entry = settled[index];
        return entry?.status === "fulfilled" ? { ...tc, args: entry.value.args } : tc;
      }));

      // Append fulfilled results in LLM-returned order.
      for (let i = 0; i < toolCalls.length; i++) {
        const entry = settled[i];
        if (entry.status === "fulfilled") {
          recordToolResult(toolCalls[i], entry.value);
        }
      }
      appendPendingToolResultMessage();

      // Surface the first error (HITL pending or unexpected) in LLM order.
      for (const entry of settled) {
        if (entry.status === "rejected") {
          throw entry.reason;
        }
      }
    };

    if (canonicalToolCalls.length > 0) {
      if (humanApprovalToolCallIndexes.length > 0) {
        // Probe declared approval candidates in LLM order before committing the
        // assistant batch. The probe runs toolCall middleware so pre-tool argument
        // rewrites are reflected in approval snapshots, but it still does not run
        // the tool handler because any candidate may later become a suppressed
        // sibling if another approval call reaches pending state.
        const probedApprovalResults = new Map<number, HumanApprovalGateProbeErrorResult>();
        for (const approvalIndex of humanApprovalToolCallIndexes) {
          const approvalToolCall = canonicalToolCalls[approvalIndex];
          const probeResult = await probeHumanApprovalGate(
            {
              ...stepCtx,
              toolCallId: approvalToolCall.toolCallId,
              toolName: approvalToolCall.toolName,
              toolArgs: approvalToolCall.args,
            },
            {
              toolRegistry,
              middlewareRegistry,
              eventBus,
              humanApprovalStore,
              storeWrapCtxFor: storeWrapCtxForToolCall,
            },
          );
          if (probeResult.status === "pending") {
            const committedApprovalToolCall = {
              ...approvalToolCall,
              args: probeResult.toolArgs ?? approvalToolCall.args,
            };
            emitSuppressedToolCalls(committedApprovalToolCall);
            appendSingleAssistantToolCall(committedApprovalToolCall);
            throw probeResult.error;
          }

          probedApprovalResults.set(approvalIndex, probeResult);
        }

        appendAllAssistantToolCalls();
        const settled = await Promise.allSettled(
          canonicalToolCalls.map(async (tc, index) => {
            const probedApprovalResult = probedApprovalResults.get(index);
            if (probedApprovalResult) {
              return await executeProbedToolResult(tc, probedApprovalResult);
            }
            return await executeCanonicalToolCall(tc);
          }),
        );
        recordSettledToolCalls(canonicalToolCalls, settled);
      } else {
        appendAllAssistantToolCalls();
        // Parallel path — no tool in this batch can open a declared humanApproval
        // gate, so the single-approval invariant cannot be violated by static
        // policy.
        //
        // We use Promise.allSettled (not Promise.all) so that if a non-pending
        // error or a *dynamic* HumanApprovalPendingError (thrown by middleware
        // not visible at pre-flight) bubbles out of one handler, the completed
        // siblings still get their tool-result appended in LLM order. After the
        // batch settles we surface the first error (HITL or otherwise) in LLM
        // order. Multi-gate dynamic approvals in the same batch are an
        // unsupported pattern; tools/extensions should declare `humanApproval`
        // on the ToolDefinition so the pre-flight check routes the batch to the
        // sequential path.
        const settled = await Promise.allSettled(
          canonicalToolCalls.map(async (tc) => await executeCanonicalToolCall(tc)),
        );
        recordSettledToolCalls(canonicalToolCalls, settled);
      }
    }

    // f. Return StepResult — when invoke recovery rewrote the assistant text,
    //    surface the cleaned text so consumers see the same content that was
    //    persisted to the conversation history. Otherwise return the raw text
    //    untouched (preserve original whitespace, undefined ↔ undefined).
    return {
      text: hadInvokeBlocks ? assistantText : llmResponse.text,
      finishReason: llmResponse.finishReason,
      rawFinishReason: llmResponse.rawFinishReason,
      toolCalls: toolCallResults,
      ...(llmResponse.usage ? { usage: llmResponse.usage } : {}),
    };
  };

  // 3. Build step middleware chain (with per-layer ctx.store injection)
  const chain = middlewareRegistry.buildChain<StepContext, StepResult>(
    "step",
    coreHandler,
    storeWrapCtxFor ? { wrapCtxFor: storeWrapCtxFor } : undefined,
  );

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
    if (isHumanApprovalPendingError(err)) {
      throw err;
    }

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

import * as path from "node:path";

import type { ExtensionApi, Message, ToolCallResult } from "@goondan/openharness";

import { PermissionDeniedError, PermissionRejectedError, requestPermission } from "../session/permission.js";
import { buildOpencodeSystemPrompt } from "../session/system.js";
import { filterToolCatalogForModel } from "../session/tool-catalog.js";

const DOOM_LOOP_THRESHOLD = 3;

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") {
    return true;
  }
  if (relative.startsWith("..")) {
    return false;
  }
  return !path.isAbsolute(relative);
}

function resolvePathInWorkdir(workdir: string, inputPath: string): string {
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(workdir, inputPath);
  if (!isPathInsideRoot(workdir, resolved)) {
    throw new Error(`workdir 밖 경로는 허용되지 않습니다: ${inputPath}`);
  }
  return resolved;
}

function parsePatchTouchedPaths(patchText: string): string[] {
  const touched = new Set<string>();
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const line of lines) {
    if (line.startsWith("*** Add File:")) {
      touched.add(line.slice("*** Add File:".length).trim());
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      touched.add(line.slice("*** Delete File:".length).trim());
      continue;
    }
    if (line.startsWith("*** Update File:")) {
      touched.add(line.slice("*** Update File:".length).trim());
      continue;
    }
    if (line.startsWith("*** Move to:")) {
      touched.add(line.slice("*** Move to:".length).trim());
    }
  }

  return Array.from(touched).filter(Boolean);
}

function buildBoundaryError(input: {
  toolCallId: string;
  toolName: string;
  error: unknown;
}): ToolCallResult {
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: "error",
    error: {
      name: "WorkdirBoundaryError",
      code: "E_WORKDIR_BOUNDARY",
      message: input.error instanceof Error ? input.error.message : String(input.error),
      suggestion: "상대 경로(workdir 기준)만 사용하세요.",
    },
  };
}

function createPreview(text: string, maxChars = 2_000): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...` : text;
}

function buildBashAlwaysPattern(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "*";
  }

  const [firstToken] = trimmed.split(/\s+/);
  return firstToken ? `${firstToken} *` : "*";
}

function buildPermissionRequest(toolName: string, args: Record<string, unknown>) {
  if (toolName === "opencode__bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) {
      return undefined;
    }
    return {
      permission: "bash",
      patterns: [command],
      always: [buildBashAlwaysPattern(command)],
      metadata: {
        command,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        description: typeof args.description === "string" ? args.description : undefined,
      },
    };
  }

  if (toolName === "opencode__write") {
    const filePath = typeof args.filePath === "string" ? args.filePath : "";
    if (!filePath) {
      return undefined;
    }
    return {
      permission: "edit",
      patterns: [filePath],
      always: ["*"],
      metadata: {
        filePath,
        contentPreview: typeof args.content === "string" ? createPreview(args.content) : undefined,
      },
    };
  }

  if (toolName === "opencode__edit") {
    const filePath = typeof args.filePath === "string" ? args.filePath : "";
    if (!filePath) {
      return undefined;
    }
    return {
      permission: "edit",
      patterns: [filePath],
      always: ["*"],
      metadata: {
        filePath,
        oldStringPreview: typeof args.oldString === "string" ? createPreview(args.oldString) : undefined,
        newStringPreview: typeof args.newString === "string" ? createPreview(args.newString) : undefined,
        replaceAll: args.replaceAll === true,
      },
    };
  }

  if (toolName === "opencode__apply_patch") {
    const patchText = typeof args.patchText === "string" ? args.patchText : "";
    const touched = parsePatchTouchedPaths(patchText);
    if (touched.length === 0) {
      return undefined;
    }
    return {
      permission: "edit",
      patterns: touched,
      always: ["*"],
      metadata: {
        files: touched,
        patchPreview: createPreview(patchText, 4_000),
      },
    };
  }

  if (toolName === "opencode__task") {
    const subagentType = typeof args.subagent_type === "string" ? args.subagent_type : "general";
    return {
      permission: "task",
      patterns: [subagentType],
      always: ["*"],
      metadata: {
        description: typeof args.description === "string" ? args.description : undefined,
        subagent_type: subagentType,
      },
    };
  }

  if (toolName === "opencode__websearch") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return undefined;
    }
    return {
      permission: "websearch",
      patterns: [query],
      always: ["*"],
      metadata: {
        query,
        numResults: typeof args.numResults === "number" ? args.numResults : undefined,
        type: typeof args.type === "string" ? args.type : undefined,
      },
    };
  }

  if (toolName === "opencode__codesearch") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return undefined;
    }
    return {
      permission: "codesearch",
      patterns: [query],
      always: ["*"],
      metadata: {
        query,
        tokensNum: typeof args.tokensNum === "number" ? args.tokensNum : undefined,
      },
    };
  }

  if (toolName === "opencode__skill") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      return undefined;
    }
    return {
      permission: "skill",
      patterns: [name],
      always: [name],
      metadata: {
        name,
      },
    };
  }

  return undefined;
}

function buildPermissionError(input: {
  toolCallId: string;
  toolName: string;
  error: PermissionDeniedError | PermissionRejectedError;
}): ToolCallResult {
  const rejected = input.error instanceof PermissionRejectedError;
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: "error",
    error: {
      name: input.error.name,
      code: rejected ? "E_PERMISSION_REJECTED" : "E_PERMISSION_DENIED",
      message: input.error.message,
      suggestion: rejected ? "다른 접근을 시도하거나 사용자에게 확인을 요청하세요." : "승인 규칙을 확인하세요.",
    },
  };
}

function isTerminalToolError(code: string | undefined): boolean {
  return code === "E_PERMISSION_REJECTED" || code === "E_PERMISSION_DENIED" || code === "E_DOOM_LOOP";
}

function buildTerminalToolErrorMessage(toolResult: ToolCallResult): string | undefined {
  if (toolResult.status !== "error") {
    return undefined;
  }

  const code = toolResult.error?.code;
  if (!isTerminalToolError(code)) {
    const rawMessage = toolResult.error?.message ?? "";
    if (/^Permission rejected\b/i.test(rawMessage)) {
      return "권한 요청이 거부되어 작업을 중단했습니다.";
    }
    if (/^Permission denied\b/i.test(rawMessage)) {
      return "허용된 권한 규칙에 막혀 작업을 진행하지 않았습니다.";
    }
    return undefined;
  }

  if (code === "E_PERMISSION_REJECTED") {
    return "권한 요청이 거부되어 작업을 중단했습니다.";
  }

  if (code === "E_PERMISSION_DENIED") {
    return "허용된 권한 규칙에 막혀 작업을 진행하지 않았습니다.";
  }

  if (code === "E_DOOM_LOOP") {
    return "같은 도구 호출이 반복되어 작업을 중단했습니다.";
  }

  return toolResult.error?.message;
}

function readToolCallSignature(part: unknown): { toolName: string; argsText: string } | undefined {
  if (typeof part !== "object" || part === null || Array.isArray(part)) {
    return undefined;
  }

  const record = part as Record<string, unknown>;
  if (record.type === "tool-call" && typeof record.toolName === "string") {
    return {
      toolName: record.toolName,
      argsText: JSON.stringify(record.input ?? {}),
    };
  }

  if (record.type === "tool" && typeof record.tool === "string") {
    const state = typeof record.state === "object" && record.state !== null && !Array.isArray(record.state)
      ? (record.state as Record<string, unknown>)
      : {};
    return {
      toolName: record.tool,
      argsText: JSON.stringify(state.input ?? {}),
    };
  }

  return undefined;
}

function collectRecentToolCalls(messages: readonly Message[], limit: number): Array<{ toolName: string; argsText: string }> {
  const recent: Array<{ toolName: string; argsText: string }> = [];

  for (let messageIndex = messages.length - 1; messageIndex >= 0 && recent.length < limit; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.data.role !== "assistant" || !Array.isArray(message.data.content)) {
      continue;
    }

    for (let partIndex = message.data.content.length - 1; partIndex >= 0 && recent.length < limit; partIndex -= 1) {
      const signature = readToolCallSignature(message.data.content[partIndex]);
      if (signature) {
        recent.push(signature);
      }
    }
  }

  return recent;
}

function isDoomLoop(messages: readonly Message[], toolName: string, args: Record<string, unknown>): boolean {
  const targetArgs = JSON.stringify(args);
  const recent = collectRecentToolCalls(messages, DOOM_LOOP_THRESHOLD);
  return (
    recent.length === DOOM_LOOP_THRESHOLD
    && recent.every((entry) => entry.toolName === toolName && entry.argsText === targetArgs)
  );
}

function extractLegacyAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) {
        return "";
      }
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "compaction" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .join("")
    .trim();
}

function isLegacyAssistantMessage(message: Message): boolean {
  return message.data.role === "assistant"
    && (message.metadata["opencode.assistant"] === true || message.metadata["opencode.assistant.migrated"] === true);
}

function shouldStripLegacyProtocolLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return parsed.type === "step-start"
      || parsed.type === "step-finish"
      || parsed.type === "patch"
      || parsed.type === "compaction";
  } catch {
    return false;
  }
}

function stripLegacyAssistantProtocol(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !shouldStripLegacyProtocolLine(line))
    .join("\n")
    .trim();
}

function normalizeAssistantMessage(message: Message): Message | null {
  if (!isLegacyAssistantMessage(message)) {
    return message;
  }

  if (typeof message.data.content === "string") {
    const normalizedText = stripLegacyAssistantProtocol(message.data.content);
    if (normalizedText.length === 0) {
      return null;
    }
    if (normalizedText === message.data.content) {
      return message;
    }
    return {
      ...message,
      data: {
        ...message.data,
        content: normalizedText,
      },
      metadata: {
        ...message.metadata,
        "opencode.assistant.migrated": true,
      },
    };
  }

  if (Array.isArray(message.data.content) && message.metadata["opencode.assistant"] === true) {
    const migratedText = stripLegacyAssistantProtocol(extractLegacyAssistantText(message.data.content));
    if (migratedText.length === 0) {
      return null;
    }

    return {
      ...message,
      data: {
        ...message.data,
        content: migratedText,
      },
      metadata: {
        ...message.metadata,
        "opencode.assistant.migrated": true,
      },
    };
  }

  return message;
}

function readToolCallId(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null || Array.isArray(part)) {
    return undefined;
  }

  const record = part as Record<string, unknown>;
  if (record.type === "tool-call" || record.type === "tool-use" || record.type === "tool-result") {
    if (typeof record.toolCallId === "string" && record.toolCallId.trim().length > 0) {
      return record.toolCallId;
    }
    if (typeof record.toolUseId === "string" && record.toolUseId.trim().length > 0) {
      return record.toolUseId;
    }
    if (typeof record.callId === "string" && record.callId.trim().length > 0) {
      return record.callId;
    }
    if (typeof record.id === "string" && record.id.trim().length > 0) {
      return record.id;
    }
  }

  return undefined;
}

function isToolResultPart(part: unknown): boolean {
  return typeof part === "object"
    && part !== null
    && !Array.isArray(part)
    && (part as Record<string, unknown>).type === "tool-result";
}

function hasMatchingAssistantToolCall(message: Message | null, toolCallIds: readonly string[]): boolean {
  if (!message || message.data.role !== "assistant" || !Array.isArray(message.data.content)) {
    return false;
  }

  const knownIds = new Set(
    message.data.content
      .map((part) => {
        if (typeof part !== "object" || part === null || Array.isArray(part)) {
          return undefined;
        }
        const record = part as Record<string, unknown>;
        if (record.type !== "tool-call" && record.type !== "tool-use") {
          return undefined;
        }
        return readToolCallId(record);
      })
      .filter((value): value is string => typeof value === "string"),
  );

  return toolCallIds.every((id) => knownIds.has(id));
}

function findPreviousAssistantMessage(messages: ReadonlyArray<Message | null>, index: number): Message | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (!candidate) {
      continue;
    }
    if (candidate.data.role === "assistant") {
      return candidate;
    }
  }
  return null;
}

function isOrphanToolResultMessage(message: Message, previousAssistant: Message | null): boolean {
  if (message.data.role !== "user" || !Array.isArray(message.data.content) || message.data.content.length === 0) {
    return false;
  }

  if (!message.data.content.every(isToolResultPart)) {
    return false;
  }

  const toolCallIds = message.data.content
    .map((part) => readToolCallId(part))
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (toolCallIds.length !== message.data.content.length) {
    return true;
  }

  return !hasMatchingAssistantToolCall(previousAssistant, toolCallIds);
}

export function register(api: ExtensionApi): void {
  api.pipeline.register(
    "turn",
    async (ctx) => {
      const normalizedMessages = [...ctx.conversationState.nextMessages] as Array<Message | null>;

      for (let index = 0; index < normalizedMessages.length; index += 1) {
        const message = normalizedMessages[index];
        if (!message) {
          continue;
        }
        const normalized = normalizeAssistantMessage(message);
        if (normalized === null) {
          ctx.emitMessageEvent({
            type: "remove",
            targetId: message.id,
          });
          normalizedMessages[index] = null;
          continue;
        }
        if (normalized !== message) {
          ctx.emitMessageEvent({
            type: "replace",
            targetId: message.id,
            message: normalized,
          });
          normalizedMessages[index] = normalized;
        }
      }

      for (let index = 0; index < normalizedMessages.length; index += 1) {
        const message = normalizedMessages[index];
        if (!message) {
          continue;
        }
        if (isOrphanToolResultMessage(message, findPreviousAssistantMessage(normalizedMessages, index))) {
          ctx.emitMessageEvent({
            type: "remove",
            targetId: message.id,
          });
          normalizedMessages[index] = null;
        }
      }

      const prompt = ctx.runtime.agent.prompt ?? {};
      const currentSystem = typeof prompt.system === "string" ? prompt.system.trim() : "";
      const runtimeModel = ctx.runtime.model;
      const systemPrompt = await buildOpencodeSystemPrompt({
        workdir: ctx.runtime.agent.bundleRoot,
        provider: runtimeModel?.provider ?? "unknown",
        modelName: runtimeModel?.modelName ?? "unknown",
        explicitPrompt: currentSystem,
      });

      ctx.runtime.agent.prompt = {
        ...prompt,
        system: systemPrompt,
      };

      return ctx.next();
    },
    { priority: -100 },
  );

  api.pipeline.register("step", async (ctx) => {
    const modelName = ctx.runtime.model?.modelName;
    if (typeof modelName === "string" && modelName.trim().length > 0) {
      ctx.toolCatalog = filterToolCatalogForModel(ctx.toolCatalog, modelName);
    }

    const stepResult = await ctx.next();
    const terminalToolError = stepResult.toolResults
      .map((toolResult) => buildTerminalToolErrorMessage(toolResult))
      .find((message): message is string => typeof message === "string" && message.length > 0);

    if (terminalToolError) {
      stepResult.shouldContinue = false;
      stepResult.metadata = {
        ...stepResult.metadata,
        "opencode.finalResponseText": terminalToolError,
      };
    }

    return stepResult;
  });

  api.pipeline.register("toolCall", async (ctx) => {
    const workdir = ctx.runtime.agent.bundleRoot;

    if (isDoomLoop(ctx.conversationState.nextMessages, ctx.toolName, ctx.args)) {
      try {
        await requestPermission({
          workdir,
          permission: "doom_loop",
          patterns: [ctx.toolName],
          always: [ctx.toolName],
          metadata: {
            tool: ctx.toolName,
            input: ctx.args,
          },
        });
      } catch (error) {
        if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
          return buildPermissionError({
            toolCallId: ctx.toolCallId,
            toolName: ctx.toolName,
            error,
          });
        }
        throw error;
      }
    }

    try {
      if (
        ctx.toolName === "opencode__read"
        || ctx.toolName === "opencode__write"
        || ctx.toolName === "opencode__edit"
      ) {
        const filePath = typeof ctx.args.filePath === "string" ? ctx.args.filePath : "";
        if (filePath) {
          resolvePathInWorkdir(workdir, filePath);
        }
      }

      if (ctx.toolName === "opencode__glob" || ctx.toolName === "opencode__grep") {
        const searchPath = typeof ctx.args.path === "string" ? ctx.args.path : "";
        if (searchPath) {
          resolvePathInWorkdir(workdir, searchPath);
        }
      }

      if (ctx.toolName === "opencode__apply_patch") {
        const patchText = typeof ctx.args.patchText === "string" ? ctx.args.patchText : "";
        for (const touchedPath of parsePatchTouchedPaths(patchText)) {
          resolvePathInWorkdir(workdir, touchedPath);
        }
      }
    } catch (error) {
      return buildBoundaryError({
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        error,
      });
    }

    const permissionRequest = buildPermissionRequest(ctx.toolName, ctx.args);
    if (permissionRequest) {
      try {
        await requestPermission({
          workdir,
          ...permissionRequest,
        });
      } catch (error) {
        if (error instanceof PermissionDeniedError || error instanceof PermissionRejectedError) {
          return buildPermissionError({
            toolCallId: ctx.toolCallId,
            toolName: ctx.toolName,
            error,
          });
        }
        throw error;
      }
    }

    return ctx.next();
  });
}

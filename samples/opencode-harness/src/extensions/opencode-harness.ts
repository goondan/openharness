import * as path from "node:path";

import type { ExtensionApi, ToolCallResult } from "@goondan/openharness";

import { PermissionDeniedError, PermissionRejectedError, requestPermission } from "../session/permission.js";
import { buildOpencodeSystemPrompt } from "../session/system.js";
import { opencodeTurnProcessor } from "../session/processor.js";

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

export function register(api: ExtensionApi): void {
  api.pipeline.register(
    "turn",
    async (ctx) => {
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

  api.pipeline.register("toolCall", async (ctx) => {
    const workdir = ctx.runtime.agent.bundleRoot;

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

  api.session.registerTurnProcessor((ctx) => opencodeTurnProcessor(ctx));
}

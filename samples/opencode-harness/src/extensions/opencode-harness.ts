import * as path from "node:path";

import type { ExtensionApi, ToolCallResult } from "@goondan/openharness";

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

    return ctx.next();
  });

  api.session.registerTurnProcessor((ctx) => opencodeTurnProcessor(ctx));
}

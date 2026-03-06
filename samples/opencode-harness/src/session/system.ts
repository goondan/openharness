import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadSystemInstructions } from "./instruction.js";

const PROMPT_FILES = {
  codex: "codex_header.txt",
  beast: "beast.txt",
  gemini: "gemini.txt",
  anthropic: "anthropic.txt",
  qwen: "qwen.txt",
  trinity: "trinity.txt",
} as const;

function selectPromptFile(modelName: string): string {
  const normalized = modelName.toLowerCase();

  if (normalized.includes("gpt-5")) {
    return PROMPT_FILES.codex;
  }
  if (
    normalized.includes("gpt-")
    || normalized.includes("o1")
    || normalized.includes("o3")
  ) {
    return PROMPT_FILES.beast;
  }
  if (normalized.includes("gemini")) {
    return PROMPT_FILES.gemini;
  }
  if (normalized.includes("claude")) {
    return PROMPT_FILES.anthropic;
  }
  if (normalized.includes("trinity")) {
    return PROMPT_FILES.trinity;
  }
  return PROMPT_FILES.qwen;
}

export async function buildOpencodeSystemPrompt(input: {
  workdir: string;
  provider: string;
  modelName: string;
  explicitPrompt?: string;
}): Promise<string> {
  const isGit = await fs
    .stat(path.join(input.workdir, ".git"))
    .then((stat) => stat.isDirectory())
    .catch(() => false);

  const envBlock = [
    "<env>",
    `Working directory: ${input.workdir}`,
    `Is directory a git repo: ${isGit ? "yes" : "no"}`,
    `Platform: ${process.platform}`,
    `Today's date: ${new Date().toDateString()}`,
    `Provider: ${input.provider}`,
    `Model: ${input.modelName}`,
    "</env>",
  ].join("\n");

  const basePrompt =
    input.explicitPrompt && input.explicitPrompt.trim().length > 0
      ? input.explicitPrompt.trim()
      : await fs.readFile(path.join(input.workdir, "prompts", selectPromptFile(input.modelName)), "utf8");

  return [basePrompt.trim(), envBlock, ...(await loadSystemInstructions(input.workdir)).map((item) => item.content)]
    .filter((item) => item.trim().length > 0)
    .join("\n\n");
}

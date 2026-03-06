import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_LINES = 2_000;
export const MAX_BYTES = 50 * 1024;

const TOOL_OUTPUT_DIR = path.join(".openharness", "tool-output");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function createOutputId(): string {
  return `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface TruncationOptions {
  workdir: string;
  maxLines?: number;
  maxBytes?: number;
  direction?: "head" | "tail";
  hasTaskTool?: boolean;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
}

function createHint(outputPath: string, hasTaskTool: boolean): string {
  if (hasTaskTool) {
    return (
      `The tool call succeeded but the output was truncated. Full output saved to: ${outputPath}\n`
      + "Use the Task tool to have an explore agent inspect this file with Grep and Read (with offset/limit)."
    );
  }
  return (
    `The tool call succeeded but the output was truncated. Full output saved to: ${outputPath}\n`
    + "Use Grep to search the full content or Read with offset/limit to inspect only the relevant sections."
  );
}

export async function cleanupTruncationOutputs(workdir: string): Promise<void> {
  const outputDir = path.join(workdir, TOOL_OUTPUT_DIR);
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - RETENTION_MS;

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      const target = path.join(outputDir, entry.name);
      const stat = await fs.stat(target).catch(() => undefined);
      if (!stat || stat.mtimeMs >= cutoff) {
        return;
      }
      await fs.unlink(target).catch(() => undefined);
    }),
  );
}

export async function truncateToolOutput(text: string, options: TruncationOptions): Promise<TruncationResult> {
  const maxLines = options.maxLines ?? MAX_LINES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const direction = options.direction ?? "head";
  const lines = text.split("\n");
  const totalBytes = Buffer.byteLength(text, "utf8");

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content: text,
      truncated: false,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedByBytes = false;

  if (direction === "head") {
    for (let index = 0; index < lines.length && kept.length < maxLines; index += 1) {
      const line = lines[index] ?? "";
      const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        truncatedByBytes = true;
        break;
      }
      kept.push(line);
      bytes += size;
    }
  } else {
    for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index -= 1) {
      const line = lines[index] ?? "";
      const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        truncatedByBytes = true;
        break;
      }
      kept.unshift(line);
      bytes += size;
    }
  }

  const outputDir = path.join(options.workdir, TOOL_OUTPUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  await cleanupTruncationOutputs(options.workdir);

  const outputPath = path.join(outputDir, createOutputId());
  await fs.writeFile(outputPath, text, "utf8");

  const removed = truncatedByBytes ? totalBytes - bytes : lines.length - kept.length;
  const unit = truncatedByBytes ? "bytes" : "lines";
  const hint = createHint(outputPath, options.hasTaskTool ?? false);
  const preview = kept.join("\n");

  return {
    content:
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
        : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
    truncated: true,
    outputPath,
  };
}

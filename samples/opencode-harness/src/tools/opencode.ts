import { spawn } from "node:child_process";
import { Console } from "node:console";
import { accessSync, constants as fsConstants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { createRunnerFromHarnessYaml, type JsonObject, type JsonValue, type ToolContext } from "@goondan/openharness";

import { createToolResultEnvelope, type ToolPayload } from "../session/protocol.js";
import { resolveFileInstructions } from "./instruction.js";
import { truncateToolOutput } from "./truncation.js";

const DEFAULT_BASH_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BASH_OUTPUT_BYTES = 50 * 1024;
const MAX_BASH_METADATA_LENGTH = 30_000;

const DEFAULT_READ_LIMIT = 2_000;
const MAX_LINE_LENGTH = 2_000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024} KB`;

const DEFAULT_GLOB_LIMIT = 100;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_WEBFETCH_TIMEOUT_MS = 30_000;
const MAX_WEBFETCH_TIMEOUT_MS = 120_000;
const DEFAULT_WEBFETCH_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const WEBFETCH_FORMATS = ["text", "markdown", "html"] as const;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".pdb",
  ".pyc",
  ".pyo",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".flac",
]);

interface TaskSession {
  runner: Awaited<ReturnType<typeof createRunnerFromHarnessYaml>>;
  subagentType: string;
}

const taskSessions = new Map<string, TaskSession>();
const QUIET_STREAM = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const QUIET_LOGGER = new Console({ stdout: QUIET_STREAM, stderr: QUIET_STREAM });

const TASK_AGENT_PROMPTS: Record<string, string> = {
  general: "You are a general-purpose subagent. Execute the delegated task completely and return only the result that the caller needs.",
  explore: [
    "You are a file search specialist. You excel at thoroughly navigating and exploring codebases.",
    "Use Glob for broad file pattern matching.",
    "Use Grep for searching file contents with regex.",
    "Use Read when you know the specific file path you need to read.",
    "Use Bash only for non-mutating file listing or search-adjacent commands.",
    "Do not create, edit, move, or delete files.",
    "Return concise findings with concrete file paths.",
  ].join("\n"),
};

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeRelative(workdir: string, filePath: string): string {
  return path.relative(workdir, filePath).replaceAll("\\", "/");
}

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
    throw new Error(`Path is outside the workdir: ${inputPath}`);
  }
  return resolved;
}

function readStringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readEnumArg<const T extends string>(
  args: JsonObject,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = readStringArg(args, key);
  if (!value) {
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readRecordArg(args: JsonObject, key: string): Record<string, string> | undefined {
  const value = args[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue === "string") {
      result[entryKey] = entryValue;
      continue;
    }
    if (typeof entryValue === "number" || typeof entryValue === "boolean") {
      result[entryKey] = String(entryValue);
    }
  }
  return result;
}

function truncateMetadataOutput(text: string): string {
  if (text.length <= MAX_BASH_METADATA_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_BASH_METADATA_LENGTH)}\n\n...`;
}

function normalizePayload(payload: ToolPayload): JsonValue {
  return createToolResultEnvelope({
    output: payload.output,
    title: payload.title,
    metadata: payload.metadata,
    attachments: payload.attachments,
    truncated: payload.truncated,
    outputPath: payload.outputPath,
  });
}

async function wrapTextOutput(
  ctx: ToolContext,
  payload: ToolPayload,
  options?: { maxLines?: number; maxBytes?: number; direction?: "head" | "tail"; hasTaskTool?: boolean },
): Promise<JsonValue> {
  const truncated = await truncateToolOutput(payload.output, {
    workdir: ctx.workdir,
    ...(options ?? {}),
  });

  return normalizePayload({
    ...payload,
    output: truncated.content,
    truncated: truncated.truncated,
    outputPath: truncated.outputPath,
    metadata: {
      ...(payload.metadata ?? {}),
      preview:
        typeof payload.metadata?.preview === "string"
          ? payload.metadata.preview
          : createPreview(payload.output),
      truncated: truncated.truncated,
      ...(truncated.outputPath ? { outputPath: truncated.outputPath } : {}),
    },
  });
}

function createPreview(text: string, maxChars = 4_000): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function createTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadDotenv(workdir: string): Promise<Record<string, string>> {
  const envPath = path.join(workdir, ".env");
  const content = await fs.readFile(envPath, "utf8").catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  });

  const out: Record<string, string> = {};
  for (const rawLine of normalizeLineEndings(content).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function buildTaskPrompt(input: {
  subagentType: string;
  description: string;
  prompt: string;
  command?: string;
}): string {
  const prefix = TASK_AGENT_PROMPTS[input.subagentType] ?? TASK_AGENT_PROMPTS.general;
  return [
    prefix,
    "",
    `Delegated task: ${input.description}`,
    input.command ? `Original command: ${input.command}` : "",
    "",
    input.prompt,
  ].filter(Boolean).join("\n");
}

function guessMediaType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return "application/pdf";
  }
  return IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream";
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") && mediaType !== "image/svg+xml" && mediaType !== "image/vnd.fastbidsheet";
}

function isTextLikeContentType(contentType: string): boolean {
  const lowered = contentType.toLowerCase();
  return (
    lowered.startsWith("text/")
    || lowered.includes("application/json")
    || lowered.includes("application/xml")
    || lowered.includes("application/javascript")
    || lowered.includes("application/xhtml+xml")
    || lowered.includes("image/svg+xml")
  );
}

async function createFileAttachment(filePath: string, mediaType: string): Promise<NonNullable<ToolPayload["attachments"]>[number]> {
  const bytes = await fs.readFile(filePath);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is too large to inline: ${filePath}`);
  }
  return {
    type: "file",
    url: `data:${mediaType};base64,${bytes.toString("base64")}`,
    mediaType,
    filename: path.basename(filePath),
  };
}

function extractFilenameFromContentDisposition(headerValue: string | null): string | undefined {
  if (!headerValue) {
    return undefined;
  }
  const utf8 = headerValue.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    return decodeURIComponent(utf8);
  }
  const quoted = headerValue.match(/filename\s*=\s*"([^"]+)"/i)?.[1];
  if (quoted) {
    return quoted;
  }
  return headerValue.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim();
}

function resolveAttachmentFilename(url: URL, headerValue: string | null): string | undefined {
  const fromHeader = extractFilenameFromContentDisposition(headerValue);
  if (fromHeader) {
    return fromHeader;
  }
  const basename = path.posix.basename(url.pathname);
  return basename && basename !== "/" ? basename : undefined;
}

async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`Response too large (exceeds ${Math.floor(maxBytes / 1024)} KB limit)`);
    }
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response too large (exceeds ${Math.floor(maxBytes / 1024)} KB limit)`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response too large (exceeds ${Math.floor(maxBytes / 1024)} KB limit)`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function isProbablyBinaryFile(filePath: string, fileSize?: number): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }

  const handle = await fs.open(filePath, "r");
  try {
    const stat = fileSize === undefined ? await handle.stat() : { size: fileSize };
    if (stat.size === 0) {
      return false;
    }
    const readSize = Math.min(stat.size, 8_000);
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0) {
        return true;
      }
    }
    return false;
  } finally {
    await handle.close();
  }
}

function resolveRgExecutable(): string | null {
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  const pathEnv = process.env.PATH ?? "";
  for (const entry of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, executable);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // noop
    }
  }
  return null;
}

function collectSpawnOutput(
  child: ReturnType<typeof spawn>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

export async function bash(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const command = readStringArg(args, "command") ?? "";
  if (!command.trim()) {
    throw new Error("command is required");
  }

  const cwdArg = readStringArg(args, "cwd") ?? readStringArg(args, "workdir");
  const timeoutValue = readNumberArg(args, "timeoutMs") ?? readNumberArg(args, "timeout");
  const timeoutMs = timeoutValue ?? DEFAULT_BASH_TIMEOUT_MS;
  if (timeoutMs < 0) {
    throw new Error(`Invalid timeout value: ${timeoutMs}. Timeout must be a positive number.`);
  }
  const description = readStringArg(args, "description") ?? command.split("\n")[0]?.trim() ?? "bash";
  const env = readRecordArg(args, "env");
  const cwd = cwdArg ? resolvePathInWorkdir(ctx.workdir, cwdArg) : ctx.workdir;

  const child = spawn(command, {
    cwd,
    env: {
      ...process.env,
      ...(env ?? {}),
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let timedOut = false;

  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };

  child.stdout?.on("data", (chunk) => append(chunk as Buffer));
  child.stderr?.on("data", (chunk) => append(chunk as Buffer));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs + 100);

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal });
    });
  });

  if (timedOut) {
    const suffix = `bash tool terminated command after exceeding timeout ${timeoutMs} ms`;
    output = output.trimEnd();
    output = output.length > 0 ? `${output}\n\n<bash_metadata>\n${suffix}\n</bash_metadata>` : `<bash_metadata>\n${suffix}\n</bash_metadata>`;
  }

  return wrapTextOutput(
    ctx,
    {
      title: description,
      output,
      metadata: {
        output: truncateMetadataOutput(output),
        exit: result.exitCode ?? -1,
        description,
        cwd,
        command,
        timeoutMs,
        timedOut,
        ...(result.signal ? { signal: result.signal } : {}),
      },
    },
    {
      maxBytes: MAX_BASH_OUTPUT_BYTES,
    },
  );
}

export async function invalid(_ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const toolName = readStringArg(args, "tool") ?? "unknown";
  const error = readStringArg(args, "error") ?? "invalid tool call";

  return normalizePayload({
    title: "Invalid Tool",
    output: `The arguments provided to the tool are invalid: ${error}`,
    metadata: {
      tool: toolName,
      error,
    },
  });
}

export async function read(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const filePathArg = readStringArg(args, "filePath") ?? "";
  if (!filePathArg.trim()) {
    throw new Error("filePath is required");
  }

  const offsetArg = readNumberArg(args, "offset");
  if (offsetArg !== undefined && offsetArg < 1) {
    throw new Error("offset must be greater than or equal to 1");
  }

  const limitArg = readNumberArg(args, "limit");
  const offset = offsetArg ?? 1;
  const limit = limitArg ?? DEFAULT_READ_LIMIT;

  const absolutePath = resolvePathInWorkdir(ctx.workdir, filePathArg);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat) {
    const directory = path.dirname(absolutePath);
    const base = path.basename(absolutePath);
    const suggestions = await fs
      .readdir(directory)
      .then((entries) =>
        entries
          .filter(
            (entry) =>
              entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
          )
          .map((entry) => path.join(directory, entry))
          .slice(0, 3),
      )
      .catch(() => []);

    if (suggestions.length > 0) {
      throw new Error(`File not found: ${absolutePath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`);
    }
    throw new Error(`File not found: ${absolutePath}`);
  }

  const title = normalizeRelative(ctx.workdir, absolutePath) || path.basename(absolutePath);

  if (stat.isDirectory()) {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (dirent) => {
        if (dirent.isDirectory()) {
          return `${dirent.name}/`;
        }
        if (dirent.isSymbolicLink()) {
          const target = await fs.stat(path.join(absolutePath, dirent.name)).catch(() => undefined);
          if (target?.isDirectory()) {
            return `${dirent.name}/`;
          }
        }
        return dirent.name;
      }),
    );

    entries.sort((left, right) => left.localeCompare(right));
    const start = offset - 1;
    const sliced = entries.slice(start, start + limit);
    const truncated = start + sliced.length < entries.length;

    return normalizePayload({
      title,
      output: [
        `<path>${absolutePath}</path>`,
        "<type>directory</type>",
        "<entries>",
        sliced.join("\n"),
        truncated
          ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
          : `\n(${entries.length} entries)`,
        "</entries>",
      ].join("\n"),
      metadata: {
        preview: sliced.slice(0, 20).join("\n"),
        truncated,
        loaded: [],
        count: entries.length,
        nextOffset: truncated ? offset + sliced.length : null,
      },
    });
  }

  const instructions = await resolveFileInstructions({
    turnId: ctx.turnId,
    targetPath: absolutePath,
    workdir: ctx.workdir,
  });

  const mediaType = guessMediaType(absolutePath);
  const isImage = isImageMediaType(mediaType);
  const isPdf = mediaType === "application/pdf";
  if (isImage || isPdf) {
    const message = `${isImage ? "Image" : "PDF"} read successfully`;
    return normalizePayload({
      title,
      output: message,
      metadata: {
        preview: message,
        truncated: false,
        loaded: instructions.map((instruction) => instruction.filepath),
        mediaType,
        bytes: stat.size,
      },
      attachments: [
        await createFileAttachment(absolutePath, mediaType),
      ],
    });
  }

  if (await isProbablyBinaryFile(absolutePath, Number(stat.size))) {
    throw new Error(`Cannot read binary file: ${absolutePath}`);
  }

  const stream = createReadStream(absolutePath, { encoding: "utf8" });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const start = offset - 1;
  const raw: string[] = [];
  let bytes = 0;
  let lines = 0;
  let truncatedByBytes = false;
  let hasMoreLines = false;

  try {
    for await (const text of rl) {
      lines += 1;
      if (lines <= start) {
        continue;
      }

      if (raw.length >= limit) {
        hasMoreLines = true;
        continue;
      }

      const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text;
      const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
      if (bytes + size > MAX_READ_BYTES) {
        truncatedByBytes = true;
        hasMoreLines = true;
        break;
      }

      raw.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (lines < offset && !(lines === 0 && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${lines} lines)`);
  }

  const content = raw.map((line, index) => `${index + offset}: ${line}`);
  const preview = raw.slice(0, 20).join("\n");
  const lastReadLine = offset + raw.length - 1;
  const nextOffset = lastReadLine + 1;
  const truncated = hasMoreLines || truncatedByBytes;

  let output = [`<path>${absolutePath}</path>`, "<type>file</type>", "<content>"].join("\n");
  output += content.join("\n");

  if (truncatedByBytes) {
    output += `\n\n(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`;
  } else if (hasMoreLines) {
    output += `\n\n(Showing lines ${offset}-${lastReadLine} of ${lines}. Use offset=${nextOffset} to continue.)`;
  } else {
    output += `\n\n(End of file - total ${lines} lines)`;
  }
  output += "\n</content>";

  if (instructions.length > 0) {
    output += `\n\n<system-reminder>\n${instructions.map((instruction) => instruction.content).join("\n\n")}\n</system-reminder>`;
  }

  return normalizePayload({
    title,
    output,
    metadata: {
      preview,
      truncated,
      loaded: instructions.map((instruction) => instruction.filepath),
      totalLines: lines,
      nextOffset: truncated ? nextOffset : null,
    },
  });
}

export async function write(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const filePathArg = readStringArg(args, "filePath") ?? "";
  if (!filePathArg.trim()) {
    throw new Error("filePath is required");
  }

  const content = readStringArg(args, "content");
  if (content === undefined) {
    throw new Error("content is required");
  }

  const absolutePath = resolvePathInWorkdir(ctx.workdir, filePathArg);
  const existed = await fs.stat(absolutePath).then(() => true).catch(() => false);
  const previousContent = existed ? await fs.readFile(absolutePath, "utf8").catch(() => "") : "";

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");

  return normalizePayload({
    title: normalizeRelative(ctx.workdir, absolutePath),
    output: "Wrote file successfully.",
    metadata: {
      filepath: absolutePath,
      exists: existed,
      bytes: Buffer.byteLength(content, "utf8"),
      previousBytes: Buffer.byteLength(previousContent, "utf8"),
      preview: createPreview(content, 2_000),
    },
  });
}

function replaceExact(content: string, oldString: string, newString: string, replaceAll: boolean): string | undefined {
  if (!content.includes(oldString)) {
    return undefined;
  }
  return replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function replaceWhitespaceNormalized(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | undefined {
  const normalizedTarget = normalizeWhitespace(oldString);
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (normalizeWhitespace(line) !== normalizedTarget) {
      continue;
    }
    const search = line;
    return replaceAll ? content.replaceAll(search, newString) : content.replace(search, newString);
  }

  return undefined;
}

function removeSharedIndentation(text: string): string {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return text;
  }
  const minIndent = Math.min(
    ...nonEmpty.map((line) => {
      const match = line.match(/^(\s*)/);
      return match?.[1]?.length ?? 0;
    }),
  );
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
}

function replaceIndentationFlexible(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | undefined {
  const normalizedTarget = removeSharedIndentation(oldString);
  const contentLines = content.split("\n");
  const targetLines = oldString.split("\n");

  for (let index = 0; index <= contentLines.length - targetLines.length; index += 1) {
    const block = contentLines.slice(index, index + targetLines.length).join("\n");
    if (removeSharedIndentation(block) !== normalizedTarget) {
      continue;
    }
    return replaceAll ? content.replaceAll(block, newString) : content.replace(block, newString);
  }

  return undefined;
}

function replaceWithFallback(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }

  for (const replacer of [replaceExact, replaceWhitespaceNormalized, replaceIndentationFlexible]) {
    const replaced = replacer(content, oldString, newString, replaceAll);
    if (replaced !== undefined && replaced !== content) {
      return replaced;
    }
  }

  throw new Error("Failed to find the target text to replace.");
}

export async function edit(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const filePathArg = readStringArg(args, "filePath") ?? "";
  if (!filePathArg.trim()) {
    throw new Error("filePath is required");
  }

  const oldString = readStringArg(args, "oldString");
  if (oldString === undefined) {
    throw new Error("oldString is required");
  }

  const newString = readStringArg(args, "newString");
  if (newString === undefined) {
    throw new Error("newString is required");
  }

  const replaceAll = args.replaceAll === true;
  const absolutePath = resolvePathInWorkdir(ctx.workdir, filePathArg);

  if (oldString.length === 0) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, newString, "utf8");
    return normalizePayload({
      title: normalizeRelative(ctx.workdir, absolutePath),
      output: "Edit applied successfully.",
      metadata: {
        filepath: absolutePath,
        created: true,
        replaceAll,
      },
    });
  }

  const existing = await fs.readFile(absolutePath, "utf8").catch(() => {
    throw new Error(`File not found: ${absolutePath}`);
  });
  const updated = replaceWithFallback(existing, oldString, newString, replaceAll);
  await fs.writeFile(absolutePath, updated, "utf8");

  return normalizePayload({
    title: normalizeRelative(ctx.workdir, absolutePath),
    output: "Edit applied successfully.",
    metadata: {
      filepath: absolutePath,
      replaceAll,
      preview: createPreview(updated, 2_000),
    },
  });
}

function looksLikeGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[") || pattern.includes("]");
}

async function listFilesRecursively(root: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const dirents = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const entry = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        queue.push(entry);
        continue;
      }
      if (dirent.isFile()) {
        results.push(entry);
        if (results.length >= limit) {
          return results;
        }
      }
    }
  }

  return results;
}

function matchesSimpleGlob(text: string, pattern: string): boolean {
  return globToRegExp(pattern).test(text);
}

function globToRegExp(pattern: string): RegExp {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index] ?? "";

    if (ch === "*") {
      const next = pattern[index + 1];
      if (next === "*") {
        index += 1;
        const after = pattern[index + 1];
        if (after === "/") {
          index += 1;
          output += "(?:.*\\/)?";
        } else {
          output += ".*";
        }
        continue;
      }
      output += "[^/]*";
      continue;
    }

    if (ch === "?") {
      output += "[^/]";
      continue;
    }

    output += /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
  }
  output += "$";
  return new RegExp(output);
}

async function collectGlobMatches(input: {
  rg?: string | null;
  searchDir: string;
  pattern: string;
}): Promise<Array<{ file: string; mtime: number }>> {
  const results: Array<{ file: string; mtime: number }> = [];

  if (input.rg) {
    const child = spawn(input.rg, ["--files", "--hidden", "--glob", input.pattern], {
      cwd: input.searchDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { stdout, stderr, exitCode } = await collectSpawnOutput(child);
    if (exitCode !== 0 && stderr.trim()) {
      throw new Error(`ripgrep failed: ${stderr}`);
    }

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const file = path.resolve(input.searchDir, line.trim());
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      results.push({ file, mtime: stat.mtime.getTime() });
    }
    return results;
  }

  const candidates = await listFilesRecursively(input.searchDir, 20_000);
  for (const file of candidates) {
    const relative = normalizeRelative(input.searchDir, file);
    if (!matchesSimpleGlob(relative, input.pattern)) {
      continue;
    }
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    results.push({ file, mtime: stat.mtime.getTime() });
  }
  return results;
}

export async function glob(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const pattern = readStringArg(args, "pattern") ?? "";
  if (!pattern.trim()) {
    throw new Error("pattern is required");
  }

  const pathArg = readStringArg(args, "path");
  const limit = Math.max(1, Math.floor(readNumberArg(args, "limit") ?? DEFAULT_GLOB_LIMIT));
  const searchDir = pathArg ? resolvePathInWorkdir(ctx.workdir, pathArg) : ctx.workdir;
  const stat = await fs.stat(searchDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`glob path must be a directory: ${pathArg ?? "."}`);
  }

  const rg = resolveRgExecutable();
  let matches = await collectGlobMatches({
    rg,
    searchDir,
    pattern,
  });

  if (matches.length === 0 && !looksLikeGlobPattern(pattern)) {
    const candidates = await listFilesRecursively(searchDir, 20_000);
    matches = [];
    for (const file of candidates) {
      const relative = normalizeRelative(searchDir, file);
      if (!relative.toLowerCase().includes(pattern.toLowerCase())) {
        continue;
      }
      const fileStat = await fs.stat(file).catch(() => null);
      if (!fileStat?.isFile()) {
        continue;
      }
      matches.push({ file, mtime: fileStat.mtime.getTime() });
    }
  }

  matches.sort((left, right) => right.mtime - left.mtime);
  const truncated = matches.length > limit;
  const finalMatches = truncated ? matches.slice(0, limit) : matches;

  if (finalMatches.length === 0) {
    return normalizePayload({
      title: normalizeRelative(ctx.workdir, searchDir) || ".",
      output: "No files found",
      metadata: {
        count: 0,
        truncated: false,
        pattern,
        searchPath: searchDir,
      },
    });
  }

  const output: string[] = finalMatches.map((item) => item.file);
  if (truncated) {
    output.push("");
    output.push(`(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`);
  }

  return wrapTextOutput(
    ctx,
    {
      title: normalizeRelative(ctx.workdir, searchDir) || ".",
      output: output.join("\n"),
      metadata: {
        count: matches.length,
        truncated,
        pattern,
        searchPath: searchDir,
      },
    },
    {
      maxLines: limit + 4,
    },
  );
}

export async function grep(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const pattern = readStringArg(args, "pattern") ?? "";
  if (!pattern.trim()) {
    throw new Error("pattern is required");
  }

  const pathArg = readStringArg(args, "path");
  const include = readStringArg(args, "include");
  const limit = Math.max(1, Math.floor(readNumberArg(args, "limit") ?? DEFAULT_GREP_LIMIT));
  const searchDir = pathArg ? resolvePathInWorkdir(ctx.workdir, pathArg) : ctx.workdir;
  const stat = await fs.stat(searchDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`grep path must be a directory: ${pathArg ?? "."}`);
  }

  const rg = resolveRgExecutable();
  if (rg) {
    return grepWithRipgrep({ ctx, rg, pattern, searchDir, include, limit });
  }
  return grepFallback({ ctx, pattern, searchDir, include, limit });
}

export async function webfetch(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const urlText = readStringArg(args, "url") ?? "";
  if (!urlText.trim()) {
    throw new Error("url is required");
  }
  if (!urlText.startsWith("http://") && !urlText.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }

  const format = readEnumArg(args, "format", WEBFETCH_FORMATS, "markdown");
  const timeoutSeconds = readNumberArg(args, "timeout");
  const timeoutMsRaw = readNumberArg(args, "timeoutMs");
  const timeoutMs = Math.min(
    timeoutMsRaw ?? (timeoutSeconds !== undefined ? timeoutSeconds * 1_000 : DEFAULT_WEBFETCH_TIMEOUT_MS),
    MAX_WEBFETCH_TIMEOUT_MS,
  );
  if (timeoutMs <= 0) {
    throw new Error("timeout must be greater than 0");
  }
  const maxBytes = Math.max(1, Math.floor(readNumberArg(args, "maxBytes") ?? DEFAULT_WEBFETCH_MAX_BYTES));
  const extraHeaders = readRecordArg(args, "headers");

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error(`Invalid URL: ${urlText}`);
  }

  const acceptHeader =
    format === "markdown"
      ? "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      : format === "text"
        ? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        : "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: acceptHeader,
    "Accept-Language": "en-US,en;q=0.9",
    ...(extraHeaders ?? {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const initial = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    const response =
      initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
        ? await fetch(url, {
            method: "GET",
            headers: {
              ...headers,
              "User-Agent": "opencode",
            },
            signal: controller.signal,
          })
        : initial;

    if (!response.ok) {
      throw new Error(`Request failed with status code: ${response.status}`);
    }

    const buffer = await readResponseBuffer(response, maxBytes);
    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const finalUrl = response.url || url.toString();
    const title = `${finalUrl} (${contentType})`;
    const isImage = isImageMediaType(mediaType);

    if (isImage) {
      const filename = resolveAttachmentFilename(url, response.headers.get("content-disposition"));
      return normalizePayload({
        title,
        output: "Image fetched successfully",
        metadata: {
          format,
          status: response.status,
          bytes: buffer.byteLength,
          contentType,
          url: finalUrl,
          truncated: false,
        },
        attachments: [
          {
            type: "file",
            url: `data:${mediaType};base64,${buffer.toString("base64")}`,
            mediaType,
            ...(filename ? { filename } : {}),
          },
        ],
      });
    }

    if (!isTextLikeContentType(contentType)) {
      return normalizePayload({
        title,
        output: "(Non-text response body omitted)",
        metadata: {
          format,
          status: response.status,
          bytes: buffer.byteLength,
          contentType,
          url: finalUrl,
          truncated: false,
        },
      });
    }

    const content = new TextDecoder().decode(buffer);
    let rendered = content;
    if (format === "markdown" && contentType.includes("text/html")) {
      rendered = await convertHtmlToMarkdown(content);
    } else if (format === "text" && contentType.includes("text/html")) {
      rendered = extractTextFromHtml(content);
    }

    const lines = [
      `[url] ${finalUrl}`,
      `[status] ${response.status} ${response.statusText}`,
      ...(contentType ? [`[content-type] ${contentType}`] : []),
      "",
      rendered.trimEnd(),
    ];

    return wrapTextOutput(ctx, {
      title,
      output: lines.join("\n"),
      metadata: {
        format,
        status: response.status,
        bytes: buffer.byteLength,
        contentType,
        url: finalUrl,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function task(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const description = readStringArg(args, "description") ?? "";
  const prompt = readStringArg(args, "prompt") ?? "";
  const subagentType = readStringArg(args, "subagent_type") ?? "general";
  const taskId = readStringArg(args, "task_id") ?? createTaskId();
  const command = readStringArg(args, "command");

  if (!description.trim()) {
    throw new Error("description is required");
  }
  if (!prompt.trim()) {
    throw new Error("prompt is required");
  }
  if (!(subagentType in TASK_AGENT_PROMPTS)) {
    throw new Error(`Unknown agent type: ${subagentType}`);
  }

  let session = taskSessions.get(taskId);
  if (!session) {
    const dotenvEnv = await loadDotenv(ctx.workdir);
    const runner = await createRunnerFromHarnessYaml({
      workdir: ctx.workdir,
      agentName: "opencode",
      entrypointFileName: "harness.yaml",
      instanceKey: taskId,
      env: { ...dotenvEnv, ...process.env },
      logger: QUIET_LOGGER,
    });
    session = {
      runner,
      subagentType,
    };
    taskSessions.set(taskId, session);
  }

  const result = await session.runner.processTurn(
    buildTaskPrompt({
      subagentType,
      description,
      prompt,
      command: command ?? undefined,
    }),
  );

  return wrapTextOutput(
    ctx,
    {
      title: description,
      output: [
        `task_id: ${taskId} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        result.finalResponseText.trim(),
        "</task_result>",
      ].join("\n"),
      metadata: {
        taskId,
        subagentType,
        stepCount: result.stepCount,
        finishReason: result.turnResult.finishReason,
      },
    },
  );
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed[\s\S]*?<\/embed>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function convertHtmlToMarkdown(html: string): Promise<string> {
  const module = await import("turndown");
  const TurndownService = module.default;
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  service.remove(["script", "style", "meta", "link"]);
  return service.turndown(html);
}

async function grepWithRipgrep(input: {
  ctx: ToolContext;
  rg: string;
  pattern: string;
  searchDir: string;
  include?: string;
  limit: number;
}): Promise<JsonValue> {
  const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|", "--regexp", input.pattern];
  if (input.include) {
    args.push("--glob", input.include);
  }
  args.push(input.searchDir);

  const child = spawn(input.rg, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { stdout, stderr, exitCode } = await collectSpawnOutput(child);

  if (exitCode === 1 || (exitCode === 2 && !stdout.trim())) {
    return normalizePayload({
      title: input.pattern,
      output: "No files found",
      metadata: {
        matches: 0,
        truncated: false,
      },
    });
  }

  if (exitCode !== 0 && exitCode !== 2) {
    throw new Error(`ripgrep failed: ${stderr}`);
  }

  const hasErrors = exitCode === 2;
  const matches: Array<{ path: string; modTime: number; lineNum: number; lineText: string }> = [];
  for (const line of stdout.trim().split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const [filePath, lineNumText, ...lineTextParts] = line.split("|");
    if (!filePath || !lineNumText || lineTextParts.length === 0) {
      continue;
    }
    const lineNum = Number.parseInt(lineNumText, 10);
    if (!Number.isFinite(lineNum)) {
      continue;
    }
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      continue;
    }
    matches.push({
      path: filePath,
      modTime: stat.mtime.getTime(),
      lineNum,
      lineText: lineTextParts.join("|"),
    });
  }

  matches.sort((left, right) => right.modTime - left.modTime);
  const truncated = matches.length > input.limit;
  const finalMatches = truncated ? matches.slice(0, input.limit) : matches;

  if (finalMatches.length === 0) {
    return normalizePayload({
      title: input.pattern,
      output: "No files found",
      metadata: {
        matches: 0,
        truncated: false,
      },
    });
  }

  const output: string[] = [`Found ${matches.length} matches${truncated ? ` (showing first ${input.limit})` : ""}`];
  let currentFile = "";
  for (const match of finalMatches) {
    if (currentFile !== match.path) {
      if (currentFile) {
        output.push("");
      }
      currentFile = match.path;
      output.push(`${match.path}:`);
    }
    const lineText =
      match.lineText.length > MAX_LINE_LENGTH ? `${match.lineText.substring(0, MAX_LINE_LENGTH)}...` : match.lineText;
    output.push(`  Line ${match.lineNum}: ${lineText}`);
  }

  if (truncated) {
    output.push("");
    output.push(
      `(Results truncated: showing ${input.limit} of ${matches.length} matches (${matches.length - input.limit} hidden). Consider using a more specific path or pattern.)`,
    );
  }
  if (hasErrors) {
    output.push("");
    output.push("(Some paths were inaccessible and skipped)");
  }

  return wrapTextOutput(
    input.ctx,
    {
      title: input.pattern,
      output: output.join("\n"),
      metadata: {
        matches: matches.length,
        truncated,
        include: input.include ?? "",
        searchPath: input.searchDir,
        hasErrors,
      },
    },
    {
      maxLines: input.limit + 20,
    },
  );
}

async function grepFallback(input: {
  ctx: ToolContext;
  pattern: string;
  searchDir: string;
  include?: string;
  limit: number;
}): Promise<JsonValue> {
  const expression = new RegExp(input.pattern);
  const candidates = await listFilesRecursively(input.searchDir, 20_000);
  const matches: Array<{ path: string; modTime: number; lineNum: number; lineText: string }> = [];

  for (const file of candidates) {
    const relative = normalizeRelative(input.searchDir, file);
    if (input.include && !matchesSimpleGlob(relative, input.include)) {
      continue;
    }
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > 1_000_000) {
      continue;
    }
    if (await isProbablyBinaryFile(file, Number(stat.size)).catch(() => true)) {
      continue;
    }

    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (content === null) {
      continue;
    }

    const lines = normalizeLineEndings(content).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? "";
      if (!expression.test(lineText)) {
        continue;
      }
      matches.push({
        path: file,
        modTime: stat.mtime.getTime(),
        lineNum: index + 1,
        lineText,
      });
    }
  }

  matches.sort((left, right) => right.modTime - left.modTime);
  const truncated = matches.length > input.limit;
  const finalMatches = truncated ? matches.slice(0, input.limit) : matches;

  if (finalMatches.length === 0) {
    return normalizePayload({
      title: input.pattern,
      output: "No files found",
      metadata: {
        matches: 0,
        truncated: false,
      },
    });
  }

  const output: string[] = [`Found ${matches.length} matches${truncated ? ` (showing first ${input.limit})` : ""}`];
  let currentFile = "";
  for (const match of finalMatches) {
    if (currentFile !== match.path) {
      if (currentFile) {
        output.push("");
      }
      currentFile = match.path;
      output.push(`${match.path}:`);
    }
    const lineText =
      match.lineText.length > MAX_LINE_LENGTH ? `${match.lineText.substring(0, MAX_LINE_LENGTH)}...` : match.lineText;
    output.push(`  Line ${match.lineNum}: ${lineText}`);
  }

  if (truncated) {
    output.push("");
    output.push(
      `(Results truncated: showing ${input.limit} of ${matches.length} matches (${matches.length - input.limit} hidden). Consider using a more specific path or pattern.)`,
    );
  }

  return wrapTextOutput(
    input.ctx,
    {
      title: input.pattern,
      output: output.join("\n"),
      metadata: {
        matches: matches.length,
        truncated,
        include: input.include ?? "",
        searchPath: input.searchDir,
      },
    },
    {
      maxLines: input.limit + 20,
    },
  );
}

type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: UpdateChunk[] };

interface UpdateChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  isEndOfFile?: boolean;
}

function stripHeredoc(input: string): string {
  const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (match) {
    return typeof match[2] === "string" ? match[2] : input;
  }
  return input;
}

function parsePatch(patchText: string): PatchHunk[] {
  const cleaned = stripHeredoc(normalizeLineEndings(patchText).trim());
  const lines = cleaned.split("\n");
  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";
  const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
  const endIndex = lines.findIndex((line) => line.trim() === endMarker);

  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    throw new Error("missing Begin/End markers");
  }

  const hunks: PatchHunk[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const line = lines[index] ?? "";

    if (line.startsWith("*** Add File:")) {
      const filePath = line.slice("*** Add File:".length).trim();
      if (!filePath) {
        throw new Error("Invalid Add File header (empty path)");
      }
      index += 1;
      let content = "";
      while (index < endIndex && !(lines[index] ?? "").startsWith("***")) {
        const nextLine = lines[index] ?? "";
        if (nextLine.startsWith("+")) {
          content += `${nextLine.slice(1)}\n`;
        }
        index += 1;
      }
      if (content.endsWith("\n")) {
        content = content.slice(0, -1);
      }
      hunks.push({ type: "add", path: filePath, contents: content });
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      const filePath = line.slice("*** Delete File:".length).trim();
      if (!filePath) {
        throw new Error("Invalid Delete File header (empty path)");
      }
      hunks.push({ type: "delete", path: filePath });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      const filePath = line.slice("*** Update File:".length).trim();
      if (!filePath) {
        throw new Error("Invalid Update File header (empty path)");
      }
      index += 1;

      let movePath: string | undefined;
      if (index < endIndex && (lines[index] ?? "").startsWith("*** Move to:")) {
        movePath = (lines[index] ?? "").slice("*** Move to:".length).trim();
        index += 1;
      }

      const chunks: UpdateChunk[] = [];
      while (index < endIndex && !(lines[index] ?? "").startsWith("***")) {
        const header = lines[index] ?? "";
        if (!header.startsWith("@@")) {
          index += 1;
          continue;
        }

        const contextLine = header.slice(2).trim();
        index += 1;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        let isEndOfFile = false;

        while (index < endIndex && !(lines[index] ?? "").startsWith("@@") && !(lines[index] ?? "").startsWith("***")) {
          const changeLine = lines[index] ?? "";
          if (changeLine === "*** End of File") {
            isEndOfFile = true;
            index += 1;
            break;
          }
          if (changeLine.startsWith(" ")) {
            const content = changeLine.slice(1);
            oldLines.push(content);
            newLines.push(content);
          } else if (changeLine.startsWith("-")) {
            oldLines.push(changeLine.slice(1));
          } else if (changeLine.startsWith("+")) {
            newLines.push(changeLine.slice(1));
          }
          index += 1;
        }

        chunks.push({
          oldLines,
          newLines,
          changeContext: contextLine.length > 0 ? contextLine : undefined,
          isEndOfFile: isEndOfFile || undefined,
        });
      }

      hunks.push({ type: "update", path: filePath, movePath, chunks });
      continue;
    }

    index += 1;
  }

  return hunks;
}

function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

type Comparator = (left: string, right: string) => boolean;

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  endOfFile: boolean,
): number {
  if (pattern.length === 0) {
    return -1;
  }

  if (endOfFile) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let index = 0; index < pattern.length; index += 1) {
        if (!compare(lines[fromEnd + index] ?? "", pattern[index] ?? "")) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return fromEnd;
      }
    }
  }

  for (let lineIndex = startIndex; lineIndex <= lines.length - pattern.length; lineIndex += 1) {
    let matches = true;
    for (let patternIndex = 0; patternIndex < pattern.length; patternIndex += 1) {
      if (!compare(lines[lineIndex + patternIndex] ?? "", pattern[patternIndex] ?? "")) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return lineIndex;
    }
  }
  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, endOfFile = false): number {
  const exact = tryMatch(lines, pattern, startIndex, (left, right) => left === right, endOfFile);
  if (exact !== -1) {
    return exact;
  }

  const rstrip = tryMatch(lines, pattern, startIndex, (left, right) => left.trimEnd() === right.trimEnd(), endOfFile);
  if (rstrip !== -1) {
    return rstrip;
  }

  const trimmed = tryMatch(lines, pattern, startIndex, (left, right) => left.trim() === right.trim(), endOfFile);
  if (trimmed !== -1) {
    return trimmed;
  }

  return tryMatch(
    lines,
    pattern,
    startIndex,
    (left, right) => normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
    endOfFile,
  );
}

function computeReplacements(lines: string[], chunks: UpdateChunk[], filePath: string): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const found = seekSequence(lines, [chunk.changeContext], lineIndex);
      if (found === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = found + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile === true);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.length > 0 && replacement[replacement.length - 1] === "") {
        replacement = replacement.slice(0, -1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile === true);
    }

    if (found === -1) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
    }

    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (!replacement) {
      continue;
    }
    const [startIndex, oldLength, newSegment] = replacement;
    result.splice(startIndex, oldLength, ...newSegment);
  }
  return result;
}

async function applyUpdateHunk(
  workdir: string,
  hunk: Extract<PatchHunk, { type: "update" }>,
): Promise<{ type: "update" | "move"; path: string; movePath?: string; before: string; after: string }> {
  const absoluteOldPath = resolvePathInWorkdir(workdir, hunk.path);
  const oldContent = await fs.readFile(absoluteOldPath, "utf8");
  const originalLines = normalizeLineEndings(oldContent).split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, hunk.chunks, absoluteOldPath);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }
  const newContent = newLines.join("\n");

  const absoluteTargetPath = hunk.movePath ? resolvePathInWorkdir(workdir, hunk.movePath) : absoluteOldPath;
  await fs.mkdir(path.dirname(absoluteTargetPath), { recursive: true });
  await fs.writeFile(absoluteTargetPath, newContent, "utf8");

  if (hunk.movePath) {
    await fs.unlink(absoluteOldPath);
    return {
      type: "move",
      path: absoluteOldPath,
      movePath: absoluteTargetPath,
      before: oldContent,
      after: newContent,
    };
  }

  return {
    type: "update",
    path: absoluteTargetPath,
    before: oldContent,
    after: newContent,
  };
}

export async function apply_patch(ctx: ToolContext, args: JsonObject): Promise<JsonValue> {
  const patchText = readStringArg(args, "patchText") ?? "";
  if (!patchText.trim()) {
    throw new Error("patchText is required");
  }

  const normalizedPatch = normalizeLineEndings(patchText).trim();
  let hunks: PatchHunk[];
  try {
    hunks = parsePatch(patchText);
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (hunks.length === 0) {
    if (normalizedPatch === "*** Begin Patch\n*** End Patch") {
      throw new Error("patch rejected: empty patch");
    }
    throw new Error("apply_patch verification failed: no hunks found");
  }

  const changes: Array<{
    type: "add" | "update" | "delete" | "move";
    filePath: string;
    movePath?: string;
    before: string;
    after: string;
  }> = [];

  for (const hunk of hunks) {
    try {
      if (hunk.type === "add") {
        const absolutePath = resolvePathInWorkdir(ctx.workdir, hunk.path);
        const exists = await fs.stat(absolutePath).then(() => true).catch(() => false);
        if (exists) {
          throw new Error(`File already exists: ${absolutePath}`);
        }
        const newContent =
          hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`;
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, newContent, "utf8");
        changes.push({
          type: "add",
          filePath: absolutePath,
          before: "",
          after: newContent,
        });
        continue;
      }

      if (hunk.type === "delete") {
        const absolutePath = resolvePathInWorkdir(ctx.workdir, hunk.path);
        const oldContent = await fs.readFile(absolutePath, "utf8");
        await fs.unlink(absolutePath);
        changes.push({
          type: "delete",
          filePath: absolutePath,
          before: oldContent,
          after: "",
        });
        continue;
      }

      const updated = await applyUpdateHunk(ctx.workdir, hunk);
      changes.push({
        type: updated.type,
        filePath: updated.path,
        movePath: updated.movePath,
        before: updated.before,
        after: updated.after,
      });
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const summary = changes.map((change) => {
    if (change.type === "add") {
      return `A ${normalizeRelative(ctx.workdir, change.filePath)}`;
    }
    if (change.type === "delete") {
      return `D ${normalizeRelative(ctx.workdir, change.filePath)}`;
    }
    return `M ${normalizeRelative(ctx.workdir, change.movePath ?? change.filePath)}`;
  });

  const files = changes.map((change) => ({
    filePath: change.filePath,
    relativePath: normalizeRelative(ctx.workdir, change.movePath ?? change.filePath),
    type: change.type,
    before: change.before,
    after: change.after,
    ...(change.movePath ? { movePath: change.movePath } : {}),
  }));

  return wrapTextOutput(
    ctx,
    {
      title: "apply_patch",
      output: `Success. Updated the following files:\n${summary.join("\n")}`,
      metadata: {
        diff: normalizedPatch,
        files,
        changed: summary,
        count: summary.length,
      },
    },
    {
      maxLines: 200,
    },
  );
}

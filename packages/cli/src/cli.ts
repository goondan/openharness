import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const OPENHARNESS_MODULE_NAME = "@goondan/openharness";

type Command = "repl" | "run";

interface CliOptions {
  workdir: string;
  entrypointFileName: string;
  agentName?: string;
  conversationId?: string;
  stateRoot?: string;
  maxSteps?: number;
}

interface ParsedArgs {
  command: Command;
  commandArgs: string[];
  options: CliOptions;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function usage(): string {
  return [
    "OpenHarness CLI",
    "",
    "Usage:",
    "  oh [options]                 # REPL (default). Use /exit to quit.",
    "  oh repl [options]            # REPL",
    "  oh run <text> [options]      # One-shot execution (single turn)",
    "",
    "Options:",
    "  --workdir <path>       harness.yaml을 찾을 기준 디렉토리 (default: cwd)",
    "  --entrypoint <file>    엔트리포인트 파일명 (default: harness.yaml)",
    "  --agent <name>         실행할 Agent 이름",
    "  --conversation <id>      conversationId",
    "  --state-root <path>    상태 저장 루트 (.goondan 대체)",
    "  --max-steps <n>        turn 당 최대 step",
    "  -h, --help             도움말",
  ].join("\n");
}

function printError(message: string): void {
  process.stderr.write(`${message.trimEnd()}\n`);
}

function parseNumberOption(raw: string, optionName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${optionName}는 1 이상의 정수여야 합니다: ${raw}`);
  }
  return n;
}

function resolveShellCwd(): string {
  const pwd = process.env.PWD;
  if (typeof pwd === "string" && pwd.trim().length > 0 && path.isAbsolute(pwd)) {
    return pwd;
  }
  return process.cwd();
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = content.replace(/^\uFEFF/, ""); // strip BOM
  const lines = normalized.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const withoutExport = trimmedLine.startsWith("export ") ? trimmedLine.slice("export ".length).trim() : trimmedLine;
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, eqIndex).trim();
    if (key.length === 0) {
      continue;
    }

    let value = withoutExport.slice(eqIndex + 1).trim();
    if (value.length === 0) {
      out[key] = "";
      continue;
    }

    const first = value[0];
    const last = value[value.length - 1];
    const isSingleQuoted = first === "'" && last === "'" && value.length >= 2;
    const isDoubleQuoted = first === '"' && last === '"' && value.length >= 2;

    if (isSingleQuoted) {
      out[key] = value.slice(1, -1);
      continue;
    }

    if (isDoubleQuoted) {
      const inner = value.slice(1, -1);
      out[key] = inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
      continue;
    }

    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trimEnd();
    }

    out[key] = value;
  }

  return out;
}

async function loadDotenv(workdir: string): Promise<Record<string, string>> {
  const envPath = path.join(workdir, ".env");
  try {
    const content = await readFile(envPath, "utf8");
    return parseDotenv(content);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as any).code : undefined;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const shellCwd = resolveShellCwd();
  const options: CliOptions = {
    workdir: shellCwd,
    entrypointFileName: "harness.yaml",
  };

  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--") {
      // pnpm scripts often inject a leading `--` (e.g. `node dist/bin.js -- ...`).
      // Treat the leading one as a no-op separator.
      if (i === 0) {
        continue;
      }

      // For users, keep the conventional "end of options" behavior.
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      positionals.push("--help");
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const key = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg;
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    const readValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`${key} 옵션은 값을 필요로 합니다.`);
      }
      i += 1;
      return next;
    };

    switch (key) {
      case "--workdir": {
        const value = readValue();
        options.workdir = path.resolve(shellCwd, value);
        break;
      }
      case "--entrypoint": {
        const value = readValue();
        options.entrypointFileName = path.basename(value);
        break;
      }
      case "--agent": {
        const value = readValue();
        options.agentName = value;
        break;
      }
      case "--conversation": {
        const value = readValue();
        options.conversationId = value;
        break;
      }
      case "--state-root": {
        const value = readValue();
        options.stateRoot = path.resolve(shellCwd, value);
        break;
      }
      case "--max-steps": {
        const value = readValue();
        options.maxSteps = parseNumberOption(value, "--max-steps");
        break;
      }
      default:
        throw new Error(`알 수 없는 옵션입니다: ${key}`);
    }
  }

  if (positionals.includes("--help")) {
    return { command: "repl", commandArgs: ["--help"], options };
  }

  const [maybeCommand, ...rest] = positionals;
  if (!maybeCommand) {
    return { command: "repl", commandArgs: [], options };
  }

  if (maybeCommand === "repl") {
    return { command: "repl", commandArgs: rest, options };
  }

  if (maybeCommand === "run") {
    return { command: "run", commandArgs: rest, options };
  }

  throw new Error(`알 수 없는 명령입니다: ${maybeCommand}\n\n${usage()}`);
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

function extractFinalText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (!isRecord(result)) {
    return "";
  }

  const turnResult = result.turnResult;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  if (isRecord(turnResult)) {
    const error = turnResult.error;
    if (isRecord(error)) {
      errorCode = typeof error.code === "string" ? error.code : undefined;
      errorMessage = typeof error.message === "string" ? error.message : undefined;
    }
  }

  const candidates = [
    result.finalResponseText,
    result.responseText,
    result.text,
    result.outputText,
  ];
  for (const value of candidates) {
    if (typeof value === "string") {
      if (
        errorMessage
        && (errorCode === "E_PERMISSION_REJECTED" || errorCode === "E_PERMISSION_DENIED" || errorCode === "E_DOOM_LOOP")
      ) {
        const trimmed = value.trim();
        return trimmed.length > 0 ? `${trimmed}\n\n${errorMessage}` : errorMessage;
      }
      return value;
    }
  }

  if (isRecord(turnResult)) {
    const responseMessage = turnResult.responseMessage;
    if (isRecord(responseMessage)) {
      const data = responseMessage.data;
      if (isRecord(data) && typeof data.content === "string") {
        return data.content;
      }
    }
  }

  return errorMessage ?? "";
}

async function loadCreateRunnerFromHarnessYaml(): Promise<(opts: unknown) => unknown> {
  try {
    const mod: any = await import(OPENHARNESS_MODULE_NAME);
    const fn = mod?.createRunnerFromHarnessYaml;
    if (typeof fn !== "function") {
      throw new Error(
        [
          `[openharness-cli] ${OPENHARNESS_MODULE_NAME}가 createRunnerFromHarnessYaml()을 export하지 않습니다.`,
          "",
          "이 CLI는 harness.yaml 기반 실행을 위해 해당 API가 필요합니다.",
          `- 해결: ${OPENHARNESS_MODULE_NAME}를 createRunnerFromHarnessYaml을 포함한 버전으로 업데이트하세요.`,
        ].join("\n"),
      );
    }
    return fn as (opts: unknown) => unknown;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(
      `[openharness-cli] ${OPENHARNESS_MODULE_NAME} 로드 중 오류가 발생했습니다: ${String(error)}`,
    );
  }
}

async function createRunner(options: CliOptions): Promise<{ processTurn: (text: string) => Promise<unknown>; close: () => Promise<void> }> {
  const createRunnerFromHarnessYaml = await loadCreateRunnerFromHarnessYaml();

  const dotenvEnv = await loadDotenv(options.workdir);

  const runnerOptions: AnyRecord = {
    workdir: options.workdir,
    entrypointFileName: options.entrypointFileName,
    logger: console,
    env: { ...dotenvEnv, ...process.env },
  };
  if (isNonEmptyString(options.agentName)) {
    runnerOptions.agentName = options.agentName;
  }
  if (isNonEmptyString(options.conversationId)) {
    runnerOptions.conversationId = options.conversationId;
  }
  if (isNonEmptyString(options.stateRoot)) {
    runnerOptions.stateRoot = options.stateRoot;
  }
  if (typeof options.maxSteps === "number") {
    runnerOptions.maxSteps = options.maxSteps;
  }

  const runner: any = await Promise.resolve(createRunnerFromHarnessYaml(runnerOptions));
  const processTurn = runner?.processTurn;
  const close = runner?.close;

  if (typeof processTurn !== "function") {
    throw new Error("[openharness-cli] runner.processTurn(text) 함수가 필요합니다. createRunnerFromHarnessYaml 반환값을 확인하세요.");
  }

  return {
    processTurn: async (text: string): Promise<unknown> => Promise.resolve(processTurn.call(runner, text)),
    close: async (): Promise<void> => {
      if (typeof close === "function") {
        await Promise.resolve(close.call(runner));
      }
    },
  };
}

async function runOneShot(text: string, options: CliOptions): Promise<number> {
  const runner = await createRunner(options);
  try {
    const result = await runner.processTurn(text);
    const output = extractFinalText(result);
    process.stdout.write(`${output}\n`);
    return 0;
  } finally {
    await runner.close();
  }
}

async function readReplLine(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

async function runRepl(options: CliOptions): Promise<number> {
  const runner = await createRunner(options);
  const prompt = "oh> ";
  try {
    while (true) {
      const line = await readReplLine(prompt);
      if (line === null) {
        break;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      if (trimmed === "/exit") {
        break;
      }

      const result = await runner.processTurn(line);
      const output = extractFinalText(result).trimEnd();
      process.stdout.write(output.length > 0 ? `${output}\n` : "\n");
    }

    return 0;
  } finally {
    await runner.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  try {
    const parsed = parseArgs(argv);

    if (parsed.commandArgs.includes("--help")) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    if (parsed.command === "run") {
      const text = parsed.commandArgs.join(" ").trim();
      if (text.length === 0) {
        throw new Error(`oh run은 실행할 텍스트가 필요합니다.\n\n${usage()}`);
      }
      const code = await runOneShot(text, parsed.options);
      process.exitCode = code;
      return;
    }

    const code = await runRepl(parsed.options);
    process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(message);
    process.exitCode = 1;
  }
}

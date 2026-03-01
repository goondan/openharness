import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';
import {
  optionalJsonObject,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireString,
  resolveFromWorkdir,
} from '../utils.js';

interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface RunProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function createEnvironment(input: JsonObject | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (!input) {
    return env;
  }

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      env[key] = String(value);
      continue;
    }
    throw new Error(`env.${key} must be a primitive string/number/boolean value`);
  }

  return env;
}

async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions
): Promise<ProcessRunResult> {
  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');

        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 100);
      }, options.timeoutMs);
    }

    child.once('error', (error) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      reject(error);
    });

    child.once('close', (code, signal) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      resolve({
        stdout,
        stderr,
        exitCode: code === null ? -1 : code,
        signal,
        timedOut,
      });
    });
  });
}

export const exec: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const command = requireString(input, 'command');
  const cwdInput = optionalString(input, 'cwd');
  const timeoutMs = optionalNumber(input, 'timeoutMs', 30_000) ?? 30_000;
  const env = createEnvironment(optionalJsonObject(input, 'env'));

  const workdir = cwdInput ? resolveFromWorkdir(_ctx.workdir, cwdInput) : _ctx.workdir;
  const startedAt = Date.now();
  const result = await runProcess('/bin/sh', ['-lc', command], {
    cwd: workdir,
    env,
    timeoutMs,
  });

  return {
    command,
    cwd: workdir,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  };
};

export const script: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const path = requireString(input, 'path');
  const scriptPath = resolveFromWorkdir(_ctx.workdir, path);
  const args = optionalStringArray(input, 'args') ?? [];
  const shell = optionalString(input, 'shell') ?? '/bin/bash';
  const timeoutMs = optionalNumber(input, 'timeoutMs', 30_000) ?? 30_000;
  const env = createEnvironment(optionalJsonObject(input, 'env'));

  await access(scriptPath, constants.F_OK);

  const startedAt = Date.now();
  const result = await runProcess(shell, [scriptPath, ...args], {
    cwd: _ctx.workdir,
    env,
    timeoutMs,
  });

  return {
    path: scriptPath,
    shell,
    args,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  };
};

export const handlers = {
  exec,
  script,
} satisfies Record<string, ToolHandler>;

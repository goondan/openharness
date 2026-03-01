import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bashHandlers,
  fileSystemHandlers,
  waitHandlers,
} from '../src/tools/index.js';
import type { JsonObject, JsonValue } from '../src/types.js';
import { isJsonObject } from '../src/utils.js';
import { createTempWorkspace, createToolContext } from './helpers.js';

function assertJsonObject(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected JSON object output');
  }
  return value;
}

describe('base tools', () => {
  it('bash__exec executes shell command', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await bashHandlers.exec(ctx, { command: 'printf hello' });
      const result = assertJsonObject(output);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello');
    } finally {
      await workspace.cleanup();
    }
  });

  it('bash__script executes script file with args', async () => {
    const workspace = await createTempWorkspace();
    try {
      const scriptPath = join(workspace.path, 'script.sh');
      await writeFile(scriptPath, 'echo "script:$1"\n', 'utf8');
      await chmod(scriptPath, 0o755);

      const ctx = createToolContext(workspace.path);
      const output = await bashHandlers.script(ctx, {
        path: 'script.sh',
        args: ['ok'],
      });
      const result = assertJsonObject(output);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('script:ok');
    } finally {
      await workspace.cleanup();
    }
  });

  it('file-system handlers support write/read/list/mkdir', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);

      const mkdirResult = await fileSystemHandlers.mkdir(ctx, {
        path: 'logs',
      });
      const mkdirOutput = assertJsonObject(mkdirResult);
      expect(mkdirOutput.created).toBe(true);

      const writeResult = await fileSystemHandlers.write(ctx, {
        path: 'logs/a.txt',
        content: 'alpha',
      });
      const writeOutput = assertJsonObject(writeResult);
      expect(writeOutput.written).toBe(true);

      const readResult = await fileSystemHandlers.read(ctx, {
        path: 'logs/a.txt',
      });
      const readOutput = assertJsonObject(readResult);
      expect(readOutput.content).toBe('alpha');

      const listResult = await fileSystemHandlers.list(ctx, {
        path: 'logs',
      });
      const listOutput = assertJsonObject(listResult);
      const entriesValue = listOutput.entries;
      expect(Array.isArray(entriesValue)).toBe(true);

      const savedContent = await readFile(join(workspace.path, 'logs/a.txt'), 'utf8');
      expect(savedContent).toBe('alpha');
    } finally {
      await workspace.cleanup();
    }
  });

  it('wait__seconds delays for the requested duration', async () => {
    const workspace = await createTempWorkspace();
    vi.useFakeTimers();
    try {
      const ctx = createToolContext(workspace.path);
      const promise = waitHandlers.seconds(ctx, {
        seconds: 1.5,
      });
      await vi.advanceTimersByTimeAsync(1500);

      const output = await promise;
      const result = assertJsonObject(output);
      expect(result.waitedSeconds).toBe(1.5);
      expect(result.waitedMs).toBe(1500);

      await expect(
        waitHandlers.seconds(ctx, {
          seconds: 301,
        }),
      ).rejects.toThrow("'seconds' must be less than or equal to 300");
    } finally {
      vi.useRealTimers();
      await workspace.cleanup();
    }
  });
});

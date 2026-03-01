import {
  appendFile,
  mkdir as mkdirAsync,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  resolveFromWorkdir,
} from '../utils.js';

interface FileListEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

function toJsonEntries(entries: FileListEntry[]): JsonObject[] {
  const output: JsonObject[] = [];
  for (const entry of entries) {
    const row: JsonObject = {
      name: entry.name,
      path: entry.path,
      type: entry.type,
    };
    if (entry.size !== undefined) {
      row.size = entry.size;
    }
    output.push(row);
  }
  return output;
}

async function collectDirectoryEntries(
  targetDir: string,
  recursive: boolean,
  includeDirs: boolean,
  includeFiles: boolean,
  output: FileListEntry[]
): Promise<void> {
  const entries = await readdir(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      if (includeDirs) {
        output.push({
          name: entry.name,
          path: fullPath,
          type: 'dir',
        });
      }

      if (recursive) {
        await collectDirectoryEntries(fullPath, recursive, includeDirs, includeFiles, output);
      }
      continue;
    }

    if (includeFiles && entry.isFile()) {
      const detail = await stat(fullPath);
      output.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: detail.size,
      });
    }
  }
}

export const read: ToolHandler = async (ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const path = requireString(input, 'path');
  const maxBytes = optionalNumber(input, 'maxBytes', 100_000) ?? 100_000;

  if (maxBytes < 1) {
    throw new Error(`'maxBytes' must be greater than 0`);
  }

  const targetPath = resolveFromWorkdir(ctx.workdir, path);
  const buffer = await readFile(targetPath);
  const size = buffer.byteLength;
  const truncated = size > maxBytes;

  return {
    path: targetPath,
    size,
    truncated,
    content: buffer.subarray(0, Math.min(size, maxBytes)).toString('utf8'),
  };
};

export const write: ToolHandler = async (ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const path = requireString(input, 'path');
  const content = requireString(input, 'content');
  const append = optionalBoolean(input, 'append', false) ?? false;
  const targetPath = resolveFromWorkdir(ctx.workdir, path);

  await mkdirAsync(dirname(targetPath), { recursive: true });
  if (append) {
    await appendFile(targetPath, content, 'utf8');
  } else {
    await writeFile(targetPath, content, 'utf8');
  }

  const detail = await stat(targetPath);
  return {
    path: targetPath,
    size: detail.size,
    written: true,
    append,
  };
};

export const list: ToolHandler = async (ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const path = optionalString(input, 'path') ?? '.';
  const recursive = optionalBoolean(input, 'recursive', false) ?? false;
  const includeDirs = optionalBoolean(input, 'includeDirs', true) ?? true;
  const includeFiles = optionalBoolean(input, 'includeFiles', true) ?? true;

  const targetPath = resolveFromWorkdir(ctx.workdir, path);
  const entries: FileListEntry[] = [];
  await collectDirectoryEntries(targetPath, recursive, includeDirs, includeFiles, entries);

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    path: targetPath,
    recursive,
    count: entries.length,
    entries: toJsonEntries(entries),
  };
};

export const mkdir: ToolHandler = async (ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const path = requireString(input, 'path');
  const recursive = optionalBoolean(input, 'recursive', true) ?? true;

  const targetPath = resolveFromWorkdir(ctx.workdir, path);
  await mkdirAsync(targetPath, { recursive });

  return {
    path: targetPath,
    created: true,
    recursive,
  };
};

export const handlers = {
  read,
  write,
  list,
  mkdir,
} satisfies Record<string, ToolHandler>;

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

interface SnapshotEntry {
  mtimeMs: number;
  size: number;
  sha1: string;
}

export interface WorkspaceSnapshot {
  entries: Map<string, SnapshotEntry>;
}

const IGNORED_DIR_NAMES = new Set([".git", "node_modules", ".openharness", "dist"]);

function normalizeRelative(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

async function sha1File(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha1").update(content).digest("hex");
}

async function walk(root: string, current: string, entries: Map<string, SnapshotEntry>): Promise<void> {
  const dirents = await fs.readdir(current, { withFileTypes: true }).catch(() => []);

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".") && dirent.name !== ".env" && IGNORED_DIR_NAMES.has(dirent.name)) {
      continue;
    }

    const absolutePath = path.join(current, dirent.name);
    const relativePath = normalizeRelative(path.relative(root, absolutePath));

    if (dirent.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(dirent.name)) {
        continue;
      }
      await walk(root, absolutePath, entries);
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    const stat = await fs.stat(absolutePath).catch(() => undefined);
    if (!stat) {
      continue;
    }

    entries.set(relativePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha1: await sha1File(absolutePath),
    });
  }
}

export async function captureWorkspaceSnapshot(workdir: string): Promise<WorkspaceSnapshot> {
  const root = path.resolve(workdir);
  const entries = new Map<string, SnapshotEntry>();
  await walk(root, root, entries);
  return { entries };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): { files: string[]; hash: string } {
  const files = new Set<string>();

  for (const [filePath, afterEntry] of after.entries) {
    const beforeEntry = before.entries.get(filePath);
    if (!beforeEntry) {
      files.add(filePath);
      continue;
    }
    if (
      beforeEntry.mtimeMs !== afterEntry.mtimeMs
      || beforeEntry.size !== afterEntry.size
      || beforeEntry.sha1 !== afterEntry.sha1
    ) {
      files.add(filePath);
    }
  }

  for (const filePath of before.entries.keys()) {
    if (!after.entries.has(filePath)) {
      files.add(filePath);
    }
  }

  const sortedFiles = Array.from(files).sort();
  const hash = createHash("sha1").update(sortedFiles.join("\n")).digest("hex");
  return {
    files: sortedFiles,
    hash,
  };
}

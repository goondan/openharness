#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(cliDir, "dist", "bin.js");
const commandName = "oh";

function readPathEntries() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectCandidateDirs() {
  const candidates = [];
  const seen = new Set();

  const add = (value) => {
    if (!value) {
      return;
    }
    const normalized = path.resolve(value);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(process.env.OH_GLOBAL_BIN_DIR);

  const homeLocalBin = path.join(os.homedir(), ".local", "bin");
  if (readPathEntries().includes(homeLocalBin)) {
    add(homeLocalBin);
  }

  if (process.env.PNPM_HOME) {
    add(process.env.PNPM_HOME);
  }

  if (candidates.length === 0) {
    try {
      const npmPrefix = execFileSync("npm", ["prefix", "-g"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
        },
      }).trim();
      if (npmPrefix) {
        add(path.join(npmPrefix, "bin"));
      }
    } catch {
      // ignore
    }
  }

  add(homeLocalBin);
  return candidates;
}

async function ensureSymlink(binDir) {
  await fs.mkdir(binDir, { recursive: true });
  const linkPath = path.join(binDir, commandName);

  const existing = await fs.lstat(linkPath).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath).catch(() => "");
      const resolvedCurrentTarget = path.resolve(path.dirname(linkPath), currentTarget);
      if (resolvedCurrentTarget === target) {
        return linkPath;
      }
    }
    await fs.rm(linkPath, { force: true });
  }

  const relativeTarget = path.relative(binDir, target);
  await fs.symlink(relativeTarget, linkPath);
  return linkPath;
}

async function main() {
  await fs.access(target);
  await fs.chmod(target, 0o755);

  const candidates = collectCandidateDirs();
  let lastError;
  for (const binDir of candidates) {
    try {
      const linkPath = await ensureSymlink(binDir);
      process.stdout.write(`[openharness-cli] linked '${commandName}' -> ${linkPath}\n`);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("no writable global bin directory found");
}

await main();

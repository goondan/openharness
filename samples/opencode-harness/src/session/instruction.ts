import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const;

const claimedByTurn = new Map<string, Set<string>>();

export interface ResolvedInstruction {
  filepath: string;
  content: string;
}

function normalize(filePath: string): string {
  return path.resolve(filePath);
}

function getClaims(turnId: string): Set<string> {
  let claims = claimedByTurn.get(turnId);
  if (!claims) {
    claims = new Set<string>();
    claimedByTurn.set(turnId, claims);
  }
  return claims;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findInstructionInDirectory(dir: string): Promise<string | undefined> {
  for (const file of FILES) {
    const candidate = normalize(path.join(dir, file));
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isDisabled(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true";
}

function globalInstructionCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.OPENHARNESS_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR;
  if (configured) {
    candidates.push(path.join(configured, "AGENTS.md"));
  }
  candidates.push(path.join(os.homedir(), ".config", "openharness", "AGENTS.md"));
  candidates.push(path.join(os.homedir(), ".config", "opencode", "AGENTS.md"));

  if (!isDisabled("OPENHARNESS_DISABLE_CLAUDE_CODE_PROMPT") && !isDisabled("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT")) {
    candidates.push(path.join(os.homedir(), ".claude", "CLAUDE.md"));
  }

  return candidates.map((item) => normalize(item));
}

export function clearInstructionClaims(turnId: string): void {
  claimedByTurn.delete(turnId);
}

export async function resolveSystemInstructionPaths(workdir: string): Promise<string[]> {
  const resolved = new Set<string>();
  if (!isDisabled("OPENHARNESS_DISABLE_PROJECT_CONFIG") && !isDisabled("OPENCODE_DISABLE_PROJECT_CONFIG")) {
    let current = normalize(workdir);
    let previous = "";

    while (current !== previous) {
      const found = await findInstructionInDirectory(current);
      if (found) {
        resolved.add(found);
        break;
      }
      previous = current;
      current = path.dirname(current);
    }
  }

  for (const candidate of globalInstructionCandidates()) {
    if (await exists(candidate)) {
      resolved.add(candidate);
      break;
    }
  }

  return Array.from(resolved);
}

export async function loadSystemInstructions(workdir: string): Promise<ResolvedInstruction[]> {
  const results = await Promise.all(
    (await resolveSystemInstructionPaths(workdir)).map(async (filepath) => {
      const content = await fs.readFile(filepath, "utf8").catch(() => "");
      if (!content.trim()) {
        return undefined;
      }
      return {
        filepath,
        content: `Instructions from: ${filepath}\n${content}`,
      };
    }),
  );

  return results.filter((item): item is ResolvedInstruction => item !== undefined);
}

export async function resolveFileInstructions(input: {
  turnId: string;
  targetPath: string;
  workdir: string;
  alreadyLoaded?: Iterable<string>;
}): Promise<ResolvedInstruction[]> {
  const target = normalize(input.targetPath);
  const root = normalize(input.workdir);
  const claims = getClaims(input.turnId);
  const loaded = new Set<string>(Array.from(input.alreadyLoaded ?? [], (item) => normalize(item)));
  const system = new Set(await resolveSystemInstructionPaths(input.workdir));
  const results: ResolvedInstruction[] = [];

  let current = path.dirname(target);
  while (current.startsWith(root) && current !== root) {
    const found = await findInstructionInDirectory(current);
    if (!found || found === target || claims.has(found) || loaded.has(found) || system.has(found)) {
      current = path.dirname(current);
      continue;
    }

    const content = await fs.readFile(found, "utf8").catch(() => undefined);
    if (content && content.trim().length > 0) {
      claims.add(found);
      results.push({
        filepath: found,
        content: `Instructions from: ${found}\n${content}`,
      });
    }

    current = path.dirname(current);
  }

  return results;
}

export async function resolveLocalInstructions(input: {
  turnId: string;
  filePath: string;
  workdir: string;
  alreadyLoaded?: Iterable<string>;
}): Promise<ResolvedInstruction[]> {
  return resolveFileInstructions({
    turnId: input.turnId,
    targetPath: input.filePath,
    workdir: input.workdir,
    alreadyLoaded: input.alreadyLoaded,
  });
}

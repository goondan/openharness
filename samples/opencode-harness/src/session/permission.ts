import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export interface PermissionRequest {
  workdir: string;
  permission: string;
  patterns: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
}

interface PermissionState {
  version: 1;
  rules: PermissionRule[];
}

const PERMISSION_DIR = path.join(".openharness");
const PERMISSION_FILE = path.join(PERMISSION_DIR, "permissions.json");

function permissionFilePath(workdir: string): string {
  return path.join(workdir, PERMISSION_FILE);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  const source = escapeRegExp(normalized).replaceAll("\\*", ".*");
  return new RegExp(`^${source}$`);
}

function matches(pattern: string, value: string): boolean {
  return wildcardToRegExp(pattern).test(value.replaceAll("\\", "/"));
}

async function loadPermissionState(workdir: string): Promise<PermissionState> {
  const filepath = permissionFilePath(workdir);
  const content = await fs.readFile(filepath, "utf8").catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  });

  if (!content.trim()) {
    return {
      version: 1,
      rules: [],
    };
  }

  const parsed = JSON.parse(content) as Partial<PermissionState>;
  return {
    version: 1,
    rules: Array.isArray(parsed.rules)
      ? parsed.rules.filter(
          (rule): rule is PermissionRule =>
            typeof rule === "object"
            && rule !== null
            && typeof rule.permission === "string"
            && typeof rule.pattern === "string"
            && (rule.action === "allow" || rule.action === "deny" || rule.action === "ask"),
        )
      : [],
  };
}

async function savePermissionState(workdir: string, state: PermissionState): Promise<void> {
  const filepath = permissionFilePath(workdir);
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(state, null, 2), "utf8");
}

export function evaluatePermission(permission: string, pattern: string, rules: readonly PermissionRule[]): PermissionRule {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!rule) {
      continue;
    }
    if (matches(rule.permission, permission) && matches(rule.pattern, pattern)) {
      return rule;
    }
  }

  return {
    permission,
    pattern: "*",
    action: "ask",
  };
}

function formatMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return "(none)";
  }
  return JSON.stringify(metadata, null, 2);
}

async function promptPermission(request: PermissionRequest): Promise<"once" | "always" | "reject"> {
  const mode = process.env.OH_PERMISSION_MODE ?? process.env.OPENCODE_PERMISSION_MODE;
  if (mode === "allow") {
    return "always";
  }
  if (mode === "once") {
    return "once";
  }
  if (mode === "deny") {
    return "reject";
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new PermissionRejectedError("permission prompt requires an interactive TTY or OH_PERMISSION_MODE=allow|once");
  }

  const prompt = [
    "",
    "OpenCode permission request",
    `permission: ${request.permission}`,
    "patterns:",
    ...request.patterns.map((pattern) => `- ${pattern}`),
    "metadata:",
    formatMetadata(request.metadata),
    "",
    "Allow? [y] once / [a] always / [n] reject",
  ].join("\n");

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await readline.question(`${prompt}\n> `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes" || answer === "once") {
        return "once";
      }
      if (answer === "a" || answer === "always") {
        return "always";
      }
      if (answer === "n" || answer === "no" || answer === "reject") {
        return "reject";
      }
      process.stdout.write("y / a / n 중 하나를 입력하세요.\n");
    }
  } finally {
    readline.close();
  }
}

export async function requestPermission(request: PermissionRequest): Promise<void> {
  const state = await loadPermissionState(request.workdir);

  for (const pattern of request.patterns) {
    const rule = evaluatePermission(request.permission, pattern, state.rules);
    if (rule.action === "deny") {
      throw new PermissionDeniedError(`Permission denied for ${request.permission}: ${pattern}`);
    }
  }

  const requiresPrompt = request.patterns.some(
    (pattern) => evaluatePermission(request.permission, pattern, state.rules).action === "ask",
  );
  if (!requiresPrompt) {
    return;
  }

  const reply = await promptPermission(request);
  if (reply === "reject") {
    throw new PermissionRejectedError(`Permission rejected for ${request.permission}`);
  }

  if (reply === "always") {
    const patterns = request.always && request.always.length > 0 ? request.always : request.patterns;
    state.rules.push(
      ...patterns.map((pattern) => ({
        permission: request.permission,
        pattern,
        action: "allow" as const,
      })),
    );
    await savePermissionState(request.workdir, state);
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class PermissionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionRejectedError";
  }
}

import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_ENTRYPOINT_FILE_NAME = "harness.yaml";

export interface WorkspacePathsOptions {
  stateRoot?: string;
  projectRoot: string;
  workspaceName?: string;
  entrypointFileName?: string;
}

export class WorkspacePaths {
  readonly goondanHome: string;
  readonly projectRoot: string;
  readonly workspaceName?: string;
  readonly workspaceId: string;
  readonly entrypointFileName: string;

  constructor(options: WorkspacePathsOptions) {
    this.goondanHome = this.resolveGoondanHome(options.stateRoot);
    this.projectRoot = path.resolve(options.projectRoot);
    this.workspaceName = options.workspaceName;
    this.workspaceId = this.generateWorkspaceId(this.workspaceName);
    this.entrypointFileName = normalizeEntrypointFileName(options.entrypointFileName);
  }

  get configFile(): string {
    return path.join(this.goondanHome, "config.json");
  }

  get packagesDir(): string {
    return path.join(this.goondanHome, "packages");
  }

  get workspaceRoot(): string {
    return path.join(this.goondanHome, "workspaces", this.workspaceId);
  }

  get instancesRoot(): string {
    return path.join(this.workspaceRoot, "instances");
  }

  get workspaceRuntimeEventsPath(): string {
    return path.join(this.workspaceRoot, "runtime-events.jsonl");
  }

  packagePath(name: string, version: string): string {
    return path.join(this.packagesDir, `${name}@${version}`);
  }

  instancePath(conversationId: string): string {
    const safeKey = sanitizeConversationId(conversationId);
    return path.join(this.instancesRoot, safeKey);
  }

  instanceMetadataPath(conversationId: string): string {
    return path.join(this.instancePath(conversationId), "metadata.json");
  }

  instanceMessageBasePath(conversationId: string): string {
    return path.join(this.instancePath(conversationId), "messages", "base.jsonl");
  }

  instanceMessageEventsPath(conversationId: string): string {
    return path.join(this.instancePath(conversationId), "messages", "events.jsonl");
  }

  instanceRuntimeEventsPath(conversationId: string): string {
    return path.join(this.instancePath(conversationId), "messages", "runtime-events.jsonl");
  }

  instanceExtensionStatePath(conversationId: string, extensionName: string): string {
    return path.join(this.instancePath(conversationId), "extensions", `${extensionName}.json`);
  }

  projectPath(...segments: string[]): string {
    return path.join(this.projectRoot, ...segments);
  }

  get projectConfigFile(): string {
    return this.projectPath(this.entrypointFileName);
  }

  private resolveGoondanHome(stateRoot?: string): string {
    if (stateRoot !== undefined && stateRoot.length > 0) {
      return path.resolve(stateRoot);
    }

    const envStateRoot = process.env.GOONDAN_STATE_ROOT;
    if (typeof envStateRoot === "string" && envStateRoot.length > 0) {
      return path.resolve(envStateRoot);
    }

    return path.join(os.homedir(), ".goondan");
  }

  private generateWorkspaceId(workspaceName: string | undefined): string {
    return normalizeWorkspaceId(workspaceName);
  }
}

function normalizeEntrypointFileName(entrypointFileName: string | undefined): string {
  if (typeof entrypointFileName !== "string") {
    return DEFAULT_ENTRYPOINT_FILE_NAME;
  }

  const trimmed = entrypointFileName.trim();
  if (trimmed.length === 0) {
    return DEFAULT_ENTRYPOINT_FILE_NAME;
  }

  const baseName = path.basename(trimmed);
  if (baseName === "." || baseName === ".." || baseName.length === 0) {
    return DEFAULT_ENTRYPOINT_FILE_NAME;
  }

  return baseName;
}

function normalizeWorkspaceId(workspaceName: string | undefined): string {
  if (typeof workspaceName !== "string") {
    return "default";
  }

  const trimmed = workspaceName.trim();
  if (trimmed.length === 0) {
    return "default";
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (normalized.length === 0) {
    return "default";
  }

  return normalized.slice(0, 128);
}

export function sanitizeConversationId(conversationId: string): string {
  return conversationId.replace(/[^a-zA-Z0-9_:-]/g, "-").slice(0, 128);
}

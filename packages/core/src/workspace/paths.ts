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

  packagePath(name: string, version: string): string {
    return path.join(this.packagesDir, `${name}@${version}`);
  }

  instancePath(instanceKey: string): string {
    const safeKey = sanitizeInstanceKey(instanceKey);
    return path.join(this.instancesRoot, safeKey);
  }

  instanceMetadataPath(instanceKey: string): string {
    return path.join(this.instancePath(instanceKey), "metadata.json");
  }

  instanceMessageBasePath(instanceKey: string): string {
    return path.join(this.instancePath(instanceKey), "messages", "base.jsonl");
  }

  instanceMessageEventsPath(instanceKey: string): string {
    return path.join(this.instancePath(instanceKey), "messages", "events.jsonl");
  }

  instanceRuntimeEventsPath(instanceKey: string): string {
    return path.join(this.instancePath(instanceKey), "messages", "runtime-events.jsonl");
  }

  instanceExtensionStatePath(instanceKey: string, extensionName: string): string {
    return path.join(this.instancePath(instanceKey), "extensions", `${extensionName}.json`);
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

export function sanitizeInstanceKey(instanceKey: string): string {
  return instanceKey.replace(/[^a-zA-Z0-9_:-]/g, "-").slice(0, 128);
}

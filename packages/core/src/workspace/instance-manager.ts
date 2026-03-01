import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { WorkspacePaths } from "./paths.js";
import type { InstanceMetadata } from "./storage.js";
import { isJsonObject } from "../types.js";

export interface InstanceInfo {
  readonly instanceKey: string;
  readonly agentName: string;
  readonly status: "idle" | "processing";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InstanceManager {
  list(): Promise<InstanceInfo[]>;
  delete(instanceKey: string): Promise<void>;
}

export class FileInstanceManager implements InstanceManager {
  constructor(private readonly paths: WorkspacePaths) {}

  async list(): Promise<InstanceInfo[]> {
    const instancesRoot = this.paths.instancesRoot;
    const result: InstanceInfo[] = [];

    try {
      const entries = await fs.readdir(instancesRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const metadataPath = path.join(instancesRoot, entry.name, "metadata.json");
        const metadata = await readMetadataFile(metadataPath);
        if (metadata === undefined) {
          continue;
        }

        result.push({
          instanceKey: metadata.instanceKey,
          agentName: metadata.agentName,
          status: metadata.status,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        });
      }
    } catch {
      // instancesRoot does not exist yet
    }

    return result;
  }

  async delete(instanceKey: string): Promise<void> {
    const instanceDir = this.paths.instancePath(instanceKey);

    try {
      await fs.rm(instanceDir, { recursive: true, force: true });
    } catch {
      // directory may not exist
    }
  }
}

async function readMetadataFile(filePath: string): Promise<InstanceMetadata | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isInstanceMetadata(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isInstanceMetadata(value: unknown): value is InstanceMetadata {
  if (!isJsonObject(value)) {
    return false;
  }

  if (value.status !== "idle" && value.status !== "processing") {
    return false;
  }

  return (
    typeof value.agentName === "string" &&
    typeof value.instanceKey === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

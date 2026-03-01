import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createIntegrationToolManifests } from "./dist/manifests/integrations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ENTRYPOINT_FILE_NAME = "harness.yaml";

function resolveEntrypointFileName() {
  const env = process.env.ENTRYPOINT_FILE_NAME;
  if (typeof env === "string") {
    const trimmed = env.trim();
    if (trimmed.length > 0) {
      return path.basename(trimmed);
    }
  }

  return DEFAULT_ENTRYPOINT_FILE_NAME;
}

function toScalar(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyPlainObject(value) {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function toYaml(value, indent = 0) {
  const space = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${space}[]`;
    }

    const lines = [];
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        lines.push(`${space}-`);
        lines.push(toYaml(item, indent + 2));
      } else {
        lines.push(`${space}- ${toScalar(item)}`);
      }
    }
    return lines.join("\n");
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return `${space}{}`;
    }

    const lines = [];
    for (const [key, entry] of entries) {
      if (isEmptyPlainObject(entry)) {
        lines.push(`${space}${key}: {}`);
      } else if (Array.isArray(entry) && entry.length === 0) {
        lines.push(`${space}${key}: []`);
      } else if (isPlainObject(entry) || Array.isArray(entry)) {
        lines.push(`${space}${key}:`);
        lines.push(toYaml(entry, indent + 2));
      } else {
        lines.push(`${space}${key}: ${toScalar(entry)}`);
      }
    }
    return lines.join("\n");
  }

  return `${space}${toScalar(value)}`;
}

function rewriteEntryPath(entry) {
  if (!isPlainObject(entry)) {
    return entry;
  }

  const copied = { ...entry };
  if (typeof copied.entry === "string") {
    copied.entry = copied.entry.replace("./src/", "./dist/").replace(/\.ts$/, ".js");
  }
  return copied;
}

function normalizeNewline(content) {
  return content.replace(/\r\n/g, "\n");
}

function splitYamlDocuments(content) {
  const normalized = normalizeNewline(content);
  const docs = [];
  const lines = normalized.split("\n");
  let current = [];

  for (const line of lines) {
    if (line.trim() === "---") {
      if (current.some((entry) => entry.trim().length > 0)) {
        docs.push(current.join("\n").trimEnd());
      }
      current = [];
      continue;
    }

    current.push(line);
  }

  if (current.some((entry) => entry.trim().length > 0)) {
    docs.push(current.join("\n").trimEnd());
  }

  return docs;
}

function trimQuotes(value) {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function lineIsTopLevel(line) {
  return line.length > 0 && !line.startsWith(" ");
}

function readSourcePackageMeta(source, entrypointFileName) {
  const docs = splitYamlDocuments(source);
  const first = docs[0];
  if (typeof first !== "string") {
    throw new Error(`${entrypointFileName}에서 Package 문서를 찾을 수 없습니다.`);
  }

  const lines = first.split("\n");
  let kind = "";
  let packageName;
  let version;
  let inMetadata = false;
  let inSpec = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "metadata:") {
      inMetadata = true;
      inSpec = false;
      continue;
    }

    if (trimmed === "spec:") {
      inMetadata = false;
      inSpec = true;
      continue;
    }

    if (lineIsTopLevel(line) && trimmed !== "metadata:" && trimmed !== "spec:") {
      inMetadata = false;
      inSpec = false;
    }

    if (trimmed.startsWith("kind:")) {
      kind = trimQuotes(trimmed.slice("kind:".length).trim());
      continue;
    }

    if (inMetadata && trimmed.startsWith("name:")) {
      packageName = trimQuotes(trimmed.slice("name:".length).trim());
      continue;
    }

    if (inSpec && trimmed.startsWith("version:")) {
      version = trimQuotes(trimmed.slice("version:".length).trim());
      continue;
    }
  }

  if (kind !== "Package") {
    throw new Error(`${entrypointFileName} 첫 번째 문서는 kind: Package 이어야 합니다.`);
  }

  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(`${entrypointFileName} Package metadata.name이 필요합니다.`);
  }

  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${entrypointFileName} Package spec.version이 필요합니다.`);
  }

  return {
    packageName,
    version,
  };
}

async function main() {
  const entrypointFileName = resolveEntrypointFileName();
  const sourceManifestFileName = DEFAULT_ENTRYPOINT_FILE_NAME;
  const sourceManifestPath = path.join(__dirname, sourceManifestFileName);
  const sourceManifest = await readFile(sourceManifestPath, "utf8");
  const packageMeta = readSourcePackageMeta(sourceManifest, sourceManifestFileName);

  const docs = [
    {
      apiVersion: "goondan.ai/v1",
      kind: "Package",
      metadata: {
        name: packageMeta.packageName,
      },
      spec: {
        version: packageMeta.version,
      },
    },
    ...createIntegrationToolManifests().map((item) => ({
      ...item,
      spec: rewriteEntryPath(item.spec),
    })),
  ];

  const rendered = docs.map((doc) => toYaml(doc)).join("\n---\n");
  const outputPath = path.join(__dirname, "dist", entrypointFileName);
  await writeFile(outputPath, `${rendered}\n`, "utf8");
}

await main();

import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";

import { parseAllDocuments } from "yaml";

import { isJsonObject, isKnownKind, type KnownKind, type RuntimeResource } from "../../types.js";

export interface LoadHarnessYamlResourcesOptions {
  workdir: string;
  entrypointFileName?: string;
}

export interface LoadedHarnessYamlResources {
  entrypointPath: string;
  resources: RuntimeResource[];
}

interface DependencyEdge {
  name: string;
  version?: string;
  basedir: string;
  declaredIn: RuntimeResource;
}

const DEFAULT_ENTRYPOINT_FILE_NAME = "harness.yaml";
const DEFAULT_API_VERSION = "goondan.ai/v1";

const require = createRequire(import.meta.url);

export async function loadHarnessYamlResources(options: LoadHarnessYamlResourcesOptions): Promise<LoadedHarnessYamlResources> {
  const workdir = path.resolve(options.workdir);
  const entrypointFileName = normalizeEntrypointFileName(options.entrypointFileName);
  const entrypointPath = path.join(workdir, entrypointFileName);

  const resources: RuntimeResource[] = [];
  const visitedPackages = new Set<string>();
  const resolvingStack: string[] = [];

  await loadYamlFileIntoResources(
    {
      filePath: entrypointPath,
      rootDir: workdir,
    },
    resources,
    async (edge) => {
      await loadDependencyPackage(edge, resources, visitedPackages, resolvingStack);
    },
  );

  return { entrypointPath, resources };
}

async function loadDependencyPackage(
  edge: DependencyEdge,
  resources: RuntimeResource[],
  visitedPackages: Set<string>,
  resolvingStack: string[],
): Promise<void> {
  const packageName = edge.name;

  if (resolvingStack.includes(packageName)) {
    const cycle = [...resolvingStack, packageName].join(" -> ");
    throw new Error(
      `패키지 의존성 사이클이 감지되었습니다: ${cycle}\n` +
        `- 발생 위치: ${formatResourceOrigin(edge.declaredIn)}\n` +
        `- 해결: Package.spec.dependencies에서 사이클을 제거하세요.`,
    );
  }

  if (visitedPackages.has(packageName)) {
    return;
  }

  visitedPackages.add(packageName);
  resolvingStack.push(packageName);

  try {
    const packageRoot = await resolvePackageRoot(packageName, edge.basedir);
    const harnessYamlPath = path.join(packageRoot, "dist", DEFAULT_ENTRYPOINT_FILE_NAME);

    await loadYamlFileIntoResources(
      {
        filePath: harnessYamlPath,
        rootDir: packageRoot,
        packageName,
      },
      resources,
      async (nextEdge) => {
        await loadDependencyPackage(nextEdge, resources, visitedPackages, resolvingStack);
      },
    );
  } catch (error) {
    const versionText = edge.version ? `@${edge.version}` : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `의존 패키지 harness.yaml 로딩 실패: ${packageName}${versionText}\n` +
        `- 선언 위치: ${formatResourceOrigin(edge.declaredIn)}\n` +
        `- 원인: ${message}`,
    );
  } finally {
    resolvingStack.pop();
  }
}

async function loadYamlFileIntoResources(
  input: { filePath: string; rootDir: string; packageName?: string },
  out: RuntimeResource[],
  onDependency: (edge: DependencyEdge) => Promise<void>,
): Promise<void> {
  const content = await readTextFile(input.filePath, {
    packageName: input.packageName,
    rootDir: input.rootDir,
  });
  const docs = parseYamlDocuments(content, input.filePath);

  const fileResources: RuntimeResource[] = [];
  for (let docIndex = 0; docIndex < docs.length; docIndex += 1) {
    const doc = docs[docIndex];
    const resource = toRuntimeResource(doc, {
      filePath: input.filePath,
      docIndex,
      rootDir: input.rootDir,
      packageName: input.packageName,
    });
    if (resource !== null) {
      fileResources.push(resource);
    }
  }

  out.push(...fileResources);

  const edges = collectDependencyEdges(fileResources);
  for (const edge of edges) {
    await onDependency(edge);
  }
}

function parseYamlDocuments(content: string, filePath: string): unknown[] {
  const docs = parseAllDocuments(content);
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      const message = doc.errors.map((err) => err.message).join("; ");
      throw new Error(`[${filePath}] YAML 파싱 오류: ${message}`);
    }
  }
  return docs.map((doc) => doc.toJSON());
}

function toRuntimeResource(
  doc: unknown,
  input: {
    filePath: string;
    docIndex: number;
    rootDir: string;
    packageName?: string;
  },
): RuntimeResource | null {
  if (doc === null || doc === undefined) {
    return null;
  }

  if (!isJsonObject(doc)) {
    throw new Error(`[${input.filePath}] 문서 #${input.docIndex}: 리소스 문서는 object여야 합니다.`);
  }

  const kind = doc.kind;
  if (kind === undefined) {
    // allow empty docs/comments
    return null;
  }

  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new Error(`[${input.filePath}] 문서 #${input.docIndex}: kind는 비어있지 않은 string이어야 합니다.`);
  }

  if (!isKnownKind(kind)) {
    throw new Error(`[${input.filePath}] 문서 #${input.docIndex}: 지원하지 않는 kind입니다: ${kind}`);
  }

  const apiVersion = typeof doc.apiVersion === "string" && doc.apiVersion.trim().length > 0 ? doc.apiVersion : DEFAULT_API_VERSION;

  const metadata = doc.metadata;
  if (!isJsonObject(metadata) || typeof metadata.name !== "string" || metadata.name.trim().length === 0) {
    throw new Error(`[${input.filePath}] 문서 #${input.docIndex}: metadata.name은 필수입니다.`);
  }

  const spec = doc.spec;
  if (!isJsonObject(spec)) {
    throw new Error(`[${input.filePath}] 문서 #${input.docIndex}: spec은 object여야 합니다.`);
  }

  return {
    apiVersion,
    kind: kind as KnownKind,
    metadata: metadata as any,
    spec: spec as any,
    __file: input.filePath,
    __docIndex: input.docIndex,
    __package: input.packageName,
    __rootDir: input.rootDir,
  };
}

function collectDependencyEdges(resources: RuntimeResource[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const res of resources) {
    if (res.kind !== "Package") {
      continue;
    }

    const basedir = res.__rootDir ?? path.dirname(res.__file);

    const depsRaw = (res.spec as Record<string, unknown>)["dependencies"];
    if (!Array.isArray(depsRaw)) {
      continue;
    }

    for (const dep of depsRaw) {
      if (!isJsonObject(dep)) {
        continue;
      }

      const name = typeof dep.name === "string" ? dep.name.trim() : "";
      if (name.length === 0) {
        continue;
      }

      const version = typeof dep.version === "string" && dep.version.trim().length > 0 ? dep.version.trim() : undefined;
      edges.push({ name, version, basedir, declaredIn: res });
    }
  }

  return edges;
}

async function resolvePackageRoot(packageName: string, basedir: string): Promise<string> {
  const fromNodeModules = await resolvePackageRootFromNodeModules(packageName, basedir);
  if (fromNodeModules) {
    return fromNodeModules;
  }

  let resolved: string;
  try {
    resolved = require.resolve(packageName, { paths: [basedir] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`require.resolve 실패: ${packageName} (basedir=${basedir}): ${message}`);
  }

  let currentDir = path.dirname(resolved);
  const root = path.parse(currentDir).root;

  while (true) {
    const candidate = path.join(currentDir, "package.json");
    if (await fileExists(candidate)) {
      return currentDir;
    }

    if (currentDir === root) {
      break;
    }
    currentDir = path.dirname(currentDir);
  }

  throw new Error(`패키지 루트를 찾지 못했습니다: ${packageName} (resolved=${resolved})`);
}

async function resolvePackageRootFromNodeModules(packageName: string, basedir: string): Promise<string | null> {
  const parts = packageName.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  let currentDir = path.resolve(basedir);
  const root = path.parse(currentDir).root;

  while (true) {
    const candidate = path.join(currentDir, "node_modules", ...parts, "package.json");
    if (await fileExists(candidate)) {
      return path.dirname(candidate);
    }

    if (currentDir === root) {
      break;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

async function readTextFile(
  filePath: string,
  input: { rootDir: string; packageName?: string },
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as any).code : undefined;
    if (code === "ENOENT") {
      if (input.packageName) {
        throw new Error(
          `[${filePath}] 파일이 없습니다.\n` +
            `의존 패키지(${input.packageName})를 먼저 빌드해서 dist/harness.yaml을 생성하세요. 예: pnpm -r build`,
        );
      }

      throw new Error(
        `[${filePath}] 파일이 없습니다. (workdir=${input.rootDir})\n` +
          `workdir에 harness.yaml을 두거나, entrypointFileName 옵션을 올바르게 지정하세요.`,
      );
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeEntrypointFileName(value: string | undefined): string {
  if (typeof value !== "string") {
    return DEFAULT_ENTRYPOINT_FILE_NAME;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_ENTRYPOINT_FILE_NAME;
  }

  const baseName = path.basename(trimmed);
  if (baseName === "." || baseName === ".." || baseName.length === 0) {
    return DEFAULT_ENTRYPOINT_FILE_NAME;
  }

  return baseName;
}

function formatResourceOrigin(resource: RuntimeResource): string {
  const pkg = resource.__package ? ` (package=${resource.__package})` : "";
  return `${resource.__file}#${resource.__docIndex}${pkg}`;
}

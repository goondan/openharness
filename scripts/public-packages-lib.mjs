import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

function getInternalDependencyNames(pkg, packageNames) {
  const names = new Set();
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const record = pkg[field];
    if (!record) continue;
    for (const dependencyName of Object.keys(record)) {
      if (packageNames.has(dependencyName)) {
        names.add(dependencyName);
      }
    }
  }
  return [...names];
}

export function deriveDistTag(version) {
  const prereleaseIndex = version.indexOf("-");
  if (prereleaseIndex === -1) {
    return "latest";
  }

  const prerelease = version.slice(prereleaseIndex + 1);
  const match = prerelease.match(/^[a-zA-Z-]+/);
  if (!match) {
    return "next";
  }

  return match[0].toLowerCase();
}

export function createNpmProcessEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_config_") || key.startsWith("NPM_CONFIG_")) {
      delete env[key];
    }
  }
  return env;
}

function topoSort(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const incomingCount = new Map(packages.map((pkg) => [pkg.name, 0]));
  const outgoing = new Map(packages.map((pkg) => [pkg.name, []]));

  for (const pkg of packages) {
    for (const dependencyName of pkg.internalDependencies) {
      outgoing.get(dependencyName)?.push(pkg.name);
      incomingCount.set(pkg.name, (incomingCount.get(pkg.name) ?? 0) + 1);
    }
  }

  const ready = packages
    .filter((pkg) => (incomingCount.get(pkg.name) ?? 0) === 0)
    .map((pkg) => pkg.name)
    .sort();
  const ordered = [];

  while (ready.length > 0) {
    const nextName = ready.shift();
    if (!nextName) break;
    const pkg = byName.get(nextName);
    if (!pkg) continue;

    ordered.push(pkg);

    for (const dependentName of outgoing.get(nextName) ?? []) {
      const remaining = (incomingCount.get(dependentName) ?? 0) - 1;
      incomingCount.set(dependentName, remaining);
      if (remaining === 0) {
        ready.push(dependentName);
        ready.sort();
      }
    }
  }

  if (ordered.length !== packages.length) {
    throw new Error("public package dependency graph contains a cycle");
  }

  return ordered;
}

export async function getPublicPackages() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = path.join(PACKAGES_DIR, entry.name);
    const packageJsonPath = path.join(directory, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

    if (packageJson.private === true) {
      continue;
    }

    packages.push({
      directory,
      packageJsonPath,
      ...packageJson,
    });
  }

  const packageNames = new Set(packages.map((pkg) => pkg.name));
  const enriched = packages.map((pkg) => ({
    ...pkg,
    internalDependencies: getInternalDependencyNames(pkg, packageNames),
  }));

  return topoSort(enriched);
}

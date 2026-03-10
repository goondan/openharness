import { spawnSync } from "node:child_process";
import { createNpmProcessEnv, getPublicPackages } from "./public-packages-lib.mjs";

const packages = await getPublicPackages();
const errors = [];
const npmEnv = createNpmProcessEnv();

for (const pkg of packages) {
  if (!pkg.description) {
    errors.push(`${pkg.name}: description is required`);
  }
  if (!pkg.repository?.url || !pkg.repository?.directory) {
    errors.push(`${pkg.name}: repository.url and repository.directory are required`);
  }
  if (!pkg.homepage) {
    errors.push(`${pkg.name}: homepage is required`);
  }
  if (!pkg.bugs?.url) {
    errors.push(`${pkg.name}: bugs.url is required`);
  }
  if (pkg.publishConfig?.access !== "public") {
    errors.push(`${pkg.name}: publishConfig.access must be "public"`);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
    errors.push(`${pkg.name}: files must include dist`);
  }
}

if (errors.length > 0) {
  console.error("publish metadata check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("public packages:");
for (const pkg of packages) {
  console.log(`- ${pkg.name}@${pkg.version} (${pkg.directory})`);
}

for (const pkg of packages) {
  console.log(`\n[pack] ${pkg.name}`);
  const result = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: pkg.directory,
    stdio: "inherit",
    env: npmEnv,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

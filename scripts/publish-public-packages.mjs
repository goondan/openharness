import { spawnSync } from "node:child_process";
import {
  createNpmProcessEnv,
  deriveDistTag,
  getPublicPackages,
} from "./public-packages-lib.mjs";

const npmEnv = createNpmProcessEnv();

function run(command, args, options) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    env: npmEnv,
    ...options,
  });
  return result;
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const tagArg = argv.find((arg) => arg.startsWith("--tag="));
  const provenance = !argv.includes("--no-provenance");
  return {
    dryRun,
    tag: tagArg ? tagArg.slice("--tag=".length) : null,
    provenance,
  };
}

function versionAlreadyPublished(name, version) {
  const result = run("npm", ["view", `${name}@${version}`, "version"], {});
  return result.status === 0;
}

const { dryRun, tag: explicitTag, provenance } = parseArgs(process.argv.slice(2));
const packages = await getPublicPackages();

for (const pkg of packages) {
  const distTag = explicitTag ?? deriveDistTag(pkg.version);

  if (!dryRun && versionAlreadyPublished(pkg.name, pkg.version)) {
    console.log(`[skip] ${pkg.name}@${pkg.version} is already published`);
    continue;
  }

  const args = ["publish", "--access", "public", "--tag", distTag];
  if (dryRun) {
    args.push("--dry-run");
  } else if (provenance) {
    args.push("--provenance");
  }

  console.log(
    `[publish] ${pkg.name}@${pkg.version} (tag=${distTag}${dryRun ? ", dry-run" : ""}${
      provenance ? ", provenance" : ", local"
    })`
  );
  const result = spawnSync("npm", args, {
    cwd: pkg.directory,
    stdio: "inherit",
    env: npmEnv,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

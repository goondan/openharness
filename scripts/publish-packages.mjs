// 공개 패키지를 의존 순서대로 발행한다. 환경 변수: DRY_RUN=true면 pack만, DIST_TAG(기본 latest).
// pnpm pack이 workspace:* 의존을 실제 버전으로 바꾸고, 발행은 npm publish가 한다
// (GitHub Actions의 OIDC 토큰을 npm 11.5.1+가 자동으로 집어 provenance를 붙인다).
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORDER = ["types", "adapters", "core", "base", "cli"]; // 의존 순서
const dryRun = process.env.DRY_RUN === "true";
const distTag = process.env.DIST_TAG || "latest";
const outDir = mkdtempSync(path.join(tmpdir(), "openharness-publish-"));

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

for (const dir of ORDER) {
  const cwd = path.resolve("packages", dir);
  const { name, version } = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  const exists = spawnSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "ignore" }).status === 0;
  if (exists && !dryRun) {
    console.log(`[skip] ${name}@${version} already published`);
    continue;
  }
  console.log(`\n[pack] ${name}@${version}`);
  run("pnpm", ["pack", "--pack-destination", outDir], cwd);
  const tgz = path.join(outDir, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
  const args = ["publish", tgz, "--access", "public", "--tag", distTag];
  if (dryRun) args.push("--dry-run");
  console.log(`[${dryRun ? "dry-run" : "publish"}] ${name}@${version} tag=${distTag}`);
  run("npm", args, cwd);
}

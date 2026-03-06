import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadHarnessYamlResources } from "./loader.js";

describe("loadHarnessYamlResources", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openharness-loader-test-"));
  });

  async function writeText(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  it("loads entrypoint resources and dependency dist/harness.yaml", async () => {
    await writeText(
      path.join(tempDir, "harness.yaml"),
      [
        "apiVersion: goondan.ai/v1",
        "kind: Package",
        "metadata:",
        "  name: root",
        "spec:",
        "  dependencies:",
        "    - name: \"@acme/foo\"",
        "      version: \"1.0.0\"",
        "---",
        "apiVersion: goondan.ai/v1",
        "kind: Agent",
        "metadata:",
        "  name: build",
        "spec:",
        "  modelConfig:",
        "    modelRef: Model/m1",
        "---",
        "apiVersion: goondan.ai/v1",
        "kind: Model",
        "metadata:",
        "  name: m1",
        "spec:",
        "  provider: openai",
        "  model: gpt-4.1-mini",
        "  apiKey:",
        "    valueFrom:",
        "      env: OPENAI_API_KEY",
        "",
      ].join("\n"),
    );

    const depRoot = path.join(tempDir, "node_modules", "@acme", "foo");
    await writeText(path.join(depRoot, "package.json"), JSON.stringify({ name: "@acme/foo", version: "1.0.0" }));
    await writeText(
      path.join(depRoot, "dist", "harness.yaml"),
      [
        "apiVersion: goondan.ai/v1",
        "kind: Tool",
        "metadata:",
        "  name: hello",
        "spec:",
        "  entry: ./dist/tools/hello.js",
        "  exports:",
        "    - name: run",
        "      description: hi",
        "      parameters:",
        "        type: object",
        "        properties: {}",
        "        additionalProperties: false",
        "",
      ].join("\n"),
    );

    const loaded = await loadHarnessYamlResources({ workdir: tempDir });

    expect(loaded.entrypointPath).toBe(path.join(tempDir, "harness.yaml"));

    const tool = loaded.resources.find((r) => r.kind === "Tool" && r.metadata.name === "hello");
    expect(tool).toBeDefined();
    expect(tool?.__package).toBe("@acme/foo");
    expect(tool?.__rootDir).toBe(depRoot);
  });

  it("detects dependency cycles", async () => {
    await writeText(
      path.join(tempDir, "harness.yaml"),
      [
        "apiVersion: goondan.ai/v1",
        "kind: Package",
        "metadata:",
        "  name: root",
        "spec:",
        "  dependencies:",
        "    - name: \"@acme/a\"",
        "      version: \"1.0.0\"",
        "",
      ].join("\n"),
    );

    const aRoot = path.join(tempDir, "node_modules", "@acme", "a");
    const bRoot = path.join(tempDir, "node_modules", "@acme", "b");

    await writeText(path.join(aRoot, "package.json"), JSON.stringify({ name: "@acme/a", version: "1.0.0" }));
    await writeText(path.join(bRoot, "package.json"), JSON.stringify({ name: "@acme/b", version: "1.0.0" }));

    await writeText(
      path.join(aRoot, "dist", "harness.yaml"),
      [
        "apiVersion: goondan.ai/v1",
        "kind: Package",
        "metadata:",
        "  name: \"@acme/a\"",
        "spec:",
        "  dependencies:",
        "    - name: \"@acme/b\"",
        "      version: \"1.0.0\"",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(bRoot, "dist", "harness.yaml"),
      [
        "apiVersion: goondan.ai/v1",
        "kind: Package",
        "metadata:",
        "  name: \"@acme/b\"",
        "spec:",
        "  dependencies:",
        "    - name: \"@acme/a\"",
        "      version: \"1.0.0\"",
        "",
      ].join("\n"),
    );

    await expect(loadHarnessYamlResources({ workdir: tempDir })).rejects.toThrow(/사이클/);
  });
});


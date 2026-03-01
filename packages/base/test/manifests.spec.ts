import { describe, expect, it } from "vitest";

import {
  createBaseExtensionManifests,
  createBaseToolManifests,
} from "../src/manifests/base.js";

describe("base manifests", () => {
  it("기본 tool/extension 매니페스트를 생성한다", () => {
    const tools = createBaseToolManifests();
    const extensions = createBaseExtensionManifests();

    expect(tools.length).toBe(6);
    expect(extensions.length).toBe(7);

    expect(tools.some((item) => item.metadata.name === "bash")).toBe(true);
    expect(tools.some((item) => item.metadata.name === "wait")).toBe(true);
    expect(extensions.some((item) => item.metadata.name === "logging")).toBe(true);
    expect(extensions.some((item) => item.metadata.name === "context-message")).toBe(true);
    expect(extensions.some((item) => item.metadata.name === "inter-agent-response-format")).toBe(true);

    const extensionNames = extensions.map((item) => item.metadata.name);
    const extensionEntries = extensions.map((item) => item.spec.entry);
    expect(new Set(extensionNames).size).toBe(extensionNames.length);
    expect(new Set(extensionEntries).size).toBe(extensionEntries.length);
    const contextMessage = extensions.find((item) => item.metadata.name === "context-message");
    expect(contextMessage?.spec.config?.includeAgentPrompt).toBe(true);
    expect(contextMessage?.spec.config?.includeSwarmCatalog).toBe(false);
    expect(contextMessage?.spec.config?.includeRouteSummary).toBe(false);

  });
});

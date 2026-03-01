import { describe, expect, it } from "vitest";

import { createIntegrationToolManifests } from "../src/manifests/index.js";

describe("integrations manifests", () => {
  it("slack/telegram tool 매니페스트를 생성한다", () => {
    const tools = createIntegrationToolManifests();

    expect(tools.length).toBe(2);
    expect(tools.every((item) => item.kind === "Tool")).toBe(true);
    expect(tools.some((item) => item.metadata.name === "slack")).toBe(true);
    expect(tools.some((item) => item.metadata.name === "telegram")).toBe(true);
  });
});


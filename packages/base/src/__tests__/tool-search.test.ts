import { describe, it, expect } from "vitest";
import { ToolSearch } from "../extensions/tool-search.js";
import type { ToolContext, ToolDefinition } from "@goondan/openharness-types";
import { makeDummyTool, makeMockApi } from "./_mock-api.js";

function makeToolContext(): ToolContext {
  return {
    conversationId: "conv-1",
    agentName: "test-agent",
    abortSignal: new AbortController().signal,
  };
}

function searchToolOf(api: ReturnType<typeof makeMockApi>["api"]): ToolDefinition {
  const tool = (api.tools.list() as ToolDefinition[]).find(
    (t) => t.name === "search_tools",
  );
  if (!tool) throw new Error("search_tools not registered");
  return tool;
}

describe("ToolSearch", () => {
  it("creates an AgentExtension with name 'tool-search'", () => {
    expect(ToolSearch().name).toBe("tool-search");
  });

  it("registers a meta-tool named 'search_tools'", () => {
    const { api, registeredTools } = makeMockApi();
    ToolSearch().register(api);

    expect(api.tools.register).toHaveBeenCalledOnce();
    expect(registeredTools.find((t) => t.name === "search_tools")).toBeDefined();
  });

  it("matches tools by keyword in the name", async () => {
    const { api } = makeMockApi(undefined, [
      makeDummyTool("weather_get", "Get current weather"),
      makeDummyTool("calendar_add", "Add a calendar event"),
      makeDummyTool("weather_forecast", "Get weather forecast"),
    ]);
    ToolSearch().register(api);

    const result = await searchToolOf(api).handler(
      { query: "weather" },
      makeToolContext(),
    );

    expect(result.type).toBe("json");
    if (result.type === "json") {
      const data = result.data as unknown as ToolDefinition[];
      expect(data).toHaveLength(2);
      expect(data.map((t) => t.name)).toContain("weather_get");
      expect(data.map((t) => t.name)).toContain("weather_forecast");
    }
  });

  it("matches tools by keyword in the description", async () => {
    const { api } = makeMockApi(undefined, [
      makeDummyTool("tool_a", "Send an email to a recipient"),
      makeDummyTool("tool_b", "Read a file from disk"),
    ]);
    ToolSearch().register(api);

    const result = await searchToolOf(api).handler(
      { query: "email" },
      makeToolContext(),
    );

    expect(result.type).toBe("json");
    if (result.type === "json") {
      const data = result.data as unknown as ToolDefinition[];
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("tool_a");
    }
  });

  it("returns an empty array when nothing matches", async () => {
    const { api } = makeMockApi(undefined, [
      makeDummyTool("calculator", "Perform math operations"),
    ]);
    ToolSearch().register(api);

    const result = await searchToolOf(api).handler(
      { query: "nonexistent" },
      makeToolContext(),
    );

    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toEqual([]);
    }
  });

  it("searches case-insensitively", async () => {
    const { api } = makeMockApi(undefined, [
      makeDummyTool("WeatherTool", "Get Weather Data"),
    ]);
    ToolSearch().register(api);

    const result = await searchToolOf(api).handler(
      { query: "weather" },
      makeToolContext(),
    );

    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect((result.data as unknown as ToolDefinition[])).toHaveLength(1);
    }
  });
});

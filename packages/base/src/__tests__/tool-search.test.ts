import { describe, it, expect } from "vitest";
import { ToolSearch } from "../extensions/tool-search.js";
import type { ToolDefinition, ToolContext } from "@goondan/openharness-types";
import { makeMockApi, makeMockConversationState, makeDummyTool } from "./helpers.js";

function makeToolContext(): ToolContext {
  return {
    conversationId: "conv-1",
    agentName: "test-agent",
    abortSignal: new AbortController().signal,
  };
}

describe("ToolSearch", () => {
  it("creates an Extension with name 'tool-search'", () => {
    const ext = ToolSearch();
    expect(ext.name).toBe("tool-search");
  });

  it("registers a meta-tool named 'search_tools'", () => {
    const conversation = makeMockConversationState();
    const { api } = makeMockApi(conversation);

    const ext = ToolSearch();
    ext.register(api);

    expect(api.tools.register).toHaveBeenCalledOnce();
    const searchTool = api.tools.list().find((t) => t.name === "search_tools");
    expect(searchTool).toBeDefined();
  });

  it("search_tools returns tools matching keyword in name", async () => {
    const conversation = makeMockConversationState();
    const seedTools = [
      makeDummyTool("weather_get", "Get current weather"),
      makeDummyTool("calendar_add", "Add a calendar event"),
      makeDummyTool("weather_forecast", "Get weather forecast"),
    ];
    const { api } = makeMockApi(conversation, seedTools);

    const ext = ToolSearch();
    ext.register(api);

    const searchTool = (api.tools.list() as ToolDefinition[]).find(
      (t) => t.name === "search_tools",
    )!;
    const result = await searchTool.handler({ query: "weather" }, makeToolContext());

    expect(result.type).toBe("json");
    if (result.type === "json") {
      const data = result.data as unknown as ToolDefinition[];
      expect(data).toHaveLength(2);
      expect(data.map((t) => t.name)).toContain("weather_get");
      expect(data.map((t) => t.name)).toContain("weather_forecast");
    }
  });

  it("search_tools returns tools matching keyword in description", async () => {
    const conversation = makeMockConversationState();
    const seedTools = [
      makeDummyTool("tool_a", "Send an email to a recipient"),
      makeDummyTool("tool_b", "Read a file from disk"),
    ];
    const { api } = makeMockApi(conversation, seedTools);

    const ext = ToolSearch();
    ext.register(api);

    const searchTool = (api.tools.list() as ToolDefinition[]).find(
      (t) => t.name === "search_tools",
    )!;
    const result = await searchTool.handler({ query: "email" }, makeToolContext());

    expect(result.type).toBe("json");
    if (result.type === "json") {
      const data = result.data as unknown as ToolDefinition[];
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("tool_a");
    }
  });

  it("search_tools returns empty array when no match", async () => {
    const conversation = makeMockConversationState();
    const seedTools = [makeDummyTool("calculator", "Perform math operations")];
    const { api } = makeMockApi(conversation, seedTools);

    const ext = ToolSearch();
    ext.register(api);

    const searchTool = (api.tools.list() as ToolDefinition[]).find(
      (t) => t.name === "search_tools",
    )!;
    const result = await searchTool.handler({ query: "nonexistent" }, makeToolContext());

    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toEqual([]);
    }
  });

  it("search is case-insensitive", async () => {
    const conversation = makeMockConversationState();
    const seedTools = [makeDummyTool("WeatherTool", "Get Weather Data")];
    const { api } = makeMockApi(conversation, seedTools);

    const ext = ToolSearch();
    ext.register(api);

    const searchTool = (api.tools.list() as ToolDefinition[]).find(
      (t) => t.name === "search_tools",
    )!;
    const result = await searchTool.handler({ query: "weather" }, makeToolContext());

    expect(result.type).toBe("json");
    if (result.type === "json") {
      const data = result.data as unknown as ToolDefinition[];
      expect(data).toHaveLength(1);
    }
  });
});

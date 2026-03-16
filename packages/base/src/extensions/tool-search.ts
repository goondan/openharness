import type { Extension, ExtensionApi } from "@goondan/openharness-types";

/**
 * ToolSearch extension — registers a meta-tool `search_tools` that searches
 * registered tool names and descriptions by keyword.
 */
export function ToolSearch(): Extension {
  return {
    name: "tool-search",

    register(api: ExtensionApi): void {
      api.tools.register({
        name: "search_tools",
        description: "Search registered tools by keyword in name or description.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Keyword to search for in tool names and descriptions.",
            },
          },
          required: ["query"],
        },
        handler: async (args) => {
          const query = (args["query"] as string).toLowerCase();
          const allTools = api.tools.list();
          const matching = allTools.filter(
            (t) =>
              t.name.toLowerCase().includes(query) ||
              t.description.toLowerCase().includes(query),
          );
          return { type: "json", data: matching };
        },
      });
    },
  };
}

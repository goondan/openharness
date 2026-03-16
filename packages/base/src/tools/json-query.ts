import type { ToolDefinition, JsonObject, ToolContext, JsonValue } from "@goondan/openharness-types";

/**
 * Simple JSONPath-like query supporting dot and bracket notation.
 * Supported path format: $.key.nested[0].field
 * The leading `$` is optional.
 */
function jsonQuery(data: unknown, path: string): unknown {
  // Normalize: strip leading `$` or `$.`
  let normalized = path.trim();
  if (normalized.startsWith("$.")) {
    normalized = normalized.slice(2);
  } else if (normalized === "$") {
    return data;
  } else if (normalized.startsWith("$")) {
    normalized = normalized.slice(1);
  }

  if (normalized === "" || normalized === ".") {
    return data;
  }

  // Tokenize path into segments
  const segments: Array<string | number> = [];
  // Replace bracket notation [0] with .0
  const normalized2 = normalized.replace(/\[(\d+)\]/g, ".$1").replace(/\[['"](.+?)['"]\]/g, ".$1");
  for (const part of normalized2.split(".")) {
    if (part === "") continue;
    const num = Number(part);
    segments.push(Number.isInteger(num) && String(num) === part ? num : part);
  }

  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string | number, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function JsonQueryTool(): ToolDefinition {
  return {
    name: "json_query",
    description: "Query JSON data using a simple JSONPath-like path expression.",
    parameters: {
      type: "object",
      properties: {
        data: { description: "The JSON data to query." },
        path: {
          type: "string",
          description: "JSONPath-like path, e.g. $.key.nested[0].field",
        },
      },
      required: ["data", "path"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const data = args["data"];
      const path = args["path"] as string;
      try {
        const result = jsonQuery(data, path);
        return { type: "json", data: result as JsonValue };
      } catch (err) {
        return { type: "error", error: (err as Error).message };
      }
    },
  };
}

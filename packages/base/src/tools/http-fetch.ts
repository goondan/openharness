import type { ToolDefinition, JsonObject, ToolContext, JsonValue } from "@goondan/openharness-types";

export function HttpFetchTool(): ToolDefinition {
  return {
    name: "http_fetch",
    description: "Perform an HTTP request and return the response.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          description: "HTTP method. Defaults to GET.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional request headers.",
        },
        body: { type: "string", description: "Optional request body." },
      },
      required: ["url"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const url = args["url"] as string;
      const method = (args["method"] as string | undefined) ?? "GET";
      const headers = (args["headers"] as Record<string, string> | undefined) ?? {};
      const body = args["body"] as string | undefined;

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? body : undefined,
        });

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        let responseBody: unknown;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          responseBody = await response.json();
        } else {
          responseBody = await response.text();
        }

        return {
          type: "json",
          data: {
            status: response.status,
            headers: responseHeaders,
            body: responseBody as JsonValue,
          },
        };
      } catch (err) {
        return { type: "error", error: (err as Error).message };
      }
    },
  };
}

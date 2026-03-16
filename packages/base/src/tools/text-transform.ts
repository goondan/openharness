import type { ToolDefinition, JsonObject, ToolContext } from "@goondan/openharness-types";

type Operation = "uppercase" | "lowercase" | "trim" | "split" | "replace";

export function TextTransformTool(): ToolDefinition {
  return {
    name: "text_transform",
    description: "Apply a transformation operation to a text string.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The input text to transform." },
        operation: {
          type: "string",
          enum: ["uppercase", "lowercase", "trim", "split", "replace"],
          description: "The transformation to apply.",
        },
        options: {
          type: "object",
          properties: {
            delimiter: { type: "string", description: "Delimiter for split operation." },
            find: { type: "string", description: "String to find for replace operation." },
            replacement: { type: "string", description: "Replacement string for replace operation." },
          },
        },
      },
      required: ["text", "operation"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const text = args["text"] as string;
      const operation = args["operation"] as Operation;
      const options = (args["options"] as Record<string, string> | undefined) ?? {};

      try {
        switch (operation) {
          case "uppercase":
            return { type: "text", text: text.toUpperCase() };
          case "lowercase":
            return { type: "text", text: text.toLowerCase() };
          case "trim":
            return { type: "text", text: text.trim() };
          case "split": {
            const delimiter = options["delimiter"] ?? " ";
            return { type: "json", data: text.split(delimiter) };
          }
          case "replace": {
            const find = options["find"] ?? "";
            const replacement = options["replacement"] ?? "";
            return { type: "text", text: text.split(find).join(replacement) };
          }
          default:
            return { type: "error", error: `Unknown operation: ${operation}` };
        }
      } catch (err) {
        return { type: "error", error: (err as Error).message };
      }
    },
  };
}

import type { Schema } from "ai";
import type { HitlPolicy } from "./hitl.js";

// JsonSchema / primitive types
export type JsonSchema = Record<string, unknown>;
export type JsonSchemaWrapper = Schema;
export type ToolParameters = JsonSchema | JsonSchemaWrapper;
export type JsonObject = Record<string, unknown>;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ToolResult
export type ToolResult =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "error"; error: string };

// ToolContext — used by tool handlers (distinct from ToolCallContext in middleware)
export interface ToolContext {
  conversationId: string;
  agentName: string;
  abortSignal: AbortSignal;
}

// ToolDefinition
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  hitl?: HitlPolicy;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}

// ToolInfo — lightweight summary (no handler)
export interface ToolInfo {
  name: string;
  description: string;
}

export function isJsonSchemaWrapper(value: unknown): value is JsonSchemaWrapper {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "jsonSchema" in value;
}

export function resolveToolParameters(parameters: ToolParameters | undefined): JsonSchema {
  if (!parameters) {
    return {};
  }

  if (isJsonSchemaWrapper(parameters)) {
    const schema = parameters.jsonSchema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema) || "then" in schema) {
      throw new Error("Tool parameters must resolve to a JSON schema object before registration");
    }
    return schema;
  }

  return parameters;
}

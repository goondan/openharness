// JsonSchema / primitive types
export type JsonSchema = Record<string, unknown>;
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
  parameters: JsonSchema;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}

// ToolInfo — lightweight summary (no handler)
export interface ToolInfo {
  name: string;
  description: string;
}

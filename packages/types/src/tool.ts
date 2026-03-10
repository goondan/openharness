import type { JsonObject, JsonValue } from "./json.js";
import type { Message } from "./message.js";

export interface ExecutionContext {
  readonly agentName: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;
}

export interface LoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export interface ToolCallResultError {
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly suggestion?: string;
  readonly helpUrl?: string;
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output?: JsonValue;
  readonly status: "ok" | "error";
  readonly error?: ToolCallResultError;
}

export interface ToolContext extends ExecutionContext {
  readonly toolCallId: string;
  readonly message: Message;
  readonly workdir: string;
  readonly logger: LoggerLike;
}

export type ToolHandler = (ctx: ToolContext, input: JsonObject) => Promise<JsonValue> | JsonValue;

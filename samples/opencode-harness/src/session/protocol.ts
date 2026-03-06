import type { JsonObject, JsonValue } from "@goondan/openharness";

export interface ToolAttachment {
  type: "file";
  url: string;
  mediaType: string;
  filename?: string;
}

export interface ToolPayload {
  output: string;
  title?: string;
  metadata?: Record<string, JsonValue>;
  attachments?: ToolAttachment[];
  truncated?: boolean;
  outputPath?: string;
}

export interface AssistantReasoningPart {
  type: "reasoning";
  id: string;
  text: string;
  state?: "streaming" | "done";
}

export interface AssistantTextPart {
  type: "text";
  id: string;
  text: string;
}

export interface AssistantStepStartPart {
  type: "step-start";
  stepIndex: number;
  startedAt: string;
}

export interface AssistantStepFinishPart {
  type: "step-finish";
  stepIndex: number;
  finishReason: string;
  finishedAt: string;
  usage?: Record<string, JsonValue>;
}

export interface AssistantPatchPart {
  type: "patch";
  files: string[];
  hash: string;
}

export interface AssistantCompactionPart {
  type: "compaction";
  text: string;
}

export interface AssistantToolTime {
  start?: string;
  end?: string;
  compacted?: string;
}

export interface AssistantToolStatePending {
  status: "pending";
  input: JsonObject;
  raw?: string;
  time: AssistantToolTime;
}

export interface AssistantToolStateRunning {
  status: "running";
  input: JsonObject;
  raw?: string;
  time: AssistantToolTime;
}

export interface AssistantToolStateCompleted {
  status: "completed";
  input: JsonObject;
  output: string;
  title?: string;
  metadata?: Record<string, JsonValue>;
  attachments?: ToolAttachment[];
  truncated?: boolean;
  outputPath?: string;
  time: AssistantToolTime;
}

export interface AssistantToolStateError {
  status: "error";
  input: JsonObject;
  error: string;
  time: AssistantToolTime;
}

export type AssistantToolState =
  | AssistantToolStatePending
  | AssistantToolStateRunning
  | AssistantToolStateCompleted
  | AssistantToolStateError;

export interface AssistantToolPart {
  type: "tool";
  tool: string;
  callID: string;
  state: AssistantToolState;
  metadata?: JsonValue;
}

export type AssistantPart =
  | AssistantReasoningPart
  | AssistantTextPart
  | AssistantStepStartPart
  | AssistantStepFinishPart
  | AssistantPatchPart
  | AssistantCompactionPart
  | AssistantToolPart;

export interface ToolResultEnvelope {
  type: "tool-result-envelope";
  payload: ToolPayload;
}

export function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolAttachment(value: unknown): value is ToolAttachment {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "file"
    && typeof (value as { url?: unknown }).url === "string"
    && typeof (value as { mediaType?: unknown }).mediaType === "string"
  );
}

export function isToolPayload(value: unknown): value is ToolPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as {
    output?: unknown;
    title?: unknown;
    metadata?: unknown;
    attachments?: unknown;
    truncated?: unknown;
    outputPath?: unknown;
  };
  if (typeof record.output !== "string") {
    return false;
  }
  if (record.title !== undefined && typeof record.title !== "string") {
    return false;
  }
  if (record.metadata !== undefined && !isJsonRecord(record.metadata as JsonValue)) {
    return false;
  }
  if (record.attachments !== undefined) {
    if (!Array.isArray(record.attachments)) {
      return false;
    }
    if (!record.attachments.every((item) => isToolAttachment(item))) {
      return false;
    }
  }
  if (record.truncated !== undefined && typeof record.truncated !== "boolean") {
    return false;
  }
  if (record.outputPath !== undefined && typeof record.outputPath !== "string") {
    return false;
  }
  return true;
}

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "tool-result-envelope"
    && isToolPayload((value as { payload?: unknown }).payload)
  );
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) {
        continue;
      }
      out[key] = toJsonValue(nested);
    }
    return out;
  }
  return String(value);
}

export function createToolResultEnvelope(payload: ToolPayload): JsonObject {
  return {
    type: "tool-result-envelope",
    payload: toJsonValue(payload) as JsonObject,
  };
}

export function readToolPayload(value: unknown): ToolPayload {
  const normalize = (payload: ToolPayload): ToolPayload => {
    const metadata = isJsonRecord(payload.metadata) ? payload.metadata : undefined;
    return {
      ...payload,
      truncated:
        payload.truncated
        ?? (typeof metadata?.truncated === "boolean" ? metadata.truncated : undefined),
      outputPath:
        payload.outputPath
        ?? (typeof metadata?.outputPath === "string" ? metadata.outputPath : undefined),
    };
  };

  if (isToolResultEnvelope(value)) {
    return normalize(value.payload);
  }
  if (isToolPayload(value)) {
    return normalize(value);
  }
  return normalize({
    output: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  });
}

export function isAssistantPart(value: unknown): value is AssistantPart {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string";
}

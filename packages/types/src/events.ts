import { isJsonValue, isPlainObject } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";

export interface EventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly traceId?: string;
  readonly metadata?: JsonObject;
}

export interface EventSource {
  readonly kind: "agent" | "connector";
  readonly name: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface ReplyChannel {
  readonly target: string;
  readonly correlationId: string;
}

interface TurnAuthPrincipal {
  type: string;
  id: string;
  [key: string]: JsonValue | undefined;
}

interface TurnAuthBase {
  readonly [key: string]: JsonValue | undefined;
}

export type TurnAuth = TurnAuthBase & {
  readonly principal?: TurnAuthPrincipal;
};

export interface AgentEvent extends EventEnvelope {
  readonly input?: string;
  readonly instanceKey?: string;
  readonly source: EventSource;
  readonly auth?: TurnAuth;
  readonly replyTo?: ReplyChannel;
}

export type ProcessStatus =
  | "spawning"
  | "idle"
  | "processing"
  | "draining"
  | "terminated"
  | "crashed"
  | "crashLoopBackOff";

export type IpcMessageType = "event" | "shutdown" | "shutdown_ack";

export interface IpcMessage {
  type: IpcMessageType;
  from: string;
  to: string;
  payload: JsonValue;
}

export type ShutdownReason = "restart" | "config_change" | "orchestrator_shutdown";

export function isProcessStatus(value: unknown): value is ProcessStatus {
  if (typeof value !== "string") {
    return false;
  }
  return (
    value === "spawning" ||
    value === "idle" ||
    value === "processing" ||
    value === "draining" ||
    value === "terminated" ||
    value === "crashed" ||
    value === "crashLoopBackOff"
  );
}

export function isIpcMessageType(value: unknown): value is IpcMessageType {
  return value === "event" || value === "shutdown" || value === "shutdown_ack";
}

export function isShutdownReason(value: unknown): value is ShutdownReason {
  return value === "restart" || value === "config_change" || value === "orchestrator_shutdown";
}

export function isIpcMessage(value: unknown): value is IpcMessage {
  if (!isPlainObject(value)) {
    return false;
  }

  const typeValue = value["type"];
  const fromValue = value["from"];
  const toValue = value["to"];
  const payloadValue = value["payload"];

  if (!isIpcMessageType(typeValue)) {
    return false;
  }

  if (typeof fromValue !== "string" || fromValue.length === 0) {
    return false;
  }

  if (typeof toValue !== "string" || toValue.length === 0) {
    return false;
  }

  return isJsonValue(payloadValue);
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isPlainObject(value)) {
    return false;
  }

  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    return false;
  }

  if (typeof value["type"] !== "string" || value["type"].length === 0) {
    return false;
  }

  const createdAtValue = value["createdAt"];
  if (!(createdAtValue instanceof Date) || Number.isNaN(createdAtValue.getTime())) {
    return false;
  }

  const traceIdValue = value["traceId"];
  if (traceIdValue !== undefined && typeof traceIdValue !== "string") {
    return false;
  }

  return true;
}

export function isReplyChannel(value: unknown): value is ReplyChannel {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value["target"] === "string" &&
    typeof value["correlationId"] === "string" &&
    value["target"].length > 0 &&
    value["correlationId"].length > 0
  );
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isPlainObject(value)) {
    return false;
  }

  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    return false;
  }

  if (typeof value["type"] !== "string" || value["type"].length === 0) {
    return false;
  }

  const createdAtValue = value["createdAt"];
  if (!(createdAtValue instanceof Date) || Number.isNaN(createdAtValue.getTime())) {
    return false;
  }

  const sourceValue = value["source"];
  if (!isEventSource(sourceValue)) {
    return false;
  }

  const inputValue = value["input"];
  if (inputValue !== undefined && typeof inputValue !== "string") {
    return false;
  }

  const instanceKeyValue = value["instanceKey"];
  if (instanceKeyValue !== undefined && typeof instanceKeyValue !== "string") {
    return false;
  }

  const replyToValue = value["replyTo"];
  if (replyToValue !== undefined && !isReplyChannel(replyToValue)) {
    return false;
  }

  return true;
}

function isEventSource(value: unknown): value is EventSource {
  if (!isPlainObject(value)) {
    return false;
  }

  const kindValue = value["kind"];
  if (kindValue !== "agent" && kindValue !== "connector") {
    return false;
  }

  const nameValue = value["name"];
  if (typeof nameValue !== "string" || nameValue.length === 0) {
    return false;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    const fieldValue = value[key];
    if (fieldValue !== undefined && !isJsonValue(fieldValue)) {
      return false;
    }
  }

  return true;
}


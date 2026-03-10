import { isJsonValue, isPlainObject } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";
import { isInboundContentPart, type InboundContentPart, type InboundPropertyValue } from "./connector.js";

export interface EventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly traceId?: string;
  readonly metadata?: JsonObject;
}

export interface EventSource {
  readonly kind: "connector";
  readonly name: string;
  readonly [key: string]: JsonValue | undefined;
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
  readonly content?: InboundContentPart[];
  readonly properties?: Record<string, InboundPropertyValue>;
  readonly conversationId?: string;
  readonly source: EventSource;
  readonly auth?: TurnAuth;
  readonly rawPayload?: JsonValue;
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

  const contentValue = value["content"];
  if (
    contentValue !== undefined &&
    (!Array.isArray(contentValue) || !contentValue.every((item) => isInboundContentPart(item)))
  ) {
    return false;
  }

  const propertiesValue = value["properties"];
  if (propertiesValue !== undefined) {
    if (!isPlainObject(propertiesValue)) {
      return false;
    }

    for (const propertyValue of Object.values(propertiesValue)) {
      if (
        typeof propertyValue !== "string" &&
        typeof propertyValue !== "number" &&
        typeof propertyValue !== "boolean"
      ) {
        return false;
      }
    }
  }

  const conversationIdValue = value["conversationId"];
  if (conversationIdValue !== undefined && typeof conversationIdValue !== "string") {
    return false;
  }

  const rawPayloadValue = value["rawPayload"];
  if (rawPayloadValue !== undefined && !isJsonValue(rawPayloadValue)) {
    return false;
  }

  return true;
}

function isEventSource(value: unknown): value is EventSource {
  if (!isPlainObject(value)) {
    return false;
  }

  const kindValue = value["kind"];
  if (kindValue !== "connector") {
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

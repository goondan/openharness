/**
 * Connector 어댑터/ingress 입력 계약
 */

import { isJsonValue, isPlainObject } from "./json.js";
import type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
import type { EventSource, TurnAuth } from "./events.js";
import type { LoggerLike } from "./tool.js";

export type InboundPropertyValue = Exclude<JsonPrimitive, null>;

export type InboundContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
      alt?: string;
    }
  | {
      type: "file";
      url: string;
      name: string;
      mimeType?: string;
    };

/**
 * 정규화된 ingress 입력 이벤트
 */
export interface InboundEnvelope {
  readonly name: string;
  readonly content: InboundContentPart[];
  readonly properties: Record<string, InboundPropertyValue>;
  readonly instanceKey?: string;
  readonly auth?: TurnAuth;
  readonly rawPayload?: JsonValue;
  readonly source: EventSource;
  readonly metadata?: JsonObject;
}

/**
 * Connector adapter에 전달되는 컨텍스트
 */
export interface ConnectorAdapterContext {
  readonly payload: unknown;
  readonly connectionName: string;
  readonly config: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly logger: LoggerLike;
  readonly receivedAt: string;
}

export interface ConnectorAdapter {
  verify?(ctx: ConnectorAdapterContext): Promise<void> | void;
  normalize(
    ctx: ConnectorAdapterContext,
  ): Promise<InboundEnvelope | InboundEnvelope[]> | InboundEnvelope | InboundEnvelope[];
}

/**
 * legacy connector 계약 호환 alias
 * @deprecated use InboundContentPart
 */
export type ConnectorEventMessage = InboundContentPart;

/**
 * legacy connector 계약 호환 alias
 * @deprecated use InboundEnvelope
 */
export interface ConnectorEvent {
  readonly name: string;
  readonly message: ConnectorEventMessage;
  readonly properties: Record<string, string>;
  readonly instanceKey: string;
}

/**
 * legacy connector 계약 호환 alias
 * @deprecated use ConnectorAdapterContext/ConnectorAdapter
 */
export interface ConnectorContext extends ConnectorAdapterContext {
  emit(event: ConnectorEvent): Promise<void>;
}

/** InboundContentPart 타입 가드 */
export function isInboundContentPart(value: unknown): value is InboundContentPart {
  if (!isPlainObject(value)) return false;

  const typeValue = value["type"];
  if (typeValue === "text") return typeof value["text"] === "string";
  if (typeValue === "image") {
    return (
      typeof value["url"] === "string" &&
      (value["alt"] === undefined || typeof value["alt"] === "string")
    );
  }
  if (typeValue === "file") {
    return (
      typeof value["url"] === "string" &&
      typeof value["name"] === "string" &&
      (value["mimeType"] === undefined || typeof value["mimeType"] === "string")
    );
  }
  return false;
}

function isInboundProperties(value: unknown): value is Record<string, InboundPropertyValue> {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const propertyValue of Object.values(value)) {
    if (
      typeof propertyValue !== "string" &&
      typeof propertyValue !== "number" &&
      typeof propertyValue !== "boolean"
    ) {
      return false;
    }
  }

  return true;
}

function isEventSourceLike(value: unknown): value is EventSource {
  if (!isPlainObject(value)) {
    return false;
  }

  const kind = value["kind"];
  if (kind !== "agent" && kind !== "connector") {
    return false;
  }

  if (typeof value["name"] !== "string" || value["name"].length === 0) {
    return false;
  }

  for (const fieldValue of Object.values(value)) {
    if (fieldValue !== undefined && !isJsonValue(fieldValue)) {
      return false;
    }
  }

  return true;
}

/** InboundEnvelope 타입 가드 */
export function isInboundEnvelope(value: unknown): value is InboundEnvelope {
  if (!isPlainObject(value)) return false;

  return (
    typeof value["name"] === "string" &&
    Array.isArray(value["content"]) &&
    value["content"].every((item) => isInboundContentPart(item)) &&
    isInboundProperties(value["properties"]) &&
    (value["instanceKey"] === undefined || typeof value["instanceKey"] === "string") &&
    (value["rawPayload"] === undefined || isJsonValue(value["rawPayload"])) &&
    (value["metadata"] === undefined || isPlainObject(value["metadata"])) &&
    isEventSourceLike(value["source"])
  );
}

/** ConnectorEvent 타입 가드 */
export function isConnectorEvent(value: unknown): value is ConnectorEvent {
  if (!isPlainObject(value)) return false;

  return (
    typeof value["name"] === "string" &&
    isInboundContentPart(value["message"]) &&
    isPlainObject(value["properties"]) &&
    typeof value["instanceKey"] === "string"
  );
}

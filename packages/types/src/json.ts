export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValue(item)) {
        return false;
      }
    }
    return true;
  }

  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    const fieldValue = value[key];
    if (!isJsonValue(fieldValue)) {
      return false;
    }
  }

  return true;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


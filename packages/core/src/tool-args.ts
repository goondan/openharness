import type { JsonObject } from "@goondan/openharness-types";

const MAX_JSON_STRING_DEPTH = 3;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Some providers can surface tool input as a JSON-encoded string instead of an
 * object. Recover only when the decoded value is an object so malformed inputs
 * still fail the normal schema validation path.
 */
export function normalizeToolArgs(input: unknown): JsonObject {
  let current = input;

  for (
    let depth = 0;
    depth < MAX_JSON_STRING_DEPTH && typeof current === "string";
    depth += 1
  ) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return input as JsonObject;
    }
  }

  if (isPlainObject(current)) {
    return current;
  }

  return input as JsonObject;
}

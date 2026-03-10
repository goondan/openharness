import { isPlainObject } from "@goondan/openharness-types";
import type { JsonObject } from "@goondan/openharness-types";

export * from "@goondan/openharness-types";

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

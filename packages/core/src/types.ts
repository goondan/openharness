import { isPlainObject } from "@goondan/openharness-types";
import type { JsonObject, Resource } from "@goondan/openharness-types";

export * from "@goondan/openharness-types";

export interface RuntimeResource<T = unknown> extends Resource<T> {
  __file: string;
  __docIndex: number;
  __package?: string;
  __rootDir?: string;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

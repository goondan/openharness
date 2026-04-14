import type { EnvRef } from "@goondan/openharness-types";
import { ConfigError } from "./errors.js";

export function isEnvRef(value: unknown): value is EnvRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}

export function resolveEnv(value: string | EnvRef): string {
  if (typeof value === "string") return value;
  const envValue = process.env[value.name];
  if (envValue === undefined) {
    throw new ConfigError(`Environment variable "${value.name}" is not set`);
  }
  return envValue;
}

export function resolveEnvDeep<T>(value: T): T {
  if (isEnvRef(value)) {
    return resolveEnv(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvDeep(item)) as T;
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        resolveEnvDeep(entryValue),
      ]),
    ) as T;
  }

  return value;
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

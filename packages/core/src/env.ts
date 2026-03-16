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

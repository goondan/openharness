import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { JsonArray, JsonObject, JsonValue, Message, MessageContentPart } from './types.js';

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  for (const candidate of Object.values(value)) {
    if (!isJsonValue(candidate)) {
      return false;
    }
  }

  return true;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  for (const candidate of Object.values(value)) {
    if (!isJsonValue(candidate)) {
      return false;
    }
  }

  return true;
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value) && value.every((item) => isJsonValue(item));
}

export function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isJsonObject(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string`);
  }
  return value;
}

export function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`'${key}' must be a string`);
  }
  return value;
}

export function optionalNumber(
  input: JsonObject,
  key: string,
  fallback?: number
): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`'${key}' must be a valid number`);
  }
  return value;
}

export function optionalBoolean(
  input: JsonObject,
  key: string,
  fallback?: boolean
): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`'${key}' must be a boolean`);
  }
  return value;
}

export function optionalStringArray(input: JsonObject, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`'${key}' must be an array of strings`);
  }

  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`'${key}' must contain only strings`);
    }
    output.push(item);
  }
  return output;
}

export function optionalJsonObject(input: JsonObject, key: string): JsonObject | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new Error(`'${key}' must be a JSON object`);
  }
  return value;
}

export function resolveFromWorkdir(workdir: string, targetPath: string): string {
  if (targetPath.startsWith('/')) {
    return targetPath;
  }
  return join(workdir, targetPath);
}

function isTextContentPart(
  part: MessageContentPart
): part is MessageContentPart & { text: string } {
  return part.type === 'text' && typeof part.text === 'string';
}

export function estimateMessageLength(message: Message): number {
  const content = message.data.content;
  if (typeof content === 'string') {
    return content.length;
  }

  let total = 0;
  for (const part of content) {
    if (isTextContentPart(part)) {
      total += part.text.length;
    }
  }
  return total;
}

export function truncateString(text: string, maxLength: number): string {
  if (maxLength < 1) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

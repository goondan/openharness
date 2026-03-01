import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';
import {
  isJsonArray,
  isJsonObject,
  isJsonValue,
  optionalNumber,
  optionalString,
  requireString,
} from '../utils.js';

function parsePath(path: string): string[] {
  if (path.length === 0 || path === '.') {
    return [];
  }

  const raw = path.startsWith('.') ? path.slice(1) : path;
  const segments: string[] = [];
  let current = '';
  let insideBracket = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      continue;
    }

    if (char === '[') {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      insideBracket = true;
      continue;
    }

    if (char === ']') {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      insideBracket = false;
      continue;
    }

    if (char === '.' && !insideBracket) {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function resolveSegment(value: JsonValue, segment: string): JsonValue | undefined {
  if (isJsonObject(value)) {
    const result = value[segment];
    return result === undefined ? undefined : result;
  }

  if (isJsonArray(value)) {
    const index = Number.parseInt(segment, 10);
    if (Number.isNaN(index) || index < 0 || index >= value.length) {
      return undefined;
    }
    return value[index];
  }

  return undefined;
}

function resolveQuery(data: JsonValue, path: string): JsonValue | undefined {
  const segments = parsePath(path);

  let current: JsonValue | undefined = data;
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = resolveSegment(current, segment);
  }

  return current;
}

function parseInput(raw: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonValue(parsed)) {
      throw new Error('Parsed value is not a valid JSON value');
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message === 'Parsed value is not a valid JSON value') {
      throw err;
    }
    throw new Error('Failed to parse input as JSON');
  }
}

export const query: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const dataRaw = requireString(input, 'data');
  const path = optionalString(input, 'path') ?? '.';

  const data = parseInput(dataRaw);
  const result = resolveQuery(data, path);

  return {
    path,
    found: result !== undefined,
    value: result ?? null,
  };
};

export const pick: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const dataRaw = requireString(input, 'data');
  const keysRaw = input.keys;

  if (!Array.isArray(keysRaw)) {
    throw new Error("'keys' must be an array of strings");
  }

  const keys: string[] = [];
  for (const key of keysRaw) {
    if (typeof key !== 'string') {
      throw new Error("'keys' must contain only strings");
    }
    keys.push(key);
  }

  const data = parseInput(dataRaw);
  if (!isJsonObject(data)) {
    throw new Error('Input data must be a JSON object for pick operation');
  }

  const result: JsonObject = {};
  for (const key of keys) {
    const value = data[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return {
    keys,
    result,
  };
};

export const count: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const dataRaw = requireString(input, 'data');
  const path = optionalString(input, 'path') ?? '.';

  const data = parseInput(dataRaw);
  const resolved = resolveQuery(data, path);

  if (resolved === undefined || resolved === null) {
    return { path, count: 0, type: 'null' };
  }

  if (isJsonArray(resolved)) {
    return { path, count: resolved.length, type: 'array' };
  }

  if (isJsonObject(resolved)) {
    return { path, count: Object.keys(resolved).length, type: 'object' };
  }

  if (typeof resolved === 'string') {
    return { path, count: resolved.length, type: 'string' };
  }

  return { path, count: 1, type: typeof resolved };
};

export const flatten: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const dataRaw = requireString(input, 'data');
  const depth = optionalNumber(input, 'depth', 1) ?? 1;

  const data = parseInput(dataRaw);
  if (!isJsonArray(data)) {
    throw new Error('Input data must be a JSON array for flatten operation');
  }

  function flattenRecursive(arr: JsonValue[], currentDepth: number): JsonValue[] {
    const result: JsonValue[] = [];
    for (const item of arr) {
      if (isJsonArray(item) && currentDepth > 0) {
        result.push(...flattenRecursive(item, currentDepth - 1));
      } else {
        result.push(item);
      }
    }
    return result;
  }

  const result = flattenRecursive(data, depth);

  return {
    depth,
    count: result.length,
    result,
  };
};

export const handlers = {
  query,
  pick,
  count,
  flatten,
} satisfies Record<string, ToolHandler>;

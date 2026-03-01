import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';
import {
  optionalNumber,
  optionalString,
  requireString,
} from '../utils.js';

export const replace: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const text = requireString(input, 'text');
  const search = requireString(input, 'search');
  const replacement = optionalString(input, 'replacement') ?? '';
  const allOccurrences = input.all === true;

  let result: string;
  if (allOccurrences) {
    result = text.split(search).join(replacement);
  } else {
    const index = text.indexOf(search);
    if (index < 0) {
      result = text;
    } else {
      result = text.slice(0, index) + replacement + text.slice(index + search.length);
    }
  }

  return {
    original: text,
    result,
    replacements: allOccurrences
      ? text.split(search).length - 1
      : (text.includes(search) ? 1 : 0),
  };
};

export const slice: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const text = requireString(input, 'text');
  const start = optionalNumber(input, 'start', 0) ?? 0;
  const end = optionalNumber(input, 'end');

  const result = end !== undefined ? text.slice(start, end) : text.slice(start);

  return {
    original: text,
    result,
    start,
    end: end ?? text.length,
    length: result.length,
  };
};

export const split: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const text = requireString(input, 'text');
  const delimiter = optionalString(input, 'delimiter') ?? '\n';
  const maxParts = optionalNumber(input, 'maxParts');

  const parts = maxParts !== undefined ? text.split(delimiter, maxParts) : text.split(delimiter);

  return {
    delimiter,
    count: parts.length,
    parts,
  };
};

export const join: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const partsRaw = input.parts;
  if (!Array.isArray(partsRaw)) {
    throw new Error("'parts' must be an array");
  }

  const parts: string[] = [];
  for (const item of partsRaw) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      parts.push(String(item));
    } else {
      throw new Error("'parts' must contain only string/number/boolean values");
    }
  }

  const delimiter = optionalString(input, 'delimiter') ?? '\n';
  const result = parts.join(delimiter);

  return {
    delimiter,
    count: parts.length,
    result,
  };
};

export const trim: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const text = requireString(input, 'text');
  const mode = optionalString(input, 'mode') ?? 'both';

  let result: string;
  switch (mode) {
    case 'start':
      result = text.trimStart();
      break;
    case 'end':
      result = text.trimEnd();
      break;
    default:
      result = text.trim();
      break;
  }

  return {
    original: text,
    result,
    mode,
    trimmedLength: text.length - result.length,
  };
};

export const caseTransform: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const text = requireString(input, 'text');
  const to = requireString(input, 'to');

  let result: string;
  switch (to) {
    case 'upper':
      result = text.toUpperCase();
      break;
    case 'lower':
      result = text.toLowerCase();
      break;
    default:
      throw new Error(`Unsupported case transform '${to}'. Use 'upper' or 'lower'.`);
  }

  return {
    original: text,
    result,
    to,
  };
};

export const handlers = {
  replace,
  slice,
  split,
  join,
  trim,
  case: caseTransform,
} satisfies Record<string, ToolHandler>;

import type { JsonObject } from "@goondan/openharness-types";

const MAX_JSON_STRING_DEPTH = 3;
const MAX_MALFORMED_TOOL_ARGS_PREVIEW_LENGTH = 2000;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringifyPreview(input: unknown): string {
  const text =
    typeof input === "string"
      ? input
      : (() => {
          try {
            return JSON.stringify(input);
          } catch {
            return String(input);
          }
        })();

  if (text.length <= MAX_MALFORMED_TOOL_ARGS_PREVIEW_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_MALFORMED_TOOL_ARGS_PREVIEW_LENGTH)}... [truncated]`;
}

function buildMalformedToolArgsError(input: unknown): string {
  return [
    "Malformed tool arguments: expected a JSON object.",
    "The tool was not executed. Retry this tool call with a valid object input.",
    `Original arguments preview: ${stringifyPreview(input)}`,
  ].join("\n");
}

export type ToolArgsNormalizationResult =
  | {
      ok: true;
      args: JsonObject;
    }
  | {
      ok: false;
      args: JsonObject;
      error: string;
    };

/**
 * Some providers can surface tool input as a JSON-encoded string instead of an
 * object. Recover only when the decoded value is an object. Malformed inputs
 * become an empty object plus an error that can be surfaced as a tool result
 * without poisoning the conversation history with protocol-invalid tool args.
 */
export function normalizeToolArgsResult(input: unknown): ToolArgsNormalizationResult {
  let current = input;

  for (
    let depth = 0;
    depth < MAX_JSON_STRING_DEPTH && typeof current === "string";
    depth += 1
  ) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return {
        ok: false,
        args: {},
        error: buildMalformedToolArgsError(input),
      };
    }
  }

  if (isPlainObject(current)) {
    return {
      ok: true,
      args: current,
    };
  }

  return {
    ok: false,
    args: {},
    error: buildMalformedToolArgsError(input),
  };
}

/**
 * Backward-compatible helper for call sites that only need canonical args.
 */
export function normalizeToolArgs(input: unknown): JsonObject {
  return normalizeToolArgsResult(input).args;
}

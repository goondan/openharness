import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';
import {
  optionalJsonObject,
  optionalNumber,
  optionalString,
  requireString,
} from '../utils.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_RESPONSE_BYTES = 500_000;

function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Unsupported protocol '${parsed.protocol}'. Only http: and https: are allowed.`
    );
  }

  return parsed;
}

function headersFromJson(input: JsonObject | undefined): Record<string, string> {
  if (!input) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      output[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      output[key] = String(value);
    }
  }
  return output;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const size = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > maxBytes) {
      const buffer = new Uint8Array(maxBytes);
      const reader = response.body?.getReader();
      if (!reader) {
        return { text: '', truncated: false };
      }

      let offset = 0;
      let done = false;
      while (!done && offset < maxBytes) {
        const chunk = await reader.read();
        done = chunk.done;
        if (chunk.value) {
          const remaining = maxBytes - offset;
          const slice = chunk.value.subarray(0, remaining);
          buffer.set(slice, offset);
          offset += slice.byteLength;
        }
      }
      reader.cancel().catch(() => {});
      return {
        text: new TextDecoder().decode(buffer.subarray(0, offset)),
        truncated: true,
      };
    }
  }

  const text = await response.text();
  if (text.length > maxBytes) {
    return { text: text.slice(0, maxBytes), truncated: true };
  }
  return { text, truncated: false };
}

function buildResult(
  url: string,
  method: string,
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
  truncated: boolean,
  durationMs: number
): JsonObject {
  return {
    url,
    method,
    status,
    statusText,
    headers,
    body,
    truncated,
    durationMs,
  };
}

function extractResponseHeaders(response: Response): Record<string, string> {
  const output: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

export const get: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const url = requireString(input, 'url');
  const parsed = validateUrl(url);
  const headers = headersFromJson(optionalJsonObject(input, 'headers'));
  const timeoutMs = optionalNumber(input, 'timeoutMs', 30_000) ?? 30_000;
  const maxBytes = optionalNumber(input, 'maxBytes', MAX_RESPONSE_BYTES) ?? MAX_RESPONSE_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  try {
    const response = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const responseHeaders = extractResponseHeaders(response);
    const { text, truncated } = await readResponseBody(response, maxBytes);

    return buildResult(
      parsed.toString(),
      'GET',
      response.status,
      response.statusText,
      responseHeaders,
      text,
      truncated,
      Date.now() - startedAt
    );
  } finally {
    clearTimeout(timer);
  }
};

export const post: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const url = requireString(input, 'url');
  const parsed = validateUrl(url);
  const headers = headersFromJson(optionalJsonObject(input, 'headers'));
  const timeoutMs = optionalNumber(input, 'timeoutMs', 30_000) ?? 30_000;
  const maxBytes = optionalNumber(input, 'maxBytes', MAX_RESPONSE_BYTES) ?? MAX_RESPONSE_BYTES;
  const bodyInput = optionalJsonObject(input, 'body');
  const bodyString = optionalString(input, 'bodyString');

  let requestBody: string | undefined;
  if (bodyInput) {
    requestBody = JSON.stringify(bodyInput);
    if (!headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }
  } else if (bodyString) {
    requestBody = bodyString;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  try {
    const response = await fetch(parsed.toString(), {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    const responseHeaders = extractResponseHeaders(response);
    const { text, truncated } = await readResponseBody(response, maxBytes);

    return buildResult(
      parsed.toString(),
      'POST',
      response.status,
      response.statusText,
      responseHeaders,
      text,
      truncated,
      Date.now() - startedAt
    );
  } finally {
    clearTimeout(timer);
  }
};

export const handlers = {
  get,
  post,
} satisfies Record<string, ToolHandler>;

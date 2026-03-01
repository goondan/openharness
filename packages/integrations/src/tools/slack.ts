import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';
import {
  isJsonObject,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requireString,
  resolveFromWorkdir,
} from '../utils.js';

const SLACK_API_BASE_URL = 'https://slack.com/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const SLACK_TOKEN_ENV_KEYS = [
  'SLACK_BOT_TOKEN',
  'SLACK_TOKEN',
];

type SlackMethod =
  | 'chat.postMessage'
  | 'chat.update'
  | 'chat.delete'
  | 'reactions.add'
  | 'conversations.history'
  | 'conversations.replies';

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  channel?: string;
  ts?: string;
  message?: unknown;
  messages?: unknown;
  hasMore?: boolean;
  nextCursor?: string;
}

interface SlackFileDownloadResult {
  buffer: Buffer;
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
  contentDisposition: string | null;
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.endsWith('/')) {
    return apiBaseUrl.slice(0, -1);
  }
  return apiBaseUrl;
}

function buildSlackApiUrl(apiBaseUrl: string, method: SlackMethod): string {
  return `${normalizeApiBaseUrl(apiBaseUrl)}/${method}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function requireChannelId(input: JsonObject): string {
  const channelId = toNonEmptyString(input.channelId) ?? toNonEmptyString(input.channel);
  if (!channelId) {
    throw new Error("'channelId' must be a non-empty string");
  }
  return channelId;
}

function requireMessageTs(input: JsonObject): string {
  const messageTs = toNonEmptyString(input.messageTs)
    ?? toNonEmptyString(input.ts)
    ?? toNonEmptyString(input.timestamp);
  if (!messageTs) {
    throw new Error("'messageTs' must be a non-empty string");
  }
  return messageTs;
}

function optionalMessageTs(input: JsonObject): string | undefined {
  return toNonEmptyString(input.messageTs)
    ?? toNonEmptyString(input.ts)
    ?? toNonEmptyString(input.timestamp);
}

function resolveListLimit(input: JsonObject, fallback: number): number {
  const raw = optionalNumber(input, 'limit', fallback) ?? fallback;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("'limit' must be a positive number");
  }

  const limit = Math.trunc(raw);
  if (limit < 1 || limit > 1000) {
    throw new Error("'limit' must be between 1 and 1000");
  }

  return limit;
}

function resolveDownloadUrl(input: JsonObject): string {
  const url = toNonEmptyString(input.url)
    ?? toNonEmptyString(input.fileUrl)
    ?? toNonEmptyString(input.downloadUrl);
  if (!url) {
    throw new Error("Provide 'url' (or 'fileUrl'/'downloadUrl') to download Slack file.");
  }
  return url;
}

function resolveMaxBytes(input: JsonObject, fallback = 3_000_000): number {
  const raw = optionalNumber(input, 'maxBytes', fallback) ?? fallback;
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("'maxBytes' must be a positive number");
  }
  const maxBytes = Math.trunc(raw);
  if (maxBytes < 1 || maxBytes > 20_000_000) {
    throw new Error("'maxBytes' must be between 1 and 20000000");
  }
  return maxBytes;
}

function optionalSavePath(input: JsonObject): string | undefined {
  const value = optionalString(input, 'savePath') ?? optionalString(input, 'outputPath');
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function resolveSlackToken(input: JsonObject): string {
  const inputToken = optionalString(input, 'token');
  if (inputToken && inputToken.length > 0) {
    return inputToken;
  }

  for (const envKey of SLACK_TOKEN_ENV_KEYS) {
    const envValue = process.env[envKey];
    if (typeof envValue === 'string' && envValue.length > 0) {
      return envValue;
    }
  }

  throw new Error(
    "Slack bot token not found. Provide 'token' or set SLACK_BOT_TOKEN/SLACK_TOKEN."
  );
}

function resolveTimeoutMs(input: JsonObject): number {
  const timeoutMs = optionalNumber(input, 'timeoutMs', DEFAULT_REQUEST_TIMEOUT_MS) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("'timeoutMs' must be a positive number");
  }
  return Math.trunc(timeoutMs);
}

function resolveApiBaseUrl(input: JsonObject): string {
  const apiBaseUrl = optionalString(input, 'apiBaseUrl');
  if (apiBaseUrl && apiBaseUrl.length > 0) {
    return apiBaseUrl;
  }
  return SLACK_API_BASE_URL;
}

function compactJson(input: Record<string, JsonValue | undefined>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Slack API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function defaultHttpDescription(response: Response): string {
  if (response.statusText.length > 0) {
    return `HTTP ${response.status} ${response.statusText}`;
  }
  return `HTTP ${response.status}`;
}

async function parseSlackApiResponse(response: Response): Promise<SlackApiResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: defaultHttpDescription(response),
    };
  }

  if (!isJsonObject(body)) {
    return {
      ok: false,
      error: defaultHttpDescription(response),
    };
  }

  const error = toNonEmptyString(body.error);
  const warning = toNonEmptyString(body.warning);
  const channel = toNonEmptyString(body.channel);
  const ts = toNonEmptyString(body.ts);
  const message = body.message;
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  const hasMore = typeof body.has_more === 'boolean' ? body.has_more : undefined;

  let nextCursor: string | undefined;
  if (isJsonObject(body.response_metadata)) {
    nextCursor = toNonEmptyString(body.response_metadata.next_cursor);
  }

  return {
    ok: body.ok === true,
    error,
    warning,
    channel,
    ts,
    message,
    messages,
    hasMore,
    nextCursor,
  };
}

async function callSlackMethod(
  method: SlackMethod,
  token: string,
  payload: JsonObject,
  input: JsonObject
): Promise<SlackApiResponse> {
  const timeoutMs = resolveTimeoutMs(input);
  const apiBaseUrl = resolveApiBaseUrl(input);
  const url = buildSlackApiUrl(apiBaseUrl, method);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
  } catch (error) {
    throw new Error(`[slack] ${method} request failed: ${toErrorMessage(error)}`);
  }

  const parsed = await parseSlackApiResponse(response);
  if (!response.ok || !parsed.ok) {
    const reason = parsed.error ?? defaultHttpDescription(response);
    throw new Error(`[slack] ${method} failed: ${reason}`);
  }

  return parsed;
}

async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const parsedLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error(`Slack file exceeds maxBytes limit (${parsedLength} > ${maxBytes})`);
    }
  }

  const raw = await response.arrayBuffer();
  const buffer = Buffer.from(raw);
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Slack file exceeds maxBytes limit (${buffer.byteLength} > ${maxBytes})`);
  }
  return buffer;
}

function resolveFileContentType(response: Response): string | null {
  const header = response.headers.get('content-type');
  return header && header.length > 0 ? header : null;
}

function buildDataUrl(contentType: string | null, buffer: Buffer): string | null {
  if (!contentType || buffer.byteLength === 0) {
    return null;
  }
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function downloadSlackFile(
  input: JsonObject,
  token: string
): Promise<SlackFileDownloadResult> {
  const timeoutMs = resolveTimeoutMs(input);
  const maxBytes = resolveMaxBytes(input);
  const url = resolveDownloadUrl(input);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
      timeoutMs
    );
  } catch (error) {
    throw new Error(`[slack] file download request failed: ${toErrorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`[slack] file download failed: ${defaultHttpDescription(response)}`);
  }

  return {
    buffer: await readResponseBuffer(response, maxBytes),
    contentType: resolveFileContentType(response),
    contentLength: (() => {
      const header = response.headers.get('content-length');
      if (!header) {
        return null;
      }
      const parsed = Number.parseInt(header, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
      }
      return parsed;
    })(),
    etag: response.headers.get('etag'),
    contentDisposition: response.headers.get('content-disposition'),
  };
}

function extractMessageText(message: unknown): string | null {
  if (!isJsonObject(message)) {
    return null;
  }

  const text = toNonEmptyString(message.text);
  return text ?? null;
}

function normalizeEmojiName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith(':') && trimmed.endsWith(':') && trimmed.length >= 3) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveReactionNames(input: JsonObject): string[] {
  const names: string[] = [];
  const single = optionalString(input, 'emoji');
  if (single && single.length > 0) {
    names.push(normalizeEmojiName(single));
  }

  const array = optionalStringArray(input, 'emojis') ?? [];
  for (const raw of array) {
    names.push(normalizeEmojiName(raw));
  }

  const filtered = names
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (filtered.length === 0) {
    throw new Error("Provide 'emoji' or 'emojis' to add Slack reaction.");
  }

  const unique = [...new Set(filtered)];
  for (const name of unique) {
    if (/\s/.test(name)) {
      throw new Error(`Invalid emoji name '${name}'. Emoji names must not contain whitespace.`);
    }
  }

  return unique;
}

function extractMessageObjects(messages: unknown): JsonObject[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const output: JsonObject[] = [];
  for (const candidate of messages) {
    if (isJsonObject(candidate)) {
      output.push(candidate);
    }
  }

  return output;
}

export const send: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveSlackToken(input);
  const channelId = requireChannelId(input);
  const text = requireString(input, 'text');
  const threadTs = optionalString(input, 'threadTs');
  const mrkdwn = optionalBoolean(input, 'mrkdwn');
  const unfurlLinks = optionalBoolean(input, 'unfurlLinks');
  const unfurlMedia = optionalBoolean(input, 'unfurlMedia');
  const replyBroadcast = optionalBoolean(input, 'replyBroadcast');

  const result = await callSlackMethod(
    'chat.postMessage',
    token,
    compactJson({
      channel: channelId,
      text,
      thread_ts: threadTs,
      mrkdwn,
      unfurl_links: unfurlLinks,
      unfurl_media: unfurlMedia,
      reply_broadcast: replyBroadcast,
    }),
    input
  );

  return {
    ok: true,
    channelId: result.channel ?? channelId,
    messageTs: result.ts ?? null,
    text: extractMessageText(result.message) ?? text,
  };
};

export const edit: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveSlackToken(input);
  const channelId = requireChannelId(input);
  const messageTs = requireMessageTs(input);
  const text = requireString(input, 'text');
  const mrkdwn = optionalBoolean(input, 'mrkdwn');

  const result = await callSlackMethod(
    'chat.update',
    token,
    compactJson({
      channel: channelId,
      ts: messageTs,
      text,
      mrkdwn,
    }),
    input
  );

  return {
    ok: true,
    channelId: result.channel ?? channelId,
    messageTs: result.ts ?? messageTs,
    edited: true,
  };
};

export const read: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveSlackToken(input);
  const channelId = requireChannelId(input);
  const messageTs = optionalMessageTs(input);
  const threadTs = toNonEmptyString(input.threadTs);
  const latest = toNonEmptyString(input.latest);
  const oldest = toNonEmptyString(input.oldest);
  const cursor = toNonEmptyString(input.cursor);
  const inclusiveInput = optionalBoolean(input, 'inclusive');
  const limit = resolveListLimit(input, messageTs ? 1 : 20);

  const effectiveLatest = latest ?? messageTs;
  const inclusive = inclusiveInput ?? (messageTs ? true : undefined);
  const method: SlackMethod = threadTs ? 'conversations.replies' : 'conversations.history';

  const result = await callSlackMethod(
    method,
    token,
    compactJson({
      channel: channelId,
      ts: threadTs,
      latest: effectiveLatest,
      oldest,
      inclusive,
      limit,
      cursor,
    }),
    input
  );

  const messages = extractMessageObjects(result.messages);
  const found = messageTs
    ? messages.find((message) => toNonEmptyString(message.ts) === messageTs) ?? null
    : null;

  return {
    ok: true,
    channelId,
    method,
    messageTs: messageTs ?? null,
    threadTs: threadTs ?? null,
    count: messages.length,
    found,
    messages,
    hasMore: result.hasMore ?? false,
    nextCursor: result.nextCursor ?? null,
  };
};

export const remove: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveSlackToken(input);
  const channelId = requireChannelId(input);
  const messageTs = requireMessageTs(input);

  await callSlackMethod(
    'chat.delete',
    token,
    compactJson({
      channel: channelId,
      ts: messageTs,
    }),
    input
  );

  return {
    ok: true,
    channelId,
    messageTs,
    deleted: true,
  };
};

export const react: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveSlackToken(input);
  const channelId = requireChannelId(input);
  const messageTs = requireMessageTs(input);
  const names = resolveReactionNames(input);

  for (const name of names) {
    await callSlackMethod(
      'reactions.add',
      token,
      compactJson({
        channel: channelId,
        timestamp: messageTs,
        name,
      }),
      input
    );
  }

  return {
    ok: true,
    channelId,
    messageTs,
    emojis: names,
    reactionCount: names.length,
  };
};

export const downloadFile: ToolHandler = async (ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveSlackToken(input);
  const url = resolveDownloadUrl(input);
  const includeBase64 = optionalBoolean(input, 'includeBase64', true) ?? true;
  const includeDataUrl = optionalBoolean(input, 'includeDataUrl', true) ?? true;
  const savePath = optionalSavePath(input);

  const result = await downloadSlackFile(input, token);
  const fileSize = result.buffer.byteLength;
  const base64 = includeBase64 ? result.buffer.toString('base64') : null;
  const dataUrl = includeDataUrl && includeBase64
    ? buildDataUrl(result.contentType, result.buffer)
    : null;

  let savedPath: string | null = null;
  if (savePath) {
    const targetPath = resolveFromWorkdir(ctx.workdir, savePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, result.buffer);
    savedPath = targetPath;
  }

  return {
    ok: true,
    url,
    contentType: result.contentType,
    contentLength: result.contentLength,
    sizeBytes: fileSize,
    etag: result.etag,
    contentDisposition: result.contentDisposition,
    savedPath,
    base64,
    dataUrl,
  };
};

export const handlers = {
  send,
  edit,
  read,
  delete: remove,
  react,
  downloadFile,
} satisfies Record<string, ToolHandler>;

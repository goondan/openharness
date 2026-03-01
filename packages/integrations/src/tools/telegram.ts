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

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const TELEGRAM_TOKEN_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'BOT_TOKEN',
  'TELEGRAM_TOKEN',
];

const TELEGRAM_CHAT_ACTION_ALIASES: Record<string, string> = {
  typing: 'typing',
  'upload-photo': 'upload_photo',
  'record-video': 'record_video',
  'upload-video': 'upload_video',
  'record-voice': 'record_voice',
  'upload-voice': 'upload_voice',
  'upload-document': 'upload_document',
  'choose-sticker': 'choose_sticker',
  'find-location': 'find_location',
  'record-video-note': 'record_video_note',
  'upload-video-note': 'upload_video_note',
};

const TELEGRAM_PARSE_MODE_ALIASES: Record<string, string> = {
  markdown: 'Markdown',
  markdownv2: 'MarkdownV2',
  'markdown-v2': 'MarkdownV2',
  html: 'HTML',
};

type TelegramMethod =
  | 'sendMessage'
  | 'editMessageText'
  | 'deleteMessage'
  | 'setMessageReaction'
  | 'sendChatAction'
  | 'getFile';

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  errorCode?: number;
}

interface TelegramResolvedFile {
  fileId: string;
  fileUniqueId: string | null;
  filePath: string;
  fileSize: number | null;
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.endsWith('/')) {
    return apiBaseUrl.slice(0, -1);
  }
  return apiBaseUrl;
}

function normalizeInputToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function buildTelegramApiUrl(apiBaseUrl: string, token: string, method: TelegramMethod): string {
  return `${normalizeApiBaseUrl(apiBaseUrl)}/bot${token}/${method}`;
}

function buildTelegramFileDownloadUrl(apiBaseUrl: string, token: string, filePath: string): string {
  return `${normalizeApiBaseUrl(apiBaseUrl)}/file/bot${token}/${filePath}`;
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

function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^[-]?\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }

  return parsed;
}

function requireChatId(input: JsonObject, key = 'chatId'): string {
  const raw = input[key];
  const asString = toNonEmptyString(raw);
  if (asString) {
    return asString;
  }

  const asInteger = toInteger(raw);
  if (asInteger !== undefined) {
    return String(asInteger);
  }

  throw new Error(`'${key}' must be a non-empty string or integer`);
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = toInteger(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function requireMessageId(input: JsonObject, key = 'messageId'): number {
  const messageId = readPositiveInteger(input[key]);
  if (messageId === undefined) {
    throw new Error(`'${key}' must be a positive integer`);
  }
  return messageId;
}

function optionalMessageId(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }

  const messageId = readPositiveInteger(value);
  if (messageId === undefined) {
    throw new Error(`'${key}' must be a positive integer`);
  }

  return messageId;
}

function resolveTelegramToken(input: JsonObject): string {
  const inputToken = optionalString(input, 'token');
  if (inputToken && inputToken.length > 0) {
    return inputToken;
  }

  for (const envKey of TELEGRAM_TOKEN_ENV_KEYS) {
    const envValue = process.env[envKey];
    if (typeof envValue === 'string' && envValue.length > 0) {
      return envValue;
    }
  }

  throw new Error(
    "Telegram bot token not found. Provide 'token' or set TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN."
  );
}

function resolveTimeoutMs(input: JsonObject): number {
  const timeoutMs = optionalNumber(input, 'timeoutMs', DEFAULT_REQUEST_TIMEOUT_MS) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("'timeoutMs' must be a positive number");
  }
  return Math.trunc(timeoutMs);
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

function resolveFileId(input: JsonObject): string {
  const fileId = toNonEmptyString(input.fileId) ?? toNonEmptyString(input.file_id);
  if (!fileId) {
    throw new Error("Provide 'fileId' (or 'file_id') for Telegram file download.");
  }
  return fileId;
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

function resolveApiBaseUrl(input: JsonObject): string {
  const apiBaseUrl = optionalString(input, 'apiBaseUrl');
  if (apiBaseUrl && apiBaseUrl.length > 0) {
    return apiBaseUrl;
  }
  return TELEGRAM_API_BASE_URL;
}

function resolveParseMode(input: JsonObject): string | undefined {
  const rawParseMode = optionalString(input, 'parseMode');
  if (!rawParseMode || rawParseMode.trim().length === 0) {
    return undefined;
  }

  const normalized = normalizeInputToken(rawParseMode);
  const parseMode = TELEGRAM_PARSE_MODE_ALIASES[normalized];
  if (!parseMode) {
    const allowed = Object.keys(TELEGRAM_PARSE_MODE_ALIASES).join(', ');
    throw new Error(`Unsupported parseMode '${rawParseMode}'. Use one of: ${allowed}.`);
  }

  return parseMode;
}

interface ReactionResolution {
  reactions: JsonObject[];
  cleared: boolean;
  emojis: string[];
}

function resolveReactions(input: JsonObject): ReactionResolution {
  const clear = optionalBoolean(input, 'clear', false) ?? false;
  if (clear) {
    return {
      reactions: [],
      cleared: true,
      emojis: [],
    };
  }

  const emojis: string[] = [];
  const singleEmoji = optionalString(input, 'emoji');
  if (singleEmoji && singleEmoji.trim().length > 0) {
    emojis.push(singleEmoji.trim());
  }

  const emojiArray = optionalStringArray(input, 'emojis') ?? [];
  for (const item of emojiArray) {
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      emojis.push(trimmed);
    }
  }

  if (emojis.length === 0) {
    throw new Error("Provide 'emoji' or 'emojis' to set message reaction, or set 'clear=true' to remove reactions.");
  }

  const uniqueEmojis = [...new Set(emojis)];
  const reactions = uniqueEmojis.map((emoji) => ({
    type: 'emoji',
    emoji,
  }));

  return {
    reactions,
    cleared: false,
    emojis: uniqueEmojis,
  };
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
      throw new Error(`Telegram API request timed out after ${timeoutMs}ms`);
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

async function parseTelegramApiResponse(response: Response): Promise<TelegramApiResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      description: defaultHttpDescription(response),
    };
  }

  if (!isJsonObject(body)) {
    return {
      ok: false,
      description: defaultHttpDescription(response),
    };
  }

  const description = toNonEmptyString(body.description);
  const errorCode = typeof body.error_code === 'number' && Number.isInteger(body.error_code)
    ? body.error_code
    : undefined;

  return {
    ok: body.ok === true,
    result: body.result,
    description,
    errorCode,
  };
}

async function callTelegramMethod(
  method: TelegramMethod,
  token: string,
  payload: JsonObject,
  input: JsonObject
): Promise<unknown> {
  const timeoutMs = resolveTimeoutMs(input);
  const apiBaseUrl = resolveApiBaseUrl(input);
  const url = buildTelegramApiUrl(apiBaseUrl, token, method);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
  } catch (error) {
    throw new Error(`[telegram] ${method} request failed: ${toErrorMessage(error)}`);
  }

  const parsed = await parseTelegramApiResponse(response);
  if (!response.ok || !parsed.ok) {
    const description = parsed.description ?? defaultHttpDescription(response);
    const codeSuffix = parsed.errorCode !== undefined ? ` (code ${parsed.errorCode})` : '';
    throw new Error(`[telegram] ${method} failed${codeSuffix}: ${description}`);
  }

  return parsed.result;
}

async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const parsedLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error(`Telegram file exceeds maxBytes limit (${parsedLength} > ${maxBytes})`);
    }
  }

  const raw = await response.arrayBuffer();
  const buffer = Buffer.from(raw);
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Telegram file exceeds maxBytes limit (${buffer.byteLength} > ${maxBytes})`);
  }
  return buffer;
}

function resolveResponseContentType(response: Response): string | null {
  const contentType = response.headers.get('content-type');
  if (!contentType || contentType.length === 0) {
    return null;
  }
  return contentType;
}

function buildDataUrl(contentType: string | null, buffer: Buffer): string | null {
  if (!contentType || buffer.byteLength === 0) {
    return null;
  }
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function parseTelegramGetFileResult(result: unknown): TelegramResolvedFile {
  if (!isJsonObject(result)) {
    throw new Error('[telegram] getFile returned invalid result payload');
  }

  const filePath = toNonEmptyString(result.file_path);
  const fileId = toNonEmptyString(result.file_id);
  if (!filePath || !fileId) {
    throw new Error('[telegram] getFile result missing file_id/file_path');
  }

  const fileSize = typeof result.file_size === 'number' && Number.isFinite(result.file_size)
    ? Math.trunc(result.file_size)
    : null;

  return {
    fileId,
    fileUniqueId: toNonEmptyString(result.file_unique_id) ?? null,
    filePath,
    fileSize,
  };
}

function extractMessageSummary(result: unknown): {
  messageId: number | null;
  date: number | null;
  text: string | null;
} {
  if (!isJsonObject(result)) {
    return {
      messageId: null,
      date: null,
      text: null,
    };
  }

  const messageId = readPositiveInteger(result.message_id) ?? null;
  const date = typeof result.date === 'number' && Number.isInteger(result.date) ? result.date : null;
  const text = toNonEmptyString(result.text) ?? null;

  return {
    messageId,
    date,
    text,
  };
}

function normalizeChatAction(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function resolveChatAction(input: JsonObject): string {
  const rawValue = optionalString(input, 'action') ?? optionalString(input, 'status') ?? 'typing';
  const normalized = normalizeChatAction(rawValue);

  const resolved = TELEGRAM_CHAT_ACTION_ALIASES[normalized];
  if (!resolved) {
    const allowed = Object.keys(TELEGRAM_CHAT_ACTION_ALIASES).join(', ');
    throw new Error(`Unsupported chat action '${rawValue}'. Use one of: ${allowed}.`);
  }

  return resolved;
}

export const send: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveTelegramToken(input);
  const chatId = requireChatId(input, 'chatId');
  const text = requireString(input, 'text');
  const parseMode = resolveParseMode(input);
  const disableNotification = optionalBoolean(input, 'disableNotification');
  const disableWebPagePreview = optionalBoolean(input, 'disableWebPagePreview');
  const replyToMessageId = optionalMessageId(input, 'replyToMessageId');
  const allowSendingWithoutReply = optionalBoolean(input, 'allowSendingWithoutReply');

  const result = await callTelegramMethod(
    'sendMessage',
    token,
    compactJson({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_notification: disableNotification,
      disable_web_page_preview: disableWebPagePreview,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: allowSendingWithoutReply,
    }),
    input
  );

  const summary = extractMessageSummary(result);
  return {
    ok: true,
    chatId,
    messageId: summary.messageId,
    date: summary.date,
    text: summary.text,
  };
};

export const edit: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveTelegramToken(input);
  const chatId = requireChatId(input, 'chatId');
  const messageId = requireMessageId(input, 'messageId');
  const text = requireString(input, 'text');
  const parseMode = resolveParseMode(input);
  const disableWebPagePreview = optionalBoolean(input, 'disableWebPagePreview');

  const result = await callTelegramMethod(
    'editMessageText',
    token,
    compactJson({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disableWebPagePreview,
    }),
    input
  );

  const summary = extractMessageSummary(result);
  return {
    ok: true,
    chatId,
    messageId: summary.messageId ?? messageId,
    edited: true,
  };
};

export const remove: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveTelegramToken(input);
  const chatId = requireChatId(input, 'chatId');
  const messageId = requireMessageId(input, 'messageId');

  await callTelegramMethod(
    'deleteMessage',
    token,
    compactJson({
      chat_id: chatId,
      message_id: messageId,
    }),
    input
  );

  return {
    ok: true,
    chatId,
    messageId,
    deleted: true,
  };
};

export const react: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const token = resolveTelegramToken(input);
  const chatId = requireChatId(input, 'chatId');
  const messageId = requireMessageId(input, 'messageId');
  const isBig = optionalBoolean(input, 'isBig');
  const reactionResolution = resolveReactions(input);

  await callTelegramMethod(
    'setMessageReaction',
    token,
    compactJson({
      chat_id: chatId,
      message_id: messageId,
      reaction: reactionResolution.reactions,
      is_big: isBig,
    }),
    input
  );

  return {
    ok: true,
    chatId,
    messageId,
    cleared: reactionResolution.cleared,
    emojis: reactionResolution.emojis,
    reactionCount: reactionResolution.reactions.length,
  };
};

export const setChatAction: ToolHandler = async (
  _ctx: ToolContext,
  input: JsonObject
): Promise<JsonValue> => {
  const token = resolveTelegramToken(input);
  const chatId = requireChatId(input, 'chatId');
  const action = resolveChatAction(input);

  await callTelegramMethod(
    'sendChatAction',
    token,
    compactJson({
      chat_id: chatId,
      action,
    }),
    input
  );

  return {
    ok: true,
    chatId,
    status: action,
    action,
  };
};

export const downloadFile: ToolHandler = async (
  ctx: ToolContext,
  input: JsonObject
): Promise<JsonValue> => {
  const token = resolveTelegramToken(input);
  const fileId = resolveFileId(input);
  const timeoutMs = resolveTimeoutMs(input);
  const maxBytes = resolveMaxBytes(input);
  const includeBase64 = optionalBoolean(input, 'includeBase64', true) ?? true;
  const includeDataUrl = optionalBoolean(input, 'includeDataUrl', true) ?? true;
  const savePath = optionalSavePath(input);
  const apiBaseUrl = resolveApiBaseUrl(input);

  const getFileResult = await callTelegramMethod(
    'getFile',
    token,
    {
      file_id: fileId,
    },
    input
  );
  const resolvedFile = parseTelegramGetFileResult(getFileResult);
  const downloadUrl = buildTelegramFileDownloadUrl(apiBaseUrl, token, resolvedFile.filePath);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      downloadUrl,
      {
        method: 'GET',
      },
      timeoutMs
    );
  } catch (error) {
    throw new Error(`[telegram] file download request failed: ${toErrorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`[telegram] file download failed: ${defaultHttpDescription(response)}`);
  }

  const buffer = await readResponseBuffer(response, maxBytes);
  const contentType = resolveResponseContentType(response);
  const base64 = includeBase64 ? buffer.toString('base64') : null;
  const dataUrl = includeDataUrl && includeBase64 ? buildDataUrl(contentType, buffer) : null;

  let savedPath: string | null = null;
  if (savePath) {
    const targetPath = resolveFromWorkdir(ctx.workdir, savePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, buffer);
    savedPath = targetPath;
  }

  return {
    ok: true,
    fileId: resolvedFile.fileId,
    fileUniqueId: resolvedFile.fileUniqueId,
    filePath: resolvedFile.filePath,
    fileSize: resolvedFile.fileSize,
    downloadUrl,
    contentType,
    sizeBytes: buffer.byteLength,
    savedPath,
    base64,
    dataUrl,
  };
};

export const handlers = {
  send,
  edit,
  delete: remove,
  react,
  setChatAction,
  downloadFile,
} satisfies Record<string, ToolHandler>;

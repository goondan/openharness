import type {
  ExtensionApi,
  InterAgentResponseMetadata,
  JsonObject,
  JsonValue,
  Message,
} from '../types.js';
import { isJsonObject } from '../utils.js';

const INTER_AGENT_RESPONSE_METADATA_KEY = '__goondanInterAgentResponse';
const INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY = '__goondanInterAgentResponseFormatted';
const EXTENSION_NAME = 'inter-agent-response-format';

export interface InterAgentResponseFormatExtensionConfig {
  includeRequestMetadata?: boolean;
}

function readStringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function readInterAgentResponseMetadata(message: Message): InterAgentResponseMetadata | null {
  if (message.data.role !== 'user') {
    return null;
  }

  const formatted = message.metadata[INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY];
  if (formatted === true) {
    return null;
  }

  const metadataValue = message.metadata[INTER_AGENT_RESPONSE_METADATA_KEY];
  if (!isJsonObject(metadataValue)) {
    return null;
  }

  const kind = readStringField(metadataValue, 'kind');
  const version = metadataValue.version;
  const requestId = readStringField(metadataValue, 'requestId');
  const requestEventId = readStringField(metadataValue, 'requestEventId');
  const fromAgentId = readStringField(metadataValue, 'fromAgentId');
  const toAgentId = readStringField(metadataValue, 'toAgentId');
  const asyncValue = metadataValue.async;
  const status = readStringField(metadataValue, 'status');
  const receivedAt = readStringField(metadataValue, 'receivedAt');

  if (
    kind !== 'inter_agent_response' ||
    version !== 1 ||
    !requestId ||
    !requestEventId ||
    !fromAgentId ||
    !toAgentId ||
    asyncValue !== true ||
    (status !== 'ok' && status !== 'error' && status !== 'timeout') ||
    !receivedAt
  ) {
    return null;
  }

  const metadata: InterAgentResponseMetadata = {
    kind,
    version,
    requestId,
    requestEventId,
    fromAgentId,
    toAgentId,
    async: true,
    status,
    receivedAt,
  };

  const responseEventId = readStringField(metadataValue, 'responseEventId');
  if (responseEventId) {
    metadata.responseEventId = responseEventId;
  }

  const traceId = readStringField(metadataValue, 'traceId');
  if (traceId) {
    metadata.traceId = traceId;
  }

  const requestEventType = readStringField(metadataValue, 'requestEventType');
  if (requestEventType) {
    metadata.requestEventType = requestEventType;
  }

  const requestMetadata = metadataValue.requestMetadata;
  if (isJsonObject(requestMetadata)) {
    metadata.requestMetadata = requestMetadata;
  }

  const errorCode = readStringField(metadataValue, 'errorCode');
  if (errorCode) {
    metadata.errorCode = errorCode;
  }

  const errorMessage = readStringField(metadataValue, 'errorMessage');
  if (errorMessage) {
    metadata.errorMessage = errorMessage;
  }

  return metadata;
}

function readResponsePayload(message: Message): JsonValue | undefined {
  const content = message.data.content;
  if (!isJsonObject(content)) {
    return undefined;
  }

  if (!Object.hasOwn(content, 'response')) {
    return undefined;
  }

  return content.response;
}

function readErrorFromContent(message: Message): { code?: string; message?: string } {
  const content = message.data.content;
  if (!isJsonObject(content)) {
    return {};
  }

  const rawError = content.error;
  if (!isJsonObject(rawError)) {
    return {};
  }

  const code = readStringField(rawError, 'code');
  const messageText = readStringField(rawError, 'message');
  return {
    code,
    message: messageText,
  };
}

function stringifyValue(value: JsonValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildSummaryLine(metadata: InterAgentResponseMetadata): string {
  return [
    `[inter-agent response]`,
    `${metadata.fromAgentId} -> ${metadata.toAgentId}`,
    `status=${metadata.status}`,
    `requestId=${metadata.requestId}`,
  ].join(' ');
}

function formatInterAgentResponseText(
  message: Message,
  metadata: InterAgentResponseMetadata,
  config: InterAgentResponseFormatExtensionConfig,
): string {
  const lines: string[] = [buildSummaryLine(metadata)];

  if (metadata.status === 'ok') {
    const payload = stringifyValue(readResponsePayload(message));
    if (payload.length > 0) {
      lines.push(payload);
    }
  } else {
    const contentError = readErrorFromContent(message);
    const errorCode = metadata.errorCode ?? contentError.code ?? 'AGENT_REQUEST_ERROR';
    const errorMessage = metadata.errorMessage ?? contentError.message ?? 'agent request failed';
    lines.push(`error(${errorCode}): ${errorMessage}`);
  }

  if (config.includeRequestMetadata === true && metadata.requestMetadata) {
    lines.push(`requestMetadata=${stringifyValue(metadata.requestMetadata)}`);
  }

  return lines.join('\n');
}

function createFormattedMessage(
  message: Message,
  text: string,
  rawMetadata: JsonValue,
): Message {
  const nextMetadata: Record<string, JsonValue> = {
    ...message.metadata,
    [INTER_AGENT_RESPONSE_METADATA_KEY]: rawMetadata,
    [INTER_AGENT_RESPONSE_FORMATTED_METADATA_KEY]: true,
  };

  return {
    id: message.id,
    data: {
      role: 'user',
      content: text,
    },
    metadata: nextMetadata,
    createdAt: message.createdAt,
    source: {
      type: 'extension',
      extensionName: EXTENSION_NAME,
    },
  };
}

export function registerInterAgentResponseFormatExtension(
  api: ExtensionApi,
  config: InterAgentResponseFormatExtensionConfig = {},
): void {
  api.pipeline.register('step', async (ctx) => {
    for (const message of ctx.conversationState.nextMessages) {
      const metadata = readInterAgentResponseMetadata(message);
      if (!metadata) {
        continue;
      }
      const rawMetadata = message.metadata[INTER_AGENT_RESPONSE_METADATA_KEY];
      if (rawMetadata === undefined) {
        continue;
      }

      const text = formatInterAgentResponseText(message, metadata, config);
      ctx.emitMessageEvent({
        type: 'replace',
        targetId: message.id,
        message: createFormattedMessage(message, text, rawMetadata),
      });
    }

    return ctx.next();
  });
}

export function register(api: ExtensionApi, config?: InterAgentResponseFormatExtensionConfig): void {
  registerInterAgentResponseFormatExtension(api, config);
}

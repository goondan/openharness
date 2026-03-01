import type { JsonObject, ResourceManifest, ToolManifestSpec } from "../types.js";

export type IntegrationToolManifest = ResourceManifest<"Tool", ToolManifestSpec>;

function createToolManifest(name: string, spec: ToolManifestSpec): IntegrationToolManifest {
  return {
    apiVersion: "goondan.ai/v1",
    kind: "Tool",
    metadata: {
      name,
      labels: {
        tier: "integrations",
      },
    },
    spec,
  };
}

function createProperty(type: string | string[], description: string, extra: JsonObject = {}): JsonObject {
  return {
    type: Array.isArray(type) ? [...type] : type,
    description,
    ...extra,
  };
}

function stringProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty("string", description, extra);
}

function numberProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty("number", description, extra);
}

function booleanProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty("boolean", description, extra);
}

function arrayProperty(description: string, items?: JsonObject, extra: JsonObject = {}): JsonObject {
  const payload: JsonObject = { ...extra };
  if (items) {
    payload.items = items;
  }
  return createProperty("array", description, payload);
}

function createParameters(properties: Record<string, JsonObject>, required: string[] = []): JsonObject {
  const parameters: JsonObject = {
    type: "object",
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    parameters.required = [...required];
  }

  return parameters;
}

export function createIntegrationToolManifests(): IntegrationToolManifest[] {
  return [
    createToolManifest('telegram', {
      entry: './src/tools/telegram.ts',
      exports: [
        {
          name: 'send',
          description: 'Send a Telegram text message to a chat.',
          parameters: createParameters(
            {
              token: stringProperty(
                'Bot token. Optional when TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN is set.'
              ),
              chatId: createProperty(
                ['string', 'number'],
                'Target chat id. Accepts Telegram chat id as string or integer.'
              ),
              text: stringProperty('Message text content to send.'),
              parseMode: stringProperty(
                'Optional parse mode alias.',
                {
                  enum: ['Markdown', 'MarkdownV2', 'HTML', 'markdown', 'markdownv2', 'markdown-v2', 'html'],
                }
              ),
              disableNotification: booleanProperty('Disable Telegram push notification for this message.'),
              disableWebPagePreview: booleanProperty('Disable link preview generation for message links.'),
              replyToMessageId: createProperty(
                ['number', 'string'],
                'Reply to an existing message id in the same chat.'
              ),
              allowSendingWithoutReply: booleanProperty('Send even when reply target message no longer exists.'),
              timeoutMs: numberProperty('Telegram API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Telegram API base URL override.'),
            },
            ['chatId', 'text']
          ),
        },
        {
          name: 'edit',
          description: 'Edit text of an existing Telegram message.',
          parameters: createParameters(
            {
              token: stringProperty(
                'Bot token. Optional when TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN is set.'
              ),
              chatId: createProperty(
                ['string', 'number'],
                'Target chat id. Accepts Telegram chat id as string or integer.'
              ),
              messageId: createProperty(['number', 'string'], 'Message id to edit (positive integer).'),
              text: stringProperty('New message text content.'),
              parseMode: stringProperty(
                'Optional parse mode alias.',
                {
                  enum: ['Markdown', 'MarkdownV2', 'HTML', 'markdown', 'markdownv2', 'markdown-v2', 'html'],
                }
              ),
              disableWebPagePreview: booleanProperty('Disable link preview generation for message links.'),
              timeoutMs: numberProperty('Telegram API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Telegram API base URL override.'),
            },
            ['chatId', 'messageId', 'text']
          ),
        },
        {
          name: 'delete',
          description: 'Delete Telegram message from a chat',
          parameters: createParameters(
            {
              token: stringProperty(
                'Bot token. Optional when TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN is set.'
              ),
              chatId: createProperty(
                ['string', 'number'],
                'Target chat id. Accepts Telegram chat id as string or integer.'
              ),
              messageId: createProperty(['number', 'string'], 'Message id to delete (positive integer).'),
              timeoutMs: numberProperty('Telegram API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Telegram API base URL override.'),
            },
            ['chatId', 'messageId']
          ),
        },
        {
          name: 'react',
          description: 'Add, replace, or clear Telegram message reactions.',
          parameters: createParameters(
            {
              token: stringProperty(
                'Bot token. Optional when TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN is set.'
              ),
              chatId: createProperty(
                ['string', 'number'],
                'Target chat id. Accepts Telegram chat id as string or integer.'
              ),
              messageId: createProperty(['number', 'string'], 'Message id to react to (positive integer).'),
              emoji: stringProperty('Single emoji reaction to set (ignored when clear=true).'),
              emojis: arrayProperty(
                'Multiple emoji reactions to set (ignored when clear=true).',
                stringProperty('Single emoji reaction value.')
              ),
              clear: booleanProperty('When true, clear reactions instead of setting them.'),
              isBig: booleanProperty('Use big reaction animation if supported by Telegram clients.'),
              timeoutMs: numberProperty('Telegram API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Telegram API base URL override.'),
            },
            ['chatId', 'messageId']
          ),
        },
        {
          name: 'setChatAction',
          description: 'Set Telegram bot chat action (typing/upload...)',
          parameters: createParameters(
            {
              token: stringProperty(
                'Bot token. Optional when TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN is set.'
              ),
              chatId: createProperty(
                ['string', 'number'],
                'Target chat id. Accepts Telegram chat id as string or integer.'
              ),
              action: stringProperty(
                'Chat action to set.',
                {
                  enum: [
                    'typing',
                    'upload-photo',
                    'record-video',
                    'upload-video',
                    'record-voice',
                    'upload-voice',
                    'upload-document',
                    'choose-sticker',
                    'find-location',
                    'record-video-note',
                    'upload-video-note',
                  ],
                }
              ),
              timeoutMs: numberProperty('Telegram API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Telegram API base URL override.'),
            },
            ['chatId']
          ),
        },
        {
          name: 'downloadFile',
          description: 'Resolve and download a Telegram file by file id.',
          parameters: createParameters(
            {
              token: stringProperty(
                'Bot token. Optional when TELEGRAM_BOT_TOKEN/BOT_TOKEN/TELEGRAM_TOKEN is set.'
              ),
              fileId: stringProperty('Telegram file id to download (preferred field).'),
              maxBytes: numberProperty('Maximum downloaded bytes allowed (default: 3000000).'),
              includeBase64: booleanProperty('Include base64-encoded content in the result (default: true).'),
              includeDataUrl: booleanProperty('Include data URL when base64 is included (default: true).'),
              savePath: stringProperty('Optional path relative to workdir to save the downloaded file.'),
              timeoutMs: numberProperty('Telegram API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Telegram API base URL override.'),
            },
            ['fileId']
          ),
        },
      ],
    }),
    createToolManifest('slack', {
      entry: './src/tools/slack.ts',
      exports: [
        {
          name: 'send',
          description: 'Send Slack message to a channel',
          parameters: createParameters(
            {
              token: stringProperty('Slack bot token. Optional when SLACK_BOT_TOKEN/SLACK_TOKEN is set.'),
              channelId: stringProperty('Target channel id to post message.'),
              text: stringProperty('Message text content to post.'),
              threadTs: stringProperty('Optional parent thread timestamp for thread replies.'),
              mrkdwn: booleanProperty('Enable Slack mrkdwn parsing for message text.'),
              unfurlLinks: booleanProperty('Enable automatic link unfurling.'),
              unfurlMedia: booleanProperty('Enable automatic media unfurling.'),
              replyBroadcast: booleanProperty('Broadcast thread reply to channel timeline.'),
              timeoutMs: numberProperty('Slack API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Slack API base URL override.'),
            },
            ['channelId', 'text']
          ),
        },
        {
          name: 'read',
          description: 'Read Slack channel or thread messages',
          parameters: createParameters(
            {
              token: stringProperty('Slack bot token. Optional when SLACK_BOT_TOKEN/SLACK_TOKEN is set.'),
              channelId: stringProperty('Target channel id to read from.'),
              messageTs: stringProperty('Specific message timestamp to find in history.'),
              threadTs: stringProperty('Thread root timestamp. When set, reads thread replies.'),
              latest: stringProperty('Upper time boundary (inclusive/exclusive depends on inclusive flag).'),
              oldest: stringProperty('Lower time boundary (inclusive/exclusive depends on inclusive flag).'),
              inclusive: booleanProperty('Include boundary messages when latest/oldest are set.'),
              limit: numberProperty('Maximum messages to return (1 to 1000).'),
              cursor: stringProperty('Pagination cursor for next page.'),
              timeoutMs: numberProperty('Slack API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Slack API base URL override.'),
            },
            ['channelId']
          ),
        },
        {
          name: 'edit',
          description: 'Edit Slack message text',
          parameters: createParameters(
            {
              token: stringProperty('Slack bot token. Optional when SLACK_BOT_TOKEN/SLACK_TOKEN is set.'),
              channelId: stringProperty('Target channel id containing the message.'),
              messageTs: stringProperty('Timestamp of the message to edit.'),
              text: stringProperty('New message text content.'),
              mrkdwn: booleanProperty('Enable Slack mrkdwn parsing for updated text.'),
              timeoutMs: numberProperty('Slack API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Slack API base URL override.'),
            },
            ['channelId', 'messageTs', 'text']
          ),
        },
        {
          name: 'delete',
          description: 'Delete Slack message from a channel',
          parameters: createParameters(
            {
              token: stringProperty('Slack bot token. Optional when SLACK_BOT_TOKEN/SLACK_TOKEN is set.'),
              channelId: stringProperty('Target channel id containing the message.'),
              messageTs: stringProperty('Timestamp of the message to delete.'),
              timeoutMs: numberProperty('Slack API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Slack API base URL override.'),
            },
            ['channelId', 'messageTs']
          ),
        },
        {
          name: 'react',
          description: 'Add one or more Slack reactions to a message',
          parameters: createParameters(
            {
              token: stringProperty('Slack bot token. Optional when SLACK_BOT_TOKEN/SLACK_TOKEN is set.'),
              channelId: stringProperty('Target channel id containing the message.'),
              messageTs: stringProperty('Timestamp of the message to react to.'),
              emoji: stringProperty('Single emoji name to add, with or without surrounding colons.'),
              emojis: arrayProperty(
                'Multiple emoji names to add, each with or without surrounding colons.',
                stringProperty('Single emoji name value.')
              ),
              timeoutMs: numberProperty('Slack API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Slack API base URL override.'),
            },
            ['channelId', 'messageTs']
          ),
        },
        {
          name: 'downloadFile',
          description: 'Download Slack file/image with bot token auth',
          parameters: createParameters(
            {
              token: stringProperty('Slack bot token. Optional when SLACK_BOT_TOKEN/SLACK_TOKEN is set.'),
              url: stringProperty('Download URL to fetch (preferred field).'),
              maxBytes: numberProperty('Maximum downloaded bytes allowed (default: 3000000).'),
              includeBase64: booleanProperty('Include base64-encoded content in the result (default: true).'),
              includeDataUrl: booleanProperty('Include data URL when base64 is included (default: true).'),
              savePath: stringProperty('Optional path relative to workdir to save the downloaded file.'),
              timeoutMs: numberProperty('Slack API timeout in milliseconds (default: 15000).'),
              apiBaseUrl: stringProperty('Optional Slack API base URL override.'),
            },
            ['url']
          ),
        },
      ],
    }),
  ];
}

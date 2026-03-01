import { afterEach, describe, expect, it } from 'vitest';
import { telegramHandlers } from '../src/tools/index.js';
import type { JsonObject, JsonValue } from '../src/types.js';
import { isJsonObject } from '../src/utils.js';
import { createTempWorkspace, createToolContext } from './helpers.js';

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  input: string;
  init: RequestInit | undefined;
}

function assertJsonObject(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected JSON object output');
  }
  return value;
}

function createJsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function createBinaryResponse(
  status: number,
  body: string,
  contentType: string
): Response {
  return new Response(Buffer.from(body, 'utf8'), {
    status,
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
  });
}

function createFetchMock(
  handler: (request: CapturedRequest) => Promise<Response> | Response
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    return await handler({
      input: url,
      init,
    });
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('telegram tool', () => {
  it('telegram__send posts sendMessage and returns message metadata', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: {
          message_id: 17,
          date: 1_735_200_000,
          text: 'hello telegram',
        },
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.send(ctx, {
        token: 'token-1',
        chatId: '42',
        text: 'hello telegram',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.chatId).toBe('42');
      expect(result.messageId).toBe(17);
      expect(result.text).toBe('hello telegram');

      const request = captured;
      if (!request) {
        throw new Error('Expected sendMessage request');
      }

      expect(request.input).toContain('/bottoken-1/sendMessage');
      expect(request.init?.method).toBe('POST');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '42',
        text: 'hello telegram',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__send supports parseMode alias', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: {
          message_id: 18,
          text: 'Hello',
        },
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      await telegramHandlers.send(ctx, {
        token: 'token-1b',
        chatId: '42',
        text: 'Hello',
        parseMode: 'markdownv2',
      });

      const request = captured;
      if (!request) {
        throw new Error('Expected sendMessage request');
      }

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '42',
        text: 'Hello',
        parse_mode: 'MarkdownV2',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__edit posts editMessageText', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: {
          message_id: 23,
          text: 'edited',
        },
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.edit(ctx, {
        token: 'token-2',
        chatId: '42',
        messageId: 23,
        text: 'edited',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.edited).toBe(true);
      expect(result.messageId).toBe(23);

      const request = captured;
      if (!request) {
        throw new Error('Expected editMessageText request');
      }

      expect(request.input).toContain('/bottoken-2/editMessageText');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '42',
        message_id: 23,
        text: 'edited',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__react posts setMessageReaction with emoji', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.react(ctx, {
        token: 'token-2b',
        chatId: '42',
        messageId: 24,
        emoji: '🔥',
        isBig: true,
      });
      const result = assertJsonObject(output);
      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(false);
      expect(result.reactionCount).toBe(1);

      const request = captured;
      if (!request) {
        throw new Error('Expected setMessageReaction request');
      }

      expect(request.input).toContain('/bottoken-2b/setMessageReaction');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '42',
        message_id: 24,
        reaction: [
          {
            type: 'emoji',
            emoji: '🔥',
          },
        ],
        is_big: true,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__react supports clear mode', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.react(ctx, {
        token: 'token-2c',
        chatId: '42',
        messageId: 25,
        clear: true,
      });
      const result = assertJsonObject(output);
      expect(result.ok).toBe(true);
      expect(result.cleared).toBe(true);
      expect(result.reactionCount).toBe(0);

      const request = captured;
      if (!request) {
        throw new Error('Expected setMessageReaction request');
      }

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '42',
        message_id: 25,
        reaction: [],
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__delete posts deleteMessage', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.delete(ctx, {
        token: 'token-3',
        chatId: '-100123',
        messageId: 55,
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(true);
      expect(result.messageId).toBe(55);

      const request = captured;
      if (!request) {
        throw new Error('Expected deleteMessage request');
      }

      expect(request.input).toContain('/bottoken-3/deleteMessage');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '-100123',
        message_id: 55,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__setChatAction sends typing action', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.setChatAction(ctx, {
        token: 'token-4',
        chatId: '42',
        status: 'typing',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.status).toBe('typing');
      expect(result.action).toBe('typing');

      const request = captured;
      if (!request) {
        throw new Error('Expected sendChatAction request');
      }

      expect(request.input).toContain('/bottoken-4/sendChatAction');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        chat_id: '42',
        action: 'typing',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__setChatAction rejects unsupported status', async () => {
    globalThis.fetch = createFetchMock(() => {
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      await expect(
        telegramHandlers.setChatAction(ctx, {
          token: 'token-5',
          chatId: '42',
          status: 'non-typing',
        })
      ).rejects.toThrow("Unsupported chat action 'non-typing'");
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__downloadFile resolves file path and downloads bytes', async () => {
    const requests: CapturedRequest[] = [];
    globalThis.fetch = createFetchMock((request) => {
      requests.push(request);

      if (request.input.endsWith('/getFile')) {
        return createJsonResponse(200, {
          ok: true,
          result: {
            file_id: 'photo-file-id',
            file_unique_id: 'unique-photo',
            file_path: 'photos/file_123.jpg',
            file_size: 2048,
          },
        });
      }

      return createBinaryResponse(200, 'telegram-image-bytes', 'image/jpeg');
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await telegramHandlers.downloadFile(ctx, {
        token: 'token-download-1',
        fileId: 'photo-file-id',
        includeBase64: false,
        includeDataUrl: false,
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.fileId).toBe('photo-file-id');
      expect(result.filePath).toBe('photos/file_123.jpg');
      expect(result.contentType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(Buffer.byteLength('telegram-image-bytes', 'utf8'));
      expect(result.base64).toBeNull();
      expect(result.dataUrl).toBeNull();

      const firstRequest = requests[0];
      const secondRequest = requests[1];
      if (!firstRequest || !secondRequest) {
        throw new Error('Expected getFile + file download requests');
      }

      expect(firstRequest.input).toContain('/bottoken-download-1/getFile');
      expect(secondRequest.input).toBe('https://api.telegram.org/file/bottoken-download-1/photos/file_123.jpg');

      const firstBody = firstRequest.init?.body;
      if (typeof firstBody !== 'string') {
        throw new Error('Expected getFile JSON body');
      }
      expect(JSON.parse(firstBody)).toEqual({
        file_id: 'photo-file-id',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__send rejects unsupported parseMode', async () => {
    globalThis.fetch = createFetchMock(() => {
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      await expect(
        telegramHandlers.send(ctx, {
          token: 'token-6',
          chatId: '42',
          text: 'hello',
          parseMode: 'md',
        })
      ).rejects.toThrow("Unsupported parseMode 'md'");
    } finally {
      await workspace.cleanup();
    }
  });

  it('telegram__react requires emoji input unless clear=true', async () => {
    globalThis.fetch = createFetchMock(() => {
      return createJsonResponse(200, {
        ok: true,
        result: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      await expect(
        telegramHandlers.react(ctx, {
          token: 'token-7',
          chatId: '42',
          messageId: 26,
        })
      ).rejects.toThrow("Provide 'emoji' or 'emojis'");
    } finally {
      await workspace.cleanup();
    }
  });
});

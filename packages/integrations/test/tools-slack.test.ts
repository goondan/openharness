import { afterEach, describe, expect, it } from 'vitest';
import { slackHandlers } from '../src/tools/index.js';
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

describe('slack tool', () => {
  it('slack__send posts chat.postMessage and returns message metadata', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        channel: 'C123',
        ts: '1735200000.001000',
        message: {
          text: 'hello slack',
        },
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.send(ctx, {
        token: 'xoxb-send-1',
        channelId: 'C123',
        text: 'hello slack',
        threadTs: '1735200000.000999',
        mrkdwn: true,
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.channelId).toBe('C123');
      expect(result.messageTs).toBe('1735200000.001000');
      expect(result.text).toBe('hello slack');

      const request = captured;
      if (!request) {
        throw new Error('Expected chat.postMessage request');
      }

      expect(request.input).toContain('/chat.postMessage');

      const headers = new Headers(request.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer xoxb-send-1');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        channel: 'C123',
        text: 'hello slack',
        thread_ts: '1735200000.000999',
        mrkdwn: true,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__edit posts chat.update', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        channel: 'C123',
        ts: '1735200000.002000',
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.edit(ctx, {
        token: 'xoxb-edit-1',
        channelId: 'C123',
        messageTs: '1735200000.001000',
        text: 'edited',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.edited).toBe(true);
      expect(result.messageTs).toBe('1735200000.002000');

      const request = captured;
      if (!request) {
        throw new Error('Expected chat.update request');
      }

      expect(request.input).toContain('/chat.update');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        channel: 'C123',
        ts: '1735200000.001000',
        text: 'edited',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__delete posts chat.delete', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.delete(ctx, {
        token: 'xoxb-delete-1',
        channelId: 'C123',
        messageTs: '1735200000.003000',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(true);
      expect(result.messageTs).toBe('1735200000.003000');

      const request = captured;
      if (!request) {
        throw new Error('Expected chat.delete request');
      }

      expect(request.input).toContain('/chat.delete');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        channel: 'C123',
        ts: '1735200000.003000',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__read posts conversations.history and can find message by ts', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        messages: [
          {
            type: 'message',
            ts: '1735200000.010000',
            text: 'lookup target',
          },
        ],
        has_more: false,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.read(ctx, {
        token: 'xoxb-read-1',
        channelId: 'C123',
        messageTs: '1735200000.010000',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.method).toBe('conversations.history');
      expect(result.count).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(isJsonObject(result.found)).toBe(true);

      const request = captured;
      if (!request) {
        throw new Error('Expected conversations.history request');
      }

      expect(request.input).toContain('/conversations.history');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        channel: 'C123',
        latest: '1735200000.010000',
        inclusive: true,
        limit: 1,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__read can use conversations.replies for thread lookup', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createJsonResponse(200, {
        ok: true,
        messages: [
          {
            type: 'message',
            ts: '1735200000.020001',
            thread_ts: '1735200000.020000',
            text: 'thread reply',
          },
        ],
        has_more: true,
        response_metadata: {
          next_cursor: 'cursor-2',
        },
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.read(ctx, {
        token: 'xoxb-read-2',
        channelId: 'C123',
        threadTs: '1735200000.020000',
        limit: 5,
        cursor: 'cursor-1',
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.method).toBe('conversations.replies');
      expect(result.count).toBe(1);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('cursor-2');

      const request = captured;
      if (!request) {
        throw new Error('Expected conversations.replies request');
      }

      expect(request.input).toContain('/conversations.replies');

      const requestBody = request.init?.body;
      if (typeof requestBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(requestBody)).toEqual({
        channel: 'C123',
        ts: '1735200000.020000',
        limit: 5,
        cursor: 'cursor-1',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__react posts reactions.add for each unique emoji', async () => {
    const requests: CapturedRequest[] = [];
    globalThis.fetch = createFetchMock((request) => {
      requests.push(request);
      return createJsonResponse(200, {
        ok: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.react(ctx, {
        token: 'xoxb-react-1',
        channelId: 'C123',
        messageTs: '1735200000.004000',
        emoji: ':rocket:',
        emojis: ['thumbsup', ':rocket:'],
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.reactionCount).toBe(2);
      expect(result.emojis).toEqual(['rocket', 'thumbsup']);

      expect(requests.length).toBe(2);
      expect(requests[0]?.input).toContain('/reactions.add');
      expect(requests[1]?.input).toContain('/reactions.add');

      const firstBody = requests[0]?.init?.body;
      const secondBody = requests[1]?.init?.body;
      if (typeof firstBody !== 'string' || typeof secondBody !== 'string') {
        throw new Error('Expected JSON body');
      }

      expect(JSON.parse(firstBody)).toEqual({
        channel: 'C123',
        timestamp: '1735200000.004000',
        name: 'rocket',
      });
      expect(JSON.parse(secondBody)).toEqual({
        channel: 'C123',
        timestamp: '1735200000.004000',
        name: 'thumbsup',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__react requires emoji input', async () => {
    globalThis.fetch = createFetchMock(() => {
      return createJsonResponse(200, {
        ok: true,
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      await expect(
        slackHandlers.react(ctx, {
          token: 'xoxb-react-2',
          channelId: 'C123',
          messageTs: '1735200000.005000',
        })
      ).rejects.toThrow("Provide 'emoji' or 'emojis'");
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__downloadFile downloads private file with token auth', async () => {
    let captured: CapturedRequest | undefined;
    globalThis.fetch = createFetchMock((request) => {
      captured = request;
      return createBinaryResponse(200, 'fake-image-bytes', 'image/png');
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await slackHandlers.downloadFile(ctx, {
        token: 'xoxb-download-1',
        url: 'https://files.slack.com/files-pri/T123-F123/image.png',
        includeBase64: false,
        includeDataUrl: false,
      });
      const result = assertJsonObject(output);

      expect(result.ok).toBe(true);
      expect(result.contentType).toBe('image/png');
      expect(result.sizeBytes).toBe(Buffer.byteLength('fake-image-bytes', 'utf8'));
      expect(result.base64).toBeNull();
      expect(result.dataUrl).toBeNull();

      const request = captured;
      if (!request) {
        throw new Error('Expected file download request');
      }

      expect(request.input).toBe('https://files.slack.com/files-pri/T123-F123/image.png');
      expect(request.init?.method).toBe('GET');
      const headers = new Headers(request.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer xoxb-download-1');
    } finally {
      await workspace.cleanup();
    }
  });

  it('slack__send surfaces Slack API errors', async () => {
    globalThis.fetch = createFetchMock(() => {
      return createJsonResponse(200, {
        ok: false,
        error: 'channel_not_found',
      });
    });

    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      await expect(
        slackHandlers.send(ctx, {
          token: 'xoxb-send-2',
          channelId: 'C404',
          text: 'hello',
        })
      ).rejects.toThrow('[slack] chat.postMessage failed: channel_not_found');
    } finally {
      await workspace.cleanup();
    }
  });
});

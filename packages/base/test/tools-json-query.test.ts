import { describe, expect, it } from 'vitest';
import { jsonQueryHandlers } from '../src/tools/index.js';
import type { JsonObject, JsonValue } from '../src/types.js';
import { isJsonObject } from '../src/utils.js';
import { createTempWorkspace, createToolContext } from './helpers.js';

function assertJsonObject(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected JSON object output');
  }
  return value;
}

describe('json-query tool', () => {
  it('query resolves nested path', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const data = JSON.stringify({ a: { b: { c: 42 } } });
      const output = await jsonQueryHandlers.query(ctx, { data, path: 'a.b.c' });
      const result = assertJsonObject(output);
      expect(result.found).toBe(true);
      expect(result.value).toBe(42);
    } finally {
      await workspace.cleanup();
    }
  });

  it('query handles array index', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const data = JSON.stringify({ items: ['a', 'b', 'c'] });
      const output = await jsonQueryHandlers.query(ctx, { data, path: 'items[1]' });
      const result = assertJsonObject(output);
      expect(result.found).toBe(true);
      expect(result.value).toBe('b');
    } finally {
      await workspace.cleanup();
    }
  });

  it('query returns not found for missing path', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const data = JSON.stringify({ a: 1 });
      const output = await jsonQueryHandlers.query(ctx, { data, path: 'b.c' });
      const result = assertJsonObject(output);
      expect(result.found).toBe(false);
    } finally {
      await workspace.cleanup();
    }
  });

  it('pick extracts specified keys', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const data = JSON.stringify({ a: 1, b: 2, c: 3 });
      const output = await jsonQueryHandlers.pick(ctx, { data, keys: ['a', 'c'] });
      const result = assertJsonObject(output);
      const picked = result.result;
      if (!isJsonObject(picked)) {
        throw new Error('Expected picked to be an object');
      }
      expect(picked.a).toBe(1);
      expect(picked.c).toBe(3);
      expect(picked.b).toBeUndefined();
    } finally {
      await workspace.cleanup();
    }
  });

  it('count returns array length', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const data = JSON.stringify({ items: [1, 2, 3, 4, 5] });
      const output = await jsonQueryHandlers.count(ctx, { data, path: 'items' });
      const result = assertJsonObject(output);
      expect(result.count).toBe(5);
      expect(result.type).toBe('array');
    } finally {
      await workspace.cleanup();
    }
  });

  it('flatten flattens nested arrays', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const data = JSON.stringify([[1, 2], [3, [4, 5]]]);
      const output = await jsonQueryHandlers.flatten(ctx, { data, depth: 1 });
      const result = assertJsonObject(output);
      expect(result.count).toBe(4);
      expect(result.result).toEqual([1, 2, 3, [4, 5]]);
    } finally {
      await workspace.cleanup();
    }
  });
});

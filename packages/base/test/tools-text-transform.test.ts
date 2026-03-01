import { describe, expect, it } from 'vitest';
import { textTransformHandlers } from '../src/tools/index.js';
import type { JsonObject, JsonValue } from '../src/types.js';
import { isJsonObject } from '../src/utils.js';
import { createTempWorkspace, createToolContext } from './helpers.js';

function assertJsonObject(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error('Expected JSON object output');
  }
  return value;
}

describe('text-transform tool', () => {
  it('replace substitutes first occurrence', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await textTransformHandlers.replace(ctx, {
        text: 'hello world hello',
        search: 'hello',
        replacement: 'hi',
      });
      const result = assertJsonObject(output);
      expect(result.result).toBe('hi world hello');
    } finally {
      await workspace.cleanup();
    }
  });

  it('replace all occurrences', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await textTransformHandlers.replace(ctx, {
        text: 'aaa',
        search: 'a',
        replacement: 'b',
        all: true,
      });
      const result = assertJsonObject(output);
      expect(result.result).toBe('bbb');
      expect(result.replacements).toBe(3);
    } finally {
      await workspace.cleanup();
    }
  });

  it('slice extracts substring', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await textTransformHandlers.slice(ctx, {
        text: 'hello world',
        start: 6,
        end: 11,
      });
      const result = assertJsonObject(output);
      expect(result.result).toBe('world');
    } finally {
      await workspace.cleanup();
    }
  });

  it('split divides text by delimiter', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await textTransformHandlers.split(ctx, {
        text: 'a,b,c',
        delimiter: ',',
      });
      const result = assertJsonObject(output);
      expect(result.parts).toEqual(['a', 'b', 'c']);
      expect(result.count).toBe(3);
    } finally {
      await workspace.cleanup();
    }
  });

  it('join concatenates parts', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await textTransformHandlers.join(ctx, {
        parts: ['x', 'y', 'z'],
        delimiter: '-',
      });
      const result = assertJsonObject(output);
      expect(result.result).toBe('x-y-z');
    } finally {
      await workspace.cleanup();
    }
  });

  it('trim removes whitespace', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const output = await textTransformHandlers.trim(ctx, {
        text: '  hello  ',
      });
      const result = assertJsonObject(output);
      expect(result.result).toBe('hello');
    } finally {
      await workspace.cleanup();
    }
  });

  it('case transforms to upper/lower', async () => {
    const workspace = await createTempWorkspace();
    try {
      const ctx = createToolContext(workspace.path);
      const upper = await textTransformHandlers.case(ctx, {
        text: 'hello',
        to: 'upper',
      });
      const lower = await textTransformHandlers.case(ctx, {
        text: 'HELLO',
        to: 'lower',
      });

      expect(assertJsonObject(upper).result).toBe('HELLO');
      expect(assertJsonObject(lower).result).toBe('hello');
    } finally {
      await workspace.cleanup();
    }
  });
});

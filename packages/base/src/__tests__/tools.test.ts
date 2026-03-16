import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BashTool } from "../tools/bash.js";
import { FileReadTool, FileWriteTool, FileListTool } from "../tools/file-system.js";
import { HttpFetchTool } from "../tools/http-fetch.js";
import { JsonQueryTool } from "../tools/json-query.js";
import { TextTransformTool } from "../tools/text-transform.js";
import { WaitTool } from "../tools/wait.js";
import type { ToolContext } from "@goondan/openharness-types";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(abortSignal?: AbortSignal): ToolContext {
  return {
    conversationId: "conv-1",
    agentName: "test-agent",
    abortSignal: abortSignal ?? new AbortController().signal,
  };
}

// ---------------------------------------------------------------------------
// BashTool
// ---------------------------------------------------------------------------

describe("BashTool", () => {
  it("has correct schema structure", () => {
    const tool = BashTool();
    expect(tool.name).toBe("bash");
    expect(typeof tool.description).toBe("string");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("command");
    expect(params.required).toContain("command");
  });

  it("returns stdout as text result on success", async () => {
    const tool = BashTool();
    const result = await tool.handler({ command: "echo hello" }, makeCtx());
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text.trim()).toBe("hello");
    }
  });

  it("returns error result on command failure", async () => {
    const tool = BashTool();
    const result = await tool.handler({ command: "cat /nonexistent_file_xyz_abc_123" }, makeCtx());
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(typeof result.error).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// FileReadTool
// ---------------------------------------------------------------------------

describe("FileReadTool", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = join(tmpdir(), `openharness-test-${Date.now()}.txt`);
    await writeFile(tmpFile, "hello file", "utf8");
  });

  it("has correct schema structure", () => {
    const tool = FileReadTool();
    expect(tool.name).toBe("file_read");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("path");
    expect(params.required).toContain("path");
  });

  it("reads file content successfully", async () => {
    const tool = FileReadTool();
    const result = await tool.handler({ path: tmpFile }, makeCtx());
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text).toBe("hello file");
    }
  });

  it("returns error for non-existent file", async () => {
    const tool = FileReadTool();
    const result = await tool.handler({ path: "/nonexistent/path/file.txt" }, makeCtx());
    expect(result.type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// FileWriteTool
// ---------------------------------------------------------------------------

describe("FileWriteTool", () => {
  it("has correct schema structure", () => {
    const tool = FileWriteTool();
    expect(tool.name).toBe("file_write");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("content");
    expect(params.required).toContain("path");
    expect(params.required).toContain("content");
  });

  it("writes file successfully and returns text result", async () => {
    const tmpFile = join(tmpdir(), `openharness-write-${Date.now()}.txt`);
    const tool = FileWriteTool();
    const result = await tool.handler({ path: tmpFile, content: "written content" }, makeCtx());
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text).toContain(tmpFile);
    }
  });

  it("returns error when path is invalid", async () => {
    const tool = FileWriteTool();
    const result = await tool.handler({ path: "/nonexistent/deeply/nested/path.txt", content: "x" }, makeCtx());
    expect(result.type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// FileListTool
// ---------------------------------------------------------------------------

describe("FileListTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `openharness-list-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, "a.txt"), "a");
    await writeFile(join(tmpDir, "b.txt"), "b");
  });

  it("has correct schema structure", () => {
    const tool = FileListTool();
    expect(tool.name).toBe("file_list");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("path");
    expect(params.required).toContain("path");
  });

  it("lists directory entries as json result", async () => {
    const tool = FileListTool();
    const result = await tool.handler({ path: tmpDir }, makeCtx());
    expect(result.type).toBe("json");
    if (result.type === "json") {
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(Array.isArray(entries)).toBe(true);
      const names = entries.map((e) => e.name);
      expect(names).toContain("a.txt");
      expect(names).toContain("b.txt");
    }
  });

  it("returns error for non-existent directory", async () => {
    const tool = FileListTool();
    const result = await tool.handler({ path: "/nonexistent/dir/xyz" }, makeCtx());
    expect(result.type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// HttpFetchTool
// ---------------------------------------------------------------------------

describe("HttpFetchTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct schema structure", () => {
    const tool = HttpFetchTool();
    expect(tool.name).toBe("http_fetch");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("url");
    expect(params.required).toContain("url");
  });

  it("returns json result with status, headers, body on success", async () => {
    const mockResponse = {
      status: 200,
      headers: {
        get: (name: string) => (name === "content-type" ? "application/json" : null),
        forEach: (cb: (value: string, key: string) => void) => {
          cb("application/json", "content-type");
        },
      },
      json: async () => ({ ok: true }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const tool = HttpFetchTool();
    const result = await tool.handler({ url: "https://example.com/api" }, makeCtx());

    expect(result.type).toBe("json");
    if (result.type === "json") {
      const data = result.data as { status: number; headers: Record<string, string>; body: unknown };
      expect(data.status).toBe(200);
      expect(data.body).toEqual({ ok: true });
    }
  });

  it("returns error result when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const tool = HttpFetchTool();
    const result = await tool.handler({ url: "https://example.com/fail" }, makeCtx());
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toContain("Network error");
    }
  });
});

// ---------------------------------------------------------------------------
// JsonQueryTool
// ---------------------------------------------------------------------------

describe("JsonQueryTool", () => {
  it("has correct schema structure", () => {
    const tool = JsonQueryTool();
    expect(tool.name).toBe("json_query");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("data");
    expect(params.properties).toHaveProperty("path");
    expect(params.required).toContain("data");
    expect(params.required).toContain("path");
  });

  it("queries nested object with dot notation", async () => {
    const tool = JsonQueryTool();
    const data = { user: { name: "Alice", age: 30 } };
    const result = await tool.handler({ data, path: "$.user.name" }, makeCtx());
    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toBe("Alice");
    }
  });

  it("queries array with bracket notation", async () => {
    const tool = JsonQueryTool();
    const data = { items: ["a", "b", "c"] };
    const result = await tool.handler({ data, path: "$.items[1]" }, makeCtx());
    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toBe("b");
    }
  });

  it("returns root data for $ path", async () => {
    const tool = JsonQueryTool();
    const data = { x: 1 };
    const result = await tool.handler({ data, path: "$" }, makeCtx());
    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toEqual(data);
    }
  });

  it("returns undefined for missing path", async () => {
    const tool = JsonQueryTool();
    const data = { a: 1 };
    const result = await tool.handler({ data, path: "$.b.c" }, makeCtx());
    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// TextTransformTool
// ---------------------------------------------------------------------------

describe("TextTransformTool", () => {
  it("has correct schema structure", () => {
    const tool = TextTransformTool();
    expect(tool.name).toBe("text_transform");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("text");
    expect(params.properties).toHaveProperty("operation");
    expect(params.required).toContain("text");
    expect(params.required).toContain("operation");
  });

  it("uppercase operation", async () => {
    const tool = TextTransformTool();
    const result = await tool.handler({ text: "hello world", operation: "uppercase" }, makeCtx());
    expect(result).toEqual({ type: "text", text: "HELLO WORLD" });
  });

  it("lowercase operation", async () => {
    const tool = TextTransformTool();
    const result = await tool.handler({ text: "HELLO WORLD", operation: "lowercase" }, makeCtx());
    expect(result).toEqual({ type: "text", text: "hello world" });
  });

  it("trim operation", async () => {
    const tool = TextTransformTool();
    const result = await tool.handler({ text: "  spaces  ", operation: "trim" }, makeCtx());
    expect(result).toEqual({ type: "text", text: "spaces" });
  });

  it("split operation returns json array", async () => {
    const tool = TextTransformTool();
    const result = await tool.handler(
      { text: "a,b,c", operation: "split", options: { delimiter: "," } },
      makeCtx(),
    );
    expect(result.type).toBe("json");
    if (result.type === "json") {
      expect(result.data).toEqual(["a", "b", "c"]);
    }
  });

  it("replace operation", async () => {
    const tool = TextTransformTool();
    const result = await tool.handler(
      { text: "foo bar foo", operation: "replace", options: { find: "foo", replacement: "baz" } },
      makeCtx(),
    );
    expect(result).toEqual({ type: "text", text: "baz bar baz" });
  });
});

// ---------------------------------------------------------------------------
// WaitTool
// ---------------------------------------------------------------------------

describe("WaitTool", () => {
  it("has correct schema structure", () => {
    const tool = WaitTool();
    expect(tool.name).toBe("wait");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("ms");
    expect(params.required).toContain("ms");
  });

  it("waits and returns text result", async () => {
    const tool = WaitTool();
    const result = await tool.handler({ ms: 10 }, makeCtx());
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text).toBe("Waited 10ms");
    }
  });

  it("respects maxMs cap", async () => {
    const tool = WaitTool({ maxMs: 20 });
    const result = await tool.handler({ ms: 1000 }, makeCtx());
    expect(result.type).toBe("text");
    if (result.type === "text") {
      expect(result.text).toBe("Waited 20ms");
    }
  });

  it("rejects when aborted", async () => {
    const tool = WaitTool();
    const ac = new AbortController();
    const promise = tool.handler({ ms: 5000 }, makeCtx(ac.signal));
    ac.abort();
    await expect(promise).rejects.toThrow();
  });
});

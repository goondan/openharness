import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../tool-registry.js";
import type { ToolDefinition, ToolContext, ToolResult } from "@goondan/openharness-types";

// Helper to create a minimal ToolContext
function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId: "conv-1",
    agentName: "test-agent",
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

// Helper to create a ToolDefinition
function makeTool(
  name: string,
  parameters: Record<string, unknown> = {},
  handler?: ToolDefinition["handler"]
): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    parameters,
    handler: handler ?? (async () => ({ type: "text", text: "ok" })),
  };
}

describe("ToolRegistry", () => {
  // Test 1: Register tool → list() includes it
  it("register tool → list() includes it", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("my_tool");
    registry.register(tool);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("my_tool");
  });

  // Test 2: Register duplicate name → throws
  it("register duplicate name → throws", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("duplicate_tool"));

    expect(() => {
      registry.register(makeTool("duplicate_tool"));
    }).toThrow(/already registered/i);
  });

  // Test 3: Remove tool → list() excludes it
  it("remove tool → list() excludes it", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("tool_a"));
    registry.register(makeTool("tool_b"));

    registry.remove("tool_a");

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("tool_b");
  });

  // Test 4: Remove non-existent → throws
  it("remove non-existent tool → throws", () => {
    const registry = new ToolRegistry();

    expect(() => {
      registry.remove("non_existent");
    }).toThrow(/not found/i);
  });

  // Test 5: JSON Schema validation: valid args pass
  it("JSON Schema validation: valid args pass", () => {
    const registry = new ToolRegistry();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    };
    registry.register(makeTool("schema_tool", schema));

    const result = registry.validate("schema_tool", { name: "Alice", age: 30 });
    expect(result.valid).toBe(true);
  });

  // Test 6: JSON Schema validation: invalid args → returns validation error
  it("JSON Schema validation: invalid args → returns validation error", () => {
    const registry = new ToolRegistry();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };
    registry.register(makeTool("schema_tool_2", schema));

    // Missing required field
    const result = registry.validate("schema_tool_2", { age: 30 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toBeTruthy();
    }
  });

  // Test 7: Tool handler called with correct ToolContext
  it("execute: handler called with correct ToolContext", async () => {
    const registry = new ToolRegistry();
    const receivedArgs: unknown[] = [];
    const receivedContexts: ToolContext[] = [];

    const handler = vi.fn(async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      receivedArgs.push(args);
      receivedContexts.push(ctx);
      return { type: "text", text: "handler called" };
    });

    registry.register(makeTool("ctx_tool", {}, handler));

    const ctx = makeContext({ conversationId: "conv-42", agentName: "my-agent" });
    const result = await registry.execute("ctx_tool", {}, ctx);

    expect(handler).toHaveBeenCalledOnce();
    expect(receivedContexts[0].conversationId).toBe("conv-42");
    expect(receivedContexts[0].agentName).toBe("my-agent");
    expect(result).toEqual({ type: "text", text: "handler called" });
  });

  // Test 8: Tool handler exception → ToolResult type "error"
  it("execute: handler exception → ToolResult type 'error'", async () => {
    const registry = new ToolRegistry();

    const handler = vi.fn(async (): Promise<ToolResult> => {
      throw new Error("handler exploded");
    });

    registry.register(makeTool("error_tool", {}, handler));

    const result = await registry.execute("error_tool", {}, makeContext());

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toContain("handler exploded");
    }
  });

  // Bonus test: execute with invalid args returns error without calling handler
  it("execute: invalid args → error result without calling handler", async () => {
    const registry = new ToolRegistry();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };

    const handler = vi.fn(async (): Promise<ToolResult> => {
      return { type: "text", text: "should not be called" };
    });

    registry.register(makeTool("validated_tool", schema, handler));

    // Missing required "name"
    const result = await registry.execute("validated_tool", { age: 99 }, makeContext());

    expect(result.type).toBe("error");
    expect(handler).not.toHaveBeenCalled();
  });

  // Bonus test: get() returns the tool or undefined
  it("get() returns registered tool or undefined", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("get_tool");
    registry.register(tool);

    expect(registry.get("get_tool")).toBeDefined();
    expect(registry.get("get_tool")?.name).toBe("get_tool");
    expect(registry.get("no_such_tool")).toBeUndefined();
  });

  // Bonus test: list() returns a new array (readonly-safe)
  it("list() returns a snapshot array", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("t1"));
    const list1 = registry.list();

    registry.register(makeTool("t2"));
    const list2 = registry.list();

    expect(list1).toHaveLength(1);
    expect(list2).toHaveLength(2);
  });
});

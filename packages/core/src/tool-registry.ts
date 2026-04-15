import type { ValidateFunction } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import {
  resolveToolParameters,
  type ToolDefinition,
  type ToolContext,
  type ToolResult,
  type JsonObject,
} from "@goondan/openharness-types";

// CommonJS default exports are wrapped when imported as ESM.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

type ValidateResult =
  | { valid: true }
  | { valid: false; errors: string };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = createAjv();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    const validate = this.ajv.compile(resolveToolParameters(tool.parameters));
    this.tools.set(tool.name, tool);
    this.validators.set(tool.name, validate);
  }

  remove(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error(`Tool "${name}" not found in registry`);
    }
    this.tools.delete(name);
    this.validators.delete(name);
  }

  list(): readonly ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  validate(name: string, args: JsonObject): ValidateResult {
    const validateFn = this.validators.get(name);
    if (!validateFn) {
      return { valid: false, errors: `Tool "${name}" not found` };
    }
    const isValid = validateFn(args);
    if (isValid) {
      return { valid: true };
    }
    const errors = this.ajv.errorsText(validateFn.errors);
    return { valid: false, errors };
  }

  async execute(name: string, args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { type: "error", error: `Tool "${name}" not found` };
    }

    const validation = this.validate(name, args);
    if (!validation.valid) {
      return { type: "error", error: `Invalid arguments: ${validation.errors}` };
    }

    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { type: "error", error: message };
    }
  }
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv;
}

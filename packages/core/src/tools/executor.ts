import type {
  JsonObject,
  JsonSchemaObject,
  JsonSchemaProperty,
  JsonValue,
  Message,
  ToolCallResult,
  ToolContext,
  ToolCatalogItem,
} from "../types.js";
import type { ToolRegistry } from "./registry.js";

export interface ToolExecutionRequest {
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  catalog: ToolCatalogItem[];
  context: ToolContext;
  allowRegistryBypass?: boolean;
  errorMessageLimit?: number;
}

const DEFAULT_ERROR_MESSAGE_LIMIT = 1000;

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(request: ToolExecutionRequest): Promise<ToolCallResult> {
    const catalogItem = findToolInCatalog(request.toolName, request.catalog);

    if (!request.allowRegistryBypass && !catalogItem) {
      return {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        status: "error",
        error: {
          name: "ToolNotInCatalogError",
          code: "E_TOOL_NOT_IN_CATALOG",
          message: `Tool '${request.toolName}' is not available in the current Tool Catalog.`,
          suggestion:
            "Agent 구성의 spec.tools에 해당 도구를 추가하거나, step 미들웨어에서 동적으로 등록하세요.",
        },
      };
    }

    if (catalogItem?.parameters) {
      const issues = validateToolArguments(request.args, catalogItem.parameters, "args");
      if (issues.length > 0) {
        const limit = request.errorMessageLimit ?? DEFAULT_ERROR_MESSAGE_LIMIT;
        const message = truncateErrorMessage(formatToolArgumentValidationIssues(request.toolName, issues), limit);
        return {
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          status: "error",
          error: {
            name: "ToolInputValidationError",
            code: "E_TOOL_INVALID_ARGS",
            message,
            suggestion: buildValidationSuggestion(catalogItem.parameters),
          },
        };
      }
    }

    const handler = this.registry.getHandler(request.toolName);
    if (handler === undefined) {
      return {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        status: "error",
        error: {
          name: "ToolNotFoundError",
          code: "E_TOOL_NOT_FOUND",
          message: `Tool '${request.toolName}' is not registered.`,
          suggestion: "Tool registry와 번들 Tool 설정을 확인하세요.",
        },
      };
    }

    try {
      const output = await handler(request.context, request.args);
      return {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        status: "ok",
        output,
      };
    } catch (error) {
      const limit = request.errorMessageLimit ?? DEFAULT_ERROR_MESSAGE_LIMIT;
      return {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        status: "error",
        error: toToolError(error, limit),
      };
    }
  }
}

function findToolInCatalog(toolName: string, catalog: ToolCatalogItem[]): ToolCatalogItem | undefined {
  return catalog.find((item) => item.name === toolName);
}

export interface ToolArgumentValidationIssue {
  path: string;
  message: string;
}

export function validateToolArguments(
  args: JsonObject,
  schema: JsonSchemaObject,
  rootPath = "args",
): ToolArgumentValidationIssue[] {
  const issues: ToolArgumentValidationIssue[] = [];
  validateObjectValue(args, schema, rootPath, issues);
  return issues;
}

function validateObjectValue(
  value: JsonObject,
  schema: JsonSchemaObject,
  currentPath: string,
  issues: ToolArgumentValidationIssue[],
): void {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push({
        path: `${currentPath}.${key}`,
        message: "required property is missing",
      });
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        issues.push({
          path: `${currentPath}.${key}`,
          message: "unexpected property",
        });
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }

    const nestedValue = value[key];
    if (nestedValue === undefined) {
      continue;
    }
    validatePropertyValue(nestedValue, propertySchema, `${currentPath}.${key}`, issues);
  }
}

function validatePropertyValue(
  value: JsonValue,
  schema: JsonSchemaProperty,
  currentPath: string,
  issues: ToolArgumentValidationIssue[],
): void {
  const expectedTypes = toExpectedTypes(schema.type);
  if (expectedTypes.length > 0 && !expectedTypes.some((type) => matchesSchemaType(value, type))) {
    issues.push({
      path: currentPath,
      message: `expected ${expectedTypes.join("|")} but got ${toJsonTypeName(value)}`,
    });
    return;
  }

  if (schema.enum && schema.enum.length > 0 && !schema.enum.some((candidate) => isEnumMatch(candidate, value))) {
    issues.push({
      path: currentPath,
      message: `value must be one of [${schema.enum.map((item) => JSON.stringify(item)).join(", ")}]`,
    });
    return;
  }

  if (isJsonObjectValue(value) && schema.properties) {
    for (const [childKey, childSchema] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, childKey)) {
        continue;
      }
      const childValue = value[childKey];
      if (childValue === undefined) {
        continue;
      }
      validatePropertyValue(childValue, childSchema, `${currentPath}.${childKey}`, issues);
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry === undefined) {
        continue;
      }
      validatePropertyValue(entry, schema.items, `${currentPath}[${index}]`, issues);
    }
  }
}

function toExpectedTypes(type: string | string[] | undefined): string[] {
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function matchesSchemaType(value: JsonValue, expectedType: string): boolean {
  switch (expectedType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isJsonObjectValue(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isJsonObjectValue(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonTypeName(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function isEnumMatch(candidate: JsonValue, value: JsonValue): boolean {
  if (candidate === value) {
    return true;
  }
  return JSON.stringify(candidate) === JSON.stringify(value);
}

export function formatToolArgumentValidationIssues(
  toolName: string,
  issues: ToolArgumentValidationIssue[],
): string {
  const maxIssues = 5;
  const visible = issues.slice(0, maxIssues).map((issue) => `${issue.path}: ${issue.message}`);
  const suffix = issues.length > maxIssues ? `; +${issues.length - maxIssues} more issues` : "";
  return `Invalid arguments for tool '${toolName}': ${visible.join("; ")}${suffix}`;
}

function buildValidationSuggestion(schema: JsonSchemaObject): string {
  const required = schema.required ?? [];
  const keys = Object.keys(schema.properties ?? {});
  const requiredText = required.length > 0 ? required.join(", ") : "(none)";
  const keyText = keys.length > 0 ? keys.join(", ") : "(none)";
  return `입력 스키마를 확인해 인자를 다시 작성하세요. required=[${requiredText}], allowed=[${keyText}]`;
}

function toToolError(error: unknown, limit: number): {
  name?: string;
  message: string;
  code?: string;
  suggestion?: string;
  helpUrl?: string;
} {
  if (error instanceof Error) {
    const toolError: {
      name?: string;
      message: string;
      code?: string;
      suggestion?: string;
      helpUrl?: string;
    } = {
      name: error.name,
      message: truncateErrorMessage(error.message, limit),
    };

    if (hasCode(error)) {
      toolError.code = error.code;
    }

    if (hasSuggestion(error)) {
      toolError.suggestion = error.suggestion;
    }

    if (hasHelpUrl(error)) {
      toolError.helpUrl = error.helpUrl;
    }

    return toolError;
  }

  return {
    message: truncateErrorMessage("Unknown tool execution error", limit),
  };
}

function hasCode(error: Error): error is Error & { code: string } {
  if (!("code" in error)) {
    return false;
  }

  const maybeCode = Reflect.get(error, "code");
  return typeof maybeCode === "string";
}

function hasSuggestion(error: Error): error is Error & { suggestion: string } {
  if (!("suggestion" in error)) {
    return false;
  }

  const maybeSuggestion = Reflect.get(error, "suggestion");
  return typeof maybeSuggestion === "string";
}

function hasHelpUrl(error: Error): error is Error & { helpUrl: string } {
  if (!("helpUrl" in error)) {
    return false;
  }

  const maybeHelpUrl = Reflect.get(error, "helpUrl");
  return typeof maybeHelpUrl === "string";
}

export function truncateErrorMessage(message: string, limit: number): string {
  if (message.length <= limit) {
    return message;
  }

  const truncationSuffix = "... (truncated)";
  const maxContentLength = limit - truncationSuffix.length;
  if (maxContentLength <= 0) {
    return message.slice(0, limit);
  }

  return message.slice(0, maxContentLength) + truncationSuffix;
}

export function createMinimalToolContext(input: {
  agentName: string;
  instanceKey: string;
  turnId: string;
  traceId: string;
  toolCallId: string;
  message: Message;
  workdir: string;
  logger?: Console;
  runtime?: import("../types.js").AgentToolRuntime;
}): ToolContext {
  return {
    agentName: input.agentName,
    instanceKey: input.instanceKey,
    turnId: input.turnId,
    traceId: input.traceId,
    toolCallId: input.toolCallId,
    message: input.message,
    workdir: input.workdir,
    logger: input.logger ?? console,
    runtime: input.runtime,
  };
}

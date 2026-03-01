export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export interface MessageData {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface Message {
  readonly id: string;
  readonly data: MessageData;
  metadata: Record<string, JsonValue>;
  readonly createdAt: Date;
  readonly source: {
    type: string;
    [key: string]: unknown;
  };
}

export interface ExecutionContext {
  readonly agentName: string;
  readonly instanceKey: string;
  readonly turnId: string;
  readonly traceId: string;
}

export interface ToolContext extends ExecutionContext {
  readonly toolCallId: string;
  readonly message: Message;
  readonly workdir: string;
  readonly logger: Console;
}

export type ToolHandler = (ctx: ToolContext, input: JsonObject) => Promise<JsonValue> | JsonValue;

export interface ResourceMetadata {
  name: string;
  labels?: Record<string, string>;
}

export interface ResourceManifest<TKind extends string, TSpec> {
  apiVersion: "goondan.ai/v1";
  kind: TKind;
  metadata: ResourceMetadata;
  spec: TSpec;
}

export interface ToolExportSpec {
  name: string;
  description?: string;
  parameters?: JsonObject;
}

export interface ToolManifestSpec {
  entry: string;
  errorMessageLimit?: number;
  exports: ToolExportSpec[];
}


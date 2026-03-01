import { isPlainObject } from "./json.js";
import type { JsonValue } from "./json.js";
import type { ObjectRefLike, RefOrSelector } from "./references.js";
import type { ValueSource } from "./value-source.js";

export const GOONDAN_API_VERSION = "goondan.ai/v1";

export type KnownKind =
  | "Model"
  | "Agent"
  | "Swarm"
  | "Tool"
  | "Extension"
  | "Connector"
  | "Connection"
  | "Package";

export interface ResourceMetadata {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Resource<T = unknown> {
  apiVersion: string;
  kind: string;
  metadata: ResourceMetadata;
  spec: T;
}

export interface TypedResource<K extends KnownKind, T> extends Resource<T> {
  apiVersion: typeof GOONDAN_API_VERSION;
  kind: K;
}

export interface ModelCapabilities {
  streaming?: boolean;
  toolCalling?: boolean;
  [key: string]: boolean | undefined;
}

export interface ModelSpec {
  provider: string;
  model: string;
  apiKey?: ValueSource;
  endpoint?: string;
  options?: Record<string, unknown>;
  capabilities?: ModelCapabilities;
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JsonSchemaString {
  type: "string";
  enum?: string[];
}

export interface JsonSchemaNumber {
  type: "number" | "integer";
}

export interface JsonSchemaBoolean {
  type: "boolean";
}

export interface JsonSchemaArray {
  type: "array";
  items?: JsonSchemaProperty;
}

export type JsonSchemaProperty =
  | JsonSchemaString
  | JsonSchemaNumber
  | JsonSchemaBoolean
  | JsonSchemaArray
  | JsonSchemaObject;

export interface ToolExportSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface ToolSpec {
  entry: string;
  errorMessageLimit?: number;
  exports: ToolExportSpec[];
}

export interface ExtensionSpec {
  entry: string;
  config?: Record<string, unknown>;
}

export interface AgentSpec {
  modelConfig: AgentModelConfig;
  prompt?: AgentPrompt;
  tools?: RefOrSelector[];
  extensions?: RefOrSelector[];
}

export interface AgentModelConfig {
  modelRef: ObjectRefLike;
  params?: ModelParams;
}

export interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  [key: string]: unknown;
}

export interface AgentPrompt {
  system?: string;
  systemRef?: string;
}

export interface SwarmSpec {
  entryAgent: ObjectRefLike;
  agents: RefOrSelector[];
  policy?: SwarmPolicy;
}

export interface SwarmPolicy {
  maxStepsPerTurn?: number;
  lifecycle?: SwarmLifecyclePolicy;
  shutdown?: SwarmShutdownPolicy;
}

export interface SwarmLifecyclePolicy {
  ttlSeconds?: number;
  gcGraceSeconds?: number;
}

export interface SwarmShutdownPolicy {
  gracePeriodSeconds?: number;
}

export interface EventPropertyType {
  type: "string" | "number" | "boolean";
  optional?: boolean;
}

export interface EventSchema {
  name: string;
  properties?: Record<string, EventPropertyType>;
}

export interface ConnectorSpec {
  entry: string;
  events: EventSchema[];
}

export interface ConnectionSpec {
  connectorRef: ObjectRefLike;
  swarmRef?: ObjectRefLike;
  /** Connector의 일반 설정 값 */
  config?: Record<string, ValueSource>;
  /** Connector의 비밀 값 */
  secrets?: Record<string, ValueSource>;
  verify?: ConnectionVerify;
  ingress?: IngressConfig;
}

export interface ConnectionVerify {
  webhook?: {
    signingSecret: ValueSource;
  };
}

export interface IngressConfig {
  rules?: IngressRule[];
}

export interface IngressRule {
  match?: IngressMatch;
  route: IngressRoute;
}

export interface IngressMatch {
  event?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface IngressRoute {
  agentRef?: ObjectRefLike;
  /** 고정 instanceKey (instanceKeyProperty와 동시 사용 불가) */
  instanceKey?: string;
  /** ConnectorEvent.properties에서 instanceKey로 사용할 속성 키 (instanceKey와 동시 사용 불가) */
  instanceKeyProperty?: string;
  /** instanceKeyProperty 기반 키에 적용할 접두어 (instanceKeyProperty와 함께 사용) */
  instanceKeyPrefix?: string;
}

export interface PackageSpec {
  version?: string;
  description?: string;
  access?: "public" | "restricted";
  dependencies?: PackageDependency[];
  registry?: PackageRegistry;
}

export interface PackageDependency {
  name: string;
  version: string;
}

export interface PackageRegistry {
  url: string;
}

export type ModelResource = TypedResource<"Model", ModelSpec>;
export type AgentResource = TypedResource<"Agent", AgentSpec>;
export type SwarmResource = TypedResource<"Swarm", SwarmSpec>;
export type ToolResource = TypedResource<"Tool", ToolSpec>;
export type ExtensionResource = TypedResource<"Extension", ExtensionSpec>;
export type ConnectorResource = TypedResource<"Connector", ConnectorSpec>;
export type ConnectionResource = TypedResource<"Connection", ConnectionSpec>;
export type PackageResource = TypedResource<"Package", PackageSpec>;

export type KnownResource =
  | ModelResource
  | AgentResource
  | SwarmResource
  | ToolResource
  | ExtensionResource
  | ConnectorResource
  | ConnectionResource
  | PackageResource;

export interface ValidationError {
  code: string;
  message: string;
  path: string;
  suggestion?: string;
  helpUrl?: string;
  details?: JsonValue;
}

export function isKnownKind(value: unknown): value is KnownKind {
  return (
    value === "Model" ||
    value === "Agent" ||
    value === "Swarm" ||
    value === "Tool" ||
    value === "Extension" ||
    value === "Connector" ||
    value === "Connection" ||
    value === "Package"
  );
}

export function isResource(value: unknown): value is Resource {
  if (!isPlainObject(value)) {
    return false;
  }

  if (typeof value["apiVersion"] !== "string" || value["apiVersion"].length === 0) {
    return false;
  }

  if (typeof value["kind"] !== "string" || value["kind"].length === 0) {
    return false;
  }

  const metadataValue = value["metadata"];
  if (!isPlainObject(metadataValue)) {
    return false;
  }

  if (typeof metadataValue["name"] !== "string" || metadataValue["name"].length === 0) {
    return false;
  }

  return value["spec"] !== undefined;
}

export function isGoodanResource(
  value: unknown,
): value is Resource & {
  apiVersion: typeof GOONDAN_API_VERSION;
} {
  return isResource(value) && value.apiVersion === GOONDAN_API_VERSION;
}

function isResourceOfKind<K extends KnownKind>(
  value: unknown,
  kind: K,
): value is TypedResource<K, unknown> {
  return isGoodanResource(value) && value.kind === kind;
}

export function isModelResource(value: unknown): value is ModelResource {
  return isResourceOfKind(value, "Model");
}

export function isAgentResource(value: unknown): value is AgentResource {
  return isResourceOfKind(value, "Agent");
}

export function isSwarmResource(value: unknown): value is SwarmResource {
  return isResourceOfKind(value, "Swarm");
}

export function isToolResource(value: unknown): value is ToolResource {
  return isResourceOfKind(value, "Tool");
}

export function isExtensionResource(value: unknown): value is ExtensionResource {
  return isResourceOfKind(value, "Extension");
}

export function isConnectorResource(value: unknown): value is ConnectorResource {
  return isResourceOfKind(value, "Connector");
}

export function isConnectionResource(value: unknown): value is ConnectionResource {
  return isResourceOfKind(value, "Connection");
}

export function isPackageResource(value: unknown): value is PackageResource {
  return isResourceOfKind(value, "Package");
}


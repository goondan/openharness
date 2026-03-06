import type {
  AgentSpec,
  ModelSpec,
  ObjectRefLike,
  RefOrSelector,
  SecretRef,
  Selector,
  SelectorWithOverrides,
  ToolSpec,
  ExtensionSpec,
  ValueSource,
} from "@goondan/openharness-types";
import {
  formatObjectRef,
  isRefItem,
  isSelectorWithOverrides,
  parseObjectRef,
  resolveValueSource,
} from "@goondan/openharness-types";

import { isJsonObject, type KnownKind, type RuntimeResource } from "../../types.js";

export type AgentRuntimeResource = RuntimeResource<AgentSpec> & { kind: "Agent" };
export type ModelRuntimeResource = RuntimeResource<ModelSpec> & { kind: "Model" };
export type ToolRuntimeResource = RuntimeResource<ToolSpec> & { kind: "Tool" };
export type ExtensionRuntimeResource = RuntimeResource<ExtensionSpec> & { kind: "Extension" };

export interface ResolveValueSourceInput {
  env?: Readonly<Record<string, string | undefined>>;
  resolveSecretRef?: (secretRef: SecretRef) => string | undefined;
}

export function selectEntryAgent(resources: RuntimeResource[], agentName: string | undefined): AgentRuntimeResource {
  const agents = resources.filter((r): r is AgentRuntimeResource => r.kind === "Agent");
  if (agents.length === 0) {
    throw new Error("Agent 리소스를 찾을 수 없습니다. (kind: Agent)");
  }

  if (typeof agentName === "string" && agentName.trim().length > 0) {
    const name = agentName.trim();
    const found = agents.find((a) => a.metadata.name === name);
    if (!found) {
      throw new Error(buildAgentNotFoundMessage(name, agents));
    }
    assertAgentSpecShape(found);
    return found;
  }

  if (agents.length === 1) {
    const only = agents[0];
    if (!only) {
      throw new Error("Agent 리소스 선택 실패: agents[0]이 없습니다.");
    }
    assertAgentSpecShape(only);
    return only;
  }

  throw new Error(buildAgentSelectionRequiredMessage(agents));
}

export function resolveAgentModelConfig(
  agent: AgentRuntimeResource,
  resources: RuntimeResource[],
  input: ResolveValueSourceInput,
): {
  provider: string;
  modelName: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  modelResource: ModelRuntimeResource;
} {
  assertAgentSpecShape(agent);

  const modelRef: ObjectRefLike = agent.spec.modelConfig.modelRef;
  const model = resolveResourceByRef(resources, modelRef, "Model") as ModelRuntimeResource | undefined;
  if (!model) {
    throw new Error(
      `Agent.modelConfig.modelRef가 가리키는 Model 리소스를 찾을 수 없습니다: ${formatObjectRef(modelRef)}\n` +
        `- Agent: ${formatResourceOrigin(agent)}`,
    );
  }

  assertModelSpecShape(model);

  const apiKeyValueSource = model.spec.apiKey;
  if (apiKeyValueSource === undefined) {
    throw new Error(`Model.spec.apiKey가 필요합니다: ${formatResourceOrigin(model)}`);
  }

  const apiKey = resolveValueSource(apiKeyValueSource as ValueSource, {
    env: input.env,
    resolveSecretRef: input.resolveSecretRef,
    required: true,
  });

  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(`Model.spec.apiKey 해석 결과가 비어 있습니다: ${formatResourceOrigin(model)}`);
  }

  const params = agent.spec.modelConfig.params ?? {};
  const temperature =
    typeof params.temperature === "number" && Number.isFinite(params.temperature) ? params.temperature : 0.2;
  const maxTokens = typeof params.maxTokens === "number" && Number.isFinite(params.maxTokens) ? params.maxTokens : 2048;

  return {
    provider: model.spec.provider,
    modelName: model.spec.model,
    apiKey,
    temperature,
    maxTokens,
    modelResource: model,
  };
}

export function resolveAgentToolResources(agent: AgentRuntimeResource, resources: RuntimeResource[]): ToolRuntimeResource[] {
  assertAgentSpecShape(agent);
  return resolveRefOrSelectorList(resources, agent.spec.tools ?? [], "Tool") as ToolRuntimeResource[];
}

export function resolveAgentExtensionResources(
  agent: AgentRuntimeResource,
  resources: RuntimeResource[],
): ExtensionRuntimeResource[] {
  assertAgentSpecShape(agent);
  return resolveRefOrSelectorList(resources, agent.spec.extensions ?? [], "Extension") as ExtensionRuntimeResource[];
}

export function resolveRefOrSelectorList(
  resources: RuntimeResource[],
  refs: RefOrSelector[],
  expectedKind: KnownKind,
): RuntimeResource[] {
  const resolved: RuntimeResource[] = [];
  const seen = new Set<string>();

  for (const item of refs) {
    if (isRefItem(item)) {
      const found = resolveResourceByRef(resources, item.ref, expectedKind);
      if (!found) {
        throw new Error(`리소스를 찾을 수 없습니다: ${formatObjectRef(item.ref)}`);
      }

      const key = resourceKey(found);
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push(found);
      }
      continue;
    }

    if (isSelectorWithOverrides(item)) {
      const selected = resolveResourcesBySelector(resources, item.selector, expectedKind);
      for (const res of selected) {
        const overridden = applyResourceOverrides(res, item.overrides);
        const key = resourceKey(overridden);
        if (!seen.has(key)) {
          seen.add(key);
          resolved.push(overridden);
        }
      }
      continue;
    }

    const found = resolveResourceByRef(resources, item, expectedKind);
    if (!found) {
      throw new Error(`리소스를 찾을 수 없습니다: ${formatObjectRef(item)}`);
    }

    const key = resourceKey(found);
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push(found);
    }
  }

  return resolved;
}

function resolveResourcesBySelector(
  resources: RuntimeResource[],
  selector: Selector,
  expectedKind: KnownKind,
): RuntimeResource[] {
  if (selector.kind !== undefined && selector.kind !== expectedKind) {
    throw new Error(`selector.kind 불일치: expected ${expectedKind}, got ${selector.kind}`);
  }

  return resources.filter((res) => {
    if (res.kind !== expectedKind) {
      return false;
    }

    if (typeof selector.name === "string" && selector.name.trim().length > 0 && res.metadata.name !== selector.name) {
      return false;
    }

    if (selector.matchLabels && Object.keys(selector.matchLabels).length > 0) {
      const labels = res.metadata.labels ?? {};
      for (const [key, value] of Object.entries(selector.matchLabels)) {
        if (labels[key] !== value) {
          return false;
        }
      }
    }

    return true;
  });
}

function resolveResourceByRef(
  resources: RuntimeResource[],
  ref: ObjectRefLike,
  expectedKind: KnownKind,
): RuntimeResource | undefined {
  const parsed = parseObjectRef(ref);

  if (parsed.kind !== expectedKind) {
    throw new Error(`ref.kind 불일치: expected ${expectedKind}, got ${parsed.kind} (${formatObjectRef(ref)})`);
  }

  const matchPackage = typeof parsed.package === "string" && parsed.package.trim().length > 0 ? parsed.package : undefined;
  const matchApiVersion =
    typeof parsed.apiVersion === "string" && parsed.apiVersion.trim().length > 0 ? parsed.apiVersion : undefined;

  return resources.find((res) => {
    if (res.kind !== expectedKind) {
      return false;
    }
    if (res.metadata.name !== parsed.name) {
      return false;
    }
    if (matchPackage !== undefined && res.__package !== matchPackage) {
      return false;
    }
    if (matchApiVersion !== undefined && res.apiVersion !== matchApiVersion) {
      return false;
    }
    return true;
  });
}

function applyResourceOverrides(resource: RuntimeResource, overrides: SelectorWithOverrides["overrides"]): RuntimeResource {
  if (!overrides) {
    return resource;
  }

  const nextMetadata = { ...resource.metadata };
  if (overrides.metadata) {
    if (typeof overrides.metadata.name === "string" && overrides.metadata.name.trim().length > 0) {
      nextMetadata.name = overrides.metadata.name.trim();
    }
    if (overrides.metadata.labels && isJsonObject(overrides.metadata.labels)) {
      nextMetadata.labels = { ...(resource.metadata.labels ?? {}), ...(overrides.metadata.labels as Record<string, string>) };
    }
    if (overrides.metadata.annotations && isJsonObject(overrides.metadata.annotations)) {
      nextMetadata.annotations = {
        ...(resource.metadata.annotations ?? {}),
        ...(overrides.metadata.annotations as Record<string, string>),
      };
    }
  }

  const nextSpec = isJsonObject(resource.spec) ? { ...(resource.spec as Record<string, unknown>) } : {};
  if (overrides.spec && isJsonObject(overrides.spec)) {
    Object.assign(nextSpec, overrides.spec);
  }

  return {
    ...resource,
    metadata: nextMetadata,
    spec: nextSpec,
  };
}

function resourceKey(resource: RuntimeResource): string {
  return `${resource.__file}#${resource.__docIndex}`;
}

function assertAgentSpecShape(agent: AgentRuntimeResource): void {
  const spec = agent.spec as unknown;
  if (!isJsonObject(spec)) {
    throw new Error(`Agent.spec은 object여야 합니다: ${formatResourceOrigin(agent)}`);
  }

  const modelConfig = (spec as Record<string, unknown>)["modelConfig"];
  if (!isJsonObject(modelConfig)) {
    throw new Error(`Agent.spec.modelConfig는 object여야 합니다: ${formatResourceOrigin(agent)}`);
  }

  if (!("modelRef" in modelConfig)) {
    throw new Error(`Agent.spec.modelConfig.modelRef가 필요합니다: ${formatResourceOrigin(agent)}`);
  }
}

function assertModelSpecShape(model: ModelRuntimeResource): void {
  const spec = model.spec as unknown;
  if (!isJsonObject(spec)) {
    throw new Error(`Model.spec은 object여야 합니다: ${formatResourceOrigin(model)}`);
  }

  const provider = (spec as Record<string, unknown>)["provider"];
  const modelName = (spec as Record<string, unknown>)["model"];
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw new Error(`Model.spec.provider가 필요합니다: ${formatResourceOrigin(model)}`);
  }
  if (typeof modelName !== "string" || modelName.trim().length === 0) {
    throw new Error(`Model.spec.model이 필요합니다: ${formatResourceOrigin(model)}`);
  }
}

function buildAgentSelectionRequiredMessage(agents: AgentRuntimeResource[]): string {
  const names = agents.map((a) => a.metadata.name).sort();
  return (
    `Agent 리소스가 2개 이상입니다. options.agentName이 필요합니다.\n` +
    `- 가능한 Agent: ${names.join(", ")}`
  );
}

function buildAgentNotFoundMessage(agentName: string, agents: AgentRuntimeResource[]): string {
  const names = agents.map((a) => a.metadata.name).sort();
  return `요청한 Agent를 찾을 수 없습니다: ${agentName}\n- 가능한 Agent: ${names.join(", ")}`;
}

function formatResourceOrigin(resource: RuntimeResource): string {
  const pkg = resource.__package ? ` (package=${resource.__package})` : "";
  return `${resource.kind}/${resource.metadata.name} @ ${resource.__file}#${resource.__docIndex}${pkg}`;
}

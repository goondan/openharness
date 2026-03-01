/**
 * ObjectRef string shortcut or object form.
 * - string: "Kind/name"
 * - object: { kind, name, package?, apiVersion? }
 */

import { isPlainObject } from "./json.js";

export type ObjectRefLike = string | ObjectRef;

export interface ObjectRef {
  kind: string;
  name: string;
  package?: string;
  apiVersion?: string;
}

export interface RefItem {
  ref: ObjectRefLike;
}

export interface Selector {
  kind?: string;
  name?: string;
  matchLabels?: Record<string, string>;
}

export interface SelectorWithOverrides {
  selector: Selector;
  overrides?: {
    spec?: Record<string, unknown>;
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
  };
}

/** Used in Agent.tools / Agent.extensions / Swarm.agents. */
export type RefOrSelector = RefItem | SelectorWithOverrides | ObjectRefLike;

export function isRefItem(value: unknown): value is RefItem {
  if (!isPlainObject(value)) {
    return false;
  }
  const refValue = value["ref"];
  return isObjectRefLike(refValue);
}

export function isSelectorWithOverrides(value: unknown): value is SelectorWithOverrides {
  if (!isPlainObject(value)) {
    return false;
  }

  const selectorValue = value["selector"];
  if (!isPlainObject(selectorValue)) {
    return false;
  }

  const kindValue = selectorValue["kind"];
  if (kindValue !== undefined && typeof kindValue !== "string") {
    return false;
  }

  const nameValue = selectorValue["name"];
  if (nameValue !== undefined && typeof nameValue !== "string") {
    return false;
  }

  const matchLabelsValue = selectorValue["matchLabels"];
  if (matchLabelsValue !== undefined) {
    if (!isPlainObject(matchLabelsValue)) {
      return false;
    }
    const keys = Object.keys(matchLabelsValue);
    for (const key of keys) {
      if (typeof matchLabelsValue[key] !== "string") {
        return false;
      }
    }
  }

  return true;
}

export function isRefOrSelector(value: unknown): value is RefOrSelector {
  return isRefItem(value) || isSelectorWithOverrides(value) || isObjectRefLike(value);
}

export function parseObjectRef(value: ObjectRefLike): ObjectRef {
  if (typeof value === "string") {
    return parseObjectRefString(value);
  }
  return normalizeObjectRefObject(value);
}

export function parseObjectRefString(value: string): ObjectRef {
  const slashIndex = value.indexOf("/");
  const hasSingleSlash = slashIndex > 0 && slashIndex < value.length - 1;
  if (!hasSingleSlash) {
    throw new Error(`Invalid ObjectRef string: ${value}`);
  }

  const kind = value.slice(0, slashIndex);
  const name = value.slice(slashIndex + 1);

  if (name.includes("/")) {
    throw new Error(`Invalid ObjectRef string (multiple slashes): ${value}`);
  }

  return { kind, name };
}

export function formatObjectRef(value: ObjectRefLike): string {
  const parsed = parseObjectRef(value);
  return `${parsed.kind}/${parsed.name}`;
}

export function isObjectRef(value: unknown): value is ObjectRef {
  if (!isPlainObject(value)) {
    return false;
  }

  const kindValue = value["kind"];
  const nameValue = value["name"];

  if (typeof kindValue !== "string" || kindValue.length === 0) {
    return false;
  }
  if (typeof nameValue !== "string" || nameValue.length === 0) {
    return false;
  }

  const packageValue = value["package"];
  if (packageValue !== undefined && typeof packageValue !== "string") {
    return false;
  }

  const apiVersionValue = value["apiVersion"];
  if (apiVersionValue !== undefined && typeof apiVersionValue !== "string") {
    return false;
  }

  return true;
}

export function isObjectRefLike(value: unknown): value is ObjectRefLike {
  if (typeof value === "string") {
    try {
      parseObjectRefString(value);
      return true;
    } catch {
      return false;
    }
  }
  return isObjectRef(value);
}

function normalizeObjectRefObject(value: ObjectRef): ObjectRef {
  const kind = value.kind.trim();
  const name = value.name.trim();

  if (kind.length === 0 || name.length === 0) {
    throw new Error("Invalid ObjectRef object: kind and name must be non-empty.");
  }

  const normalized: ObjectRef = { kind, name };
  if (typeof value.package === "string" && value.package.length > 0) {
    normalized.package = value.package;
  }
  if (typeof value.apiVersion === "string" && value.apiVersion.length > 0) {
    normalized.apiVersion = value.apiVersion;
  }

  return normalized;
}


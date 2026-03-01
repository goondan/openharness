import { parseObjectRefString } from "./references.js";

export type ValueSource =
  | {
      value: string;
      valueFrom?: never;
    }
  | {
      value?: never;
      valueFrom: ValueFrom;
    };

export type ValueFrom =
  | {
      env: string;
      secretRef?: never;
    }
  | {
      env?: never;
      secretRef: SecretRef;
    };

export interface SecretRef {
  ref: string;
  key: string;
}

export interface ResolveValueSourceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  resolveSecretRef?: (secretRef: SecretRef) => string | undefined;
  required?: boolean;
}

export function resolveValueSource(valueSource: ValueSource, options: ResolveValueSourceOptions = {}): string | undefined {
  if ("value" in valueSource) {
    return valueSource.value;
  }

  const required = options.required ?? true;
  const source = valueSource.valueFrom;

  if (typeof source.env === "string") {
    const envValue = options.env?.[source.env];
    if (typeof envValue === "string") {
      return envValue;
    }

    if (required) {
      throw new Error(`Missing required environment variable: ${source.env}`);
    }

    return undefined;
  }

  if (source.secretRef === undefined) {
    throw new Error("Invalid ValueSource.valueFrom: secretRef is required.");
  }

  assertSecretRefFormat(source.secretRef);

  const secretValue = options.resolveSecretRef?.(source.secretRef);
  if (typeof secretValue === "string") {
    return secretValue;
  }

  if (required) {
    throw new Error(`Missing required secret value: ${source.secretRef.ref}#${source.secretRef.key}`);
  }

  return undefined;
}

export function isSecretRefPath(value: string): boolean {
  try {
    const parsed = parseObjectRefString(value);
    return parsed.kind === "Secret";
  } catch {
    return false;
  }
}

function assertSecretRefFormat(secretRef: SecretRef): void {
  if (!isSecretRefPath(secretRef.ref)) {
    throw new Error(`Invalid SecretRef.ref format: ${secretRef.ref}`);
  }

  if (secretRef.key.trim().length === 0) {
    throw new Error("Invalid SecretRef.key: key must be non-empty.");
  }
}


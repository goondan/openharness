export interface ParsedToolName {
  resourceName: string;
  exportName: string;
}

export function parseToolName(fullName: string): ParsedToolName | null {
  const separatorIndex = fullName.indexOf("__");
  if (separatorIndex <= 0) {
    return null;
  }

  if (fullName.indexOf("__", separatorIndex + 2) >= 0) {
    return null;
  }

  const resourceName = fullName.slice(0, separatorIndex);
  const exportName = fullName.slice(separatorIndex + 2);

  if (resourceName.length === 0 || exportName.length === 0) {
    return null;
  }

  if (resourceName.includes("__") || exportName.includes("__")) {
    return null;
  }

  return {
    resourceName,
    exportName,
  };
}

export function buildToolName(resourceName: string, exportName: string): string {
  if (resourceName.length === 0 || exportName.length === 0) {
    throw new Error("resourceName and exportName must not be empty");
  }

  if (resourceName.includes("__") || exportName.includes("__")) {
    throw new Error("resourceName and exportName must not include '__'");
  }

  return `${resourceName}__${exportName}`;
}

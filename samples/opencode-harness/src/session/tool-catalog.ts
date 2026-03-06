import type { ToolCatalogItem } from "@goondan/openharness";

function readBaseToolName(name: string): string {
  const separatorIndex = name.indexOf("__");
  return separatorIndex >= 0 ? name.slice(separatorIndex + 2) : name;
}

function shouldUsePatchTool(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes("gpt-") && !normalized.includes("oss") && !normalized.includes("gpt-4");
}

export function filterToolCatalogForModel(toolCatalog: readonly ToolCatalogItem[], modelName: string): ToolCatalogItem[] {
  const usePatchTool = shouldUsePatchTool(modelName);

  return toolCatalog.filter((item) => {
    const baseName = readBaseToolName(item.name);
    if (baseName === "invalid") {
      return false;
    }
    if (baseName === "apply_patch") {
      return usePatchTool;
    }
    if (baseName === "edit" || baseName === "write") {
      return !usePatchTool;
    }
    return true;
  });
}

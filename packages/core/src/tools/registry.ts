import type { ToolCatalogItem, ToolHandler } from "../types.js";
import { parseToolName } from "./naming.js";

interface ToolEntry {
  item: ToolCatalogItem;
  handler: ToolHandler;
}

export interface ToolRegistry {
  register(item: ToolCatalogItem, handler: ToolHandler): void;
  unregister(name: string): void;
  getCatalog(): ToolCatalogItem[];
  has(name: string): boolean;
  getHandler(name: string): ToolHandler | undefined;
}

export class ToolRegistryImpl implements ToolRegistry {
  private readonly entries = new Map<string, ToolEntry>();

  register(item: ToolCatalogItem, handler: ToolHandler): void {
    this.validateCatalogItem(item);

    if (this.entries.has(item.name)) {
      throw new Error(`tool already registered: ${item.name}`);
    }

    this.entries.set(item.name, {
      item: cloneCatalogItem(item),
      handler,
    });
  }

  unregister(name: string): void {
    this.entries.delete(name);
  }

  getCatalog(): ToolCatalogItem[] {
    const catalog: ToolCatalogItem[] = [];
    for (const entry of this.entries.values()) {
      catalog.push(cloneCatalogItem(entry.item));
    }
    return catalog;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  getHandler(name: string): ToolHandler | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      return undefined;
    }

    return entry.handler;
  }

  private validateCatalogItem(item: ToolCatalogItem): void {
    const parsed = parseToolName(item.name);
    if (parsed === null) {
      throw new Error(`invalid tool name: ${item.name}`);
    }
  }
}

function cloneCatalogItem(item: ToolCatalogItem): ToolCatalogItem {
  return {
    name: item.name,
    description: item.description,
    parameters: item.parameters
      ? {
          ...item.parameters,
          properties: item.parameters.properties ? { ...item.parameters.properties } : undefined,
          required: item.parameters.required ? [...item.parameters.required] : undefined,
        }
      : undefined,
    source: item.source
      ? {
          type: item.source.type,
          name: item.source.name,
          mcp: item.source.mcp
            ? {
                extensionName: item.source.mcp.extensionName,
                serverName: item.source.mcp.serverName,
              }
            : undefined,
        }
      : undefined,
  };
}

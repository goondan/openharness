import type {
  ExtensionApi,
  JsonObject,
  JsonValue,
  StepMiddlewareContext,
  ToolCatalogItem,
  ToolContext,
  ToolHandler,
} from '../types.js';
import {
  isJsonObject,
  optionalNumber,
  requireString,
} from '../utils.js';

export interface ToolSearchExtensionConfig {
  toolName?: string;
  maxResults?: number;
  minQueryLength?: number;
  persistSelection?: boolean;
}

interface ToolSearchSnapshotItem {
  name: string;
  description?: string;
}

interface ToolSearchState {
  selectedTools: string[];
  lastQuery?: string;
  catalogSnapshot: ToolSearchSnapshotItem[];
}

const DEFAULT_CONFIG: Required<ToolSearchExtensionConfig> = {
  toolName: 'tool-search__search',
  maxResults: 10,
  minQueryLength: 1,
  persistSelection: true,
};

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      output.push(item);
    }
  }
  return output;
}

function readSnapshot(value: JsonValue | undefined): ToolSearchSnapshotItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const snapshot: ToolSearchSnapshotItem[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) {
      continue;
    }

    const name = item.name;
    const description = item.description;

    if (typeof name !== 'string') {
      continue;
    }

    if (description !== undefined && typeof description !== 'string') {
      continue;
    }

    snapshot.push({ name, description });
  }

  return snapshot;
}

function readState(raw: JsonValue | null): ToolSearchState {
  if (!isJsonObject(raw)) {
    return {
      selectedTools: [],
      catalogSnapshot: [],
    };
  }

  const selectedTools = readStringArray(raw.selectedTools);
  const catalogSnapshot = readSnapshot(raw.catalogSnapshot);
  const lastQuery = typeof raw.lastQuery === 'string' ? raw.lastQuery : undefined;

  return {
    selectedTools,
    catalogSnapshot,
    lastQuery,
  };
}

function writeState(state: ToolSearchState): JsonObject {
  const serializedSnapshot: JsonObject[] = [];
  for (const item of state.catalogSnapshot) {
    const row: JsonObject = { name: item.name };
    if (item.description) {
      row.description = item.description;
    }
    serializedSnapshot.push(row);
  }

  const output: JsonObject = {
    selectedTools: state.selectedTools,
    catalogSnapshot: serializedSnapshot,
  };

  if (state.lastQuery) {
    output.lastQuery = state.lastQuery;
  }

  return output;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function searchSnapshot(
  snapshot: ToolSearchSnapshotItem[],
  query: string,
  limit: number
): ToolSearchSnapshotItem[] {
  if (query.length === 0) {
    return [];
  }

  const matched: ToolSearchSnapshotItem[] = [];
  for (const item of snapshot) {
    const nameMatch = item.name.toLowerCase().includes(query);
    const descriptionMatch = item.description
      ? item.description.toLowerCase().includes(query)
      : false;

    if (!nameMatch && !descriptionMatch) {
      continue;
    }

    matched.push(item);
    if (matched.length >= limit) {
      break;
    }
  }

  return matched;
}

function toJsonResults(items: ToolSearchSnapshotItem[]): JsonObject[] {
  return items.map((item) => {
    const output: JsonObject = {
      name: item.name,
    };
    if (item.description) {
      output.description = item.description;
    }
    return output;
  });
}

function createSearchHandler(
  api: ExtensionApi,
  config: Required<ToolSearchExtensionConfig>
): ToolHandler {
  return async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
    const query = requireString(input, 'query');
    const normalizedQuery = normalizeQuery(query);

    if (normalizedQuery.length < config.minQueryLength) {
      return {
        query,
        results: [],
        selectedTools: [],
      };
    }

    const requestedLimit = optionalNumber(input, 'limit', config.maxResults) ?? config.maxResults;
    const safeLimit = Math.max(1, Math.min(config.maxResults, Math.floor(requestedLimit)));

    const currentState = readState(await api.state.get());
    const results = searchSnapshot(currentState.catalogSnapshot, normalizedQuery, safeLimit);
    const selectedTools = results.map((item) => item.name);

    if (config.persistSelection) {
      const nextState: ToolSearchState = {
        selectedTools,
        catalogSnapshot: currentState.catalogSnapshot,
        lastQuery: query,
      };
      await api.state.set(writeState(nextState));
    }

    return {
      query,
      results: toJsonResults(results),
      selectedTools,
    };
  };
}

function snapshotCatalog(catalog: ToolCatalogItem[]): ToolSearchSnapshotItem[] {
  return catalog.map((item) => ({
    name: item.name,
    description: item.description,
  }));
}

function filterCatalog(
  ctx: StepMiddlewareContext,
  selectedTools: string[],
  searchToolName: string
): void {
  if (selectedTools.length === 0) {
    return;
  }

  const allow = new Set<string>();
  for (const toolName of selectedTools) {
    allow.add(toolName);
  }
  allow.add(searchToolName);

  ctx.toolCatalog = ctx.toolCatalog.filter((item) => allow.has(item.name));
}

function mergeConfig(config?: ToolSearchExtensionConfig): Required<ToolSearchExtensionConfig> {
  return {
    toolName: config?.toolName ?? DEFAULT_CONFIG.toolName,
    maxResults: config?.maxResults ?? DEFAULT_CONFIG.maxResults,
    minQueryLength: config?.minQueryLength ?? DEFAULT_CONFIG.minQueryLength,
    persistSelection: config?.persistSelection ?? DEFAULT_CONFIG.persistSelection,
  };
}

export function registerToolSearchExtension(
  api: ExtensionApi,
  config?: ToolSearchExtensionConfig
): void {
  const settings = mergeConfig(config);

  api.tools.register(
    {
      name: settings.toolName,
      description: 'Search available tools and store next-step catalog selection',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      source: {
        type: 'extension',
        name: 'tool-search',
      },
    },
    createSearchHandler(api, settings)
  );

  api.pipeline.register('step', async (ctx) => {
    const previousState = readState(await api.state.get());

    filterCatalog(ctx, previousState.selectedTools, settings.toolName);

    const nextState: ToolSearchState = {
      selectedTools: previousState.selectedTools,
      lastQuery: previousState.lastQuery,
      catalogSnapshot: snapshotCatalog(ctx.toolCatalog),
    };

    await api.state.set(writeState(nextState));
    return ctx.next();
  });
}

export function register(api: ExtensionApi, config?: ToolSearchExtensionConfig): void {
  registerToolSearchExtension(api, config);
}

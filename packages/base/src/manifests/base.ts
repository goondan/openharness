import type {
  ExtensionManifestSpec,
  JsonObject,
  ResourceManifest,
  ToolManifestSpec,
} from '../types.js';

export type BaseToolManifest = ResourceManifest<'Tool', ToolManifestSpec>;
export type BaseExtensionManifest = ResourceManifest<'Extension', ExtensionManifestSpec>;

export type BaseManifest = BaseToolManifest | BaseExtensionManifest;

function createToolManifest(name: string, spec: ToolManifestSpec): BaseToolManifest {
  return {
    apiVersion: 'goondan.ai/v1',
    kind: 'Tool',
    metadata: {
      name,
      labels: {
        tier: 'base',
      },
    },
    spec,
  };
}

function createExtensionManifest(
  name: string,
  entry: string,
  config?: JsonObject
): BaseExtensionManifest {
  const spec: ExtensionManifestSpec = {
    entry,
  };

  if (config) {
    spec.config = config;
  }

  return {
    apiVersion: 'goondan.ai/v1',
    kind: 'Extension',
    metadata: {
      name,
      labels: {
        tier: 'base',
      },
    },
    spec,
  };
}

function ensureUniqueManifestNames<TManifest extends { metadata: { name: string } }>(
  kind: string,
  manifests: TManifest[]
): TManifest[] {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const name = manifest.metadata.name;
    if (seen.has(name)) {
      throw new Error(`Duplicate ${kind} manifest name: ${name}`);
    }
    seen.add(name);
  }
  return manifests;
}

function ensureUniqueExtensionEntries(manifests: BaseExtensionManifest[]): BaseExtensionManifest[] {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const entry = manifest.spec.entry;
    if (seen.has(entry)) {
      throw new Error(`Duplicate Extension manifest entry: ${entry}`);
    }
    seen.add(entry);
  }
  return manifests;
}

function ensureUniqueManifestIdentities(manifests: BaseManifest[]): BaseManifest[] {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const identity = `${manifest.kind}/${manifest.metadata.name}`;
    if (seen.has(identity)) {
      throw new Error(`Duplicate manifest identity: ${identity}`);
    }
    seen.add(identity);
  }
  return manifests;
}

function createProperty(type: string | string[], description: string, extra: JsonObject = {}): JsonObject {
  return {
    type: Array.isArray(type) ? [...type] : type,
    description,
    ...extra,
  };
}

function stringProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty('string', description, extra);
}

function numberProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty('number', description, extra);
}

function booleanProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty('boolean', description, extra);
}

function objectProperty(description: string, extra: JsonObject = {}): JsonObject {
  return createProperty('object', description, extra);
}

function arrayProperty(description: string, items?: JsonObject, extra: JsonObject = {}): JsonObject {
  const payload: JsonObject = { ...extra };
  if (items) {
    payload.items = items;
  }
  return createProperty('array', description, payload);
}

function createParameters(properties: Record<string, JsonObject>, required: string[] = []): JsonObject {
  const parameters: JsonObject = {
    type: 'object',
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) {
    parameters.required = [...required];
  }

  return parameters;
}

export function createBaseToolManifests(): BaseToolManifest[] {
  return [
    createToolManifest('bash', {
      entry: './src/tools/bash.ts',
      errorMessageLimit: 1200,
      exports: [
        {
          name: 'exec',
          description:
            'Execute one shell command using /bin/sh -lc in the current instance workspace.',
          parameters: createParameters(
            {
              command: stringProperty('Shell command string to execute.'),
              cwd: stringProperty('Optional working directory path relative to the instance workdir.'),
              timeoutMs: numberProperty('Maximum execution time in milliseconds (default: 30000).'),
              env: objectProperty(
                'Optional environment variable overrides merged with process.env before execution.'
              ),
            },
            ['command']
          ),
        },
        {
          name: 'script',
          description: 'Run a script file from workdir with optional arguments and custom shell.',
          parameters: createParameters(
            {
              path: stringProperty('Script file path relative to the instance workdir.'),
              args: arrayProperty(
                'Optional command-line arguments passed to the script in order.',
                stringProperty('Single script argument value.')
              ),
              shell: stringProperty('Shell binary path used to execute the script (default: /bin/bash).'),
              timeoutMs: numberProperty('Maximum execution time in milliseconds (default: 30000).'),
              env: objectProperty(
                'Optional environment variable overrides merged with process.env before execution.'
              ),
            },
            ['path']
          ),
        },
      ],
    }),
    createToolManifest('wait', {
      entry: './src/tools/wait.ts',
      errorMessageLimit: 600,
      exports: [
        {
          name: 'seconds',
          description: 'Pause execution for the specified number of seconds',
          parameters: createParameters(
            {
              seconds: numberProperty('Seconds to wait (range: 0 to 300).'),
            },
            ['seconds']
          ),
        },
      ],
    }),
    createToolManifest('file-system', {
      entry: './src/tools/file-system.ts',
      errorMessageLimit: 2000,
      exports: [
        {
          name: 'read',
          description: 'Read file content from workdir',
          parameters: createParameters(
            {
              path: stringProperty('File path relative to workdir to read.'),
              maxBytes: numberProperty('Maximum bytes to return from file content (default: 100000).'),
            },
            ['path']
          ),
        },
        {
          name: 'write',
          description: 'Write file content in workdir',
          parameters: createParameters(
            {
              path: stringProperty('File path relative to workdir to write. Parent directories are created automatically.'),
              content: stringProperty('UTF-8 text content to write.'),
              append: booleanProperty('When true, append content instead of overwriting the file (default: false).'),
            },
            ['path', 'content']
          ),
        },
        {
          name: 'list',
          description: 'List directory entries',
          parameters: createParameters({
            path: stringProperty('Directory path relative to workdir (default: ".").'),
            recursive: booleanProperty('When true, traverse subdirectories recursively (default: false).'),
            includeDirs: booleanProperty('Include directory entries in result (default: true).'),
            includeFiles: booleanProperty('Include file entries in result (default: true).'),
          }),
        },
        {
          name: 'mkdir',
          description: 'Create directory in workdir',
          parameters: createParameters(
            {
              path: stringProperty('Directory path relative to workdir to create.'),
              recursive: booleanProperty('Create parent directories when missing (default: true).'),
            },
            ['path']
          ),
        },
      ],
    }),
    createToolManifest('http-fetch', {
      entry: './src/tools/http-fetch.ts',
      exports: [
        {
          name: 'get',
          description: 'Perform HTTP GET request',
          parameters: createParameters(
            {
              url: stringProperty('HTTP/HTTPS URL to request.'),
              headers: objectProperty('Optional request headers object. Primitive values are stringified.'),
              timeoutMs: numberProperty('Request timeout in milliseconds (default: 30000).'),
              maxBytes: numberProperty('Maximum response body bytes returned (default: 500000).'),
            },
            ['url']
          ),
        },
        {
          name: 'post',
          description: 'Perform HTTP POST request',
          parameters: createParameters(
            {
              url: stringProperty('HTTP/HTTPS URL to request.'),
              body: objectProperty(
                'JSON body object. When provided, it is stringified and content-type defaults to application/json.'
              ),
              bodyString: stringProperty('Raw string request body. Ignored when body is provided.'),
              headers: objectProperty('Optional request headers object. Primitive values are stringified.'),
              timeoutMs: numberProperty('Request timeout in milliseconds (default: 30000).'),
              maxBytes: numberProperty('Maximum response body bytes returned (default: 500000).'),
            },
            ['url']
          ),
        },
      ],
    }),
    createToolManifest('json-query', {
      entry: './src/tools/json-query.ts',
      exports: [
        {
          name: 'query',
          description: 'Query JSON data by dot-notation path',
          parameters: createParameters(
            {
              data: stringProperty('Input JSON string to parse and query.'),
              path: stringProperty('Dot/bracket path expression. Defaults to "." for root.'),
            },
            ['data']
          ),
        },
        {
          name: 'pick',
          description: 'Pick specific keys from JSON object',
          parameters: createParameters(
            {
              data: stringProperty('Input JSON string expected to be an object.'),
              keys: arrayProperty('Object keys to pick from parsed JSON object.', stringProperty('Key name to pick.')),
            },
            ['data', 'keys']
          ),
        },
        {
          name: 'count',
          description: 'Count elements at a JSON path',
          parameters: createParameters(
            {
              data: stringProperty('Input JSON string to parse.'),
              path: stringProperty('Dot/bracket path expression to count at. Defaults to "." for root.'),
            },
            ['data']
          ),
        },
        {
          name: 'flatten',
          description: 'Flatten nested JSON arrays',
          parameters: createParameters(
            {
              data: stringProperty('Input JSON string expected to be an array.'),
              depth: numberProperty('Flatten depth level (default: 1).'),
            },
            ['data']
          ),
        },
      ],
    }),
    createToolManifest('text-transform', {
      entry: './src/tools/text-transform.ts',
      exports: [
        {
          name: 'replace',
          description: 'Replace text occurrences',
          parameters: createParameters(
            {
              text: stringProperty('Source text to transform.'),
              search: stringProperty('Search string to find in text.'),
              replacement: stringProperty('Replacement string (default: empty string).'),
              all: booleanProperty('Replace all occurrences instead of first occurrence only.'),
            },
            ['text', 'search']
          ),
        },
        {
          name: 'slice',
          description: 'Extract substring by start/end positions',
          parameters: createParameters(
            {
              text: stringProperty('Source text to slice.'),
              start: numberProperty('Start index (default: 0).'),
              end: numberProperty('Optional end index (exclusive).'),
            },
            ['text']
          ),
        },
        {
          name: 'split',
          description: 'Split text by delimiter',
          parameters: createParameters(
            {
              text: stringProperty('Source text to split.'),
              delimiter: stringProperty('Delimiter string (default: newline).'),
              maxParts: numberProperty('Optional maximum number of split parts to return.'),
            },
            ['text']
          ),
        },
        {
          name: 'join',
          description: 'Join array of strings with delimiter',
          parameters: createParameters(
            {
              parts: arrayProperty(
                'List of values to join into a single string.',
                createProperty(
                  ['string', 'number', 'boolean'],
                  'Part value. Numbers/booleans are stringified before join.'
                )
              ),
              delimiter: stringProperty('Delimiter string inserted between parts (default: newline).'),
            },
            ['parts']
          ),
        },
        {
          name: 'trim',
          description: 'Trim whitespace from text',
          parameters: createParameters(
            {
              text: stringProperty('Source text to trim.'),
              mode: stringProperty('Trim mode (default: both).', {
                enum: ['start', 'end', 'both'],
              }),
            },
            ['text']
          ),
        },
        {
          name: 'case',
          description: 'Transform text case (upper/lower)',
          parameters: createParameters(
            {
              text: stringProperty('Source text to transform.'),
              to: stringProperty('Target case transform mode.', {
                enum: ['upper', 'lower'],
              }),
            },
            ['text', 'to']
          ),
        },
      ],
    }),
  ];
}

export function createBaseExtensionManifests(): BaseExtensionManifest[] {
  return ensureUniqueExtensionEntries(
    ensureUniqueManifestNames('Extension', [
      createExtensionManifest('logging', './src/extensions/logging.ts', {
        level: 'info',
        includeToolArgs: false,
      }),
      createExtensionManifest('message-compaction', './src/extensions/compaction.ts', {
        maxMessages: 40,
        maxCharacters: 12000,
        retainLastMessages: 8,
        mode: 'remove',
        appendSummary: true,
      }),
      createExtensionManifest('message-window', './src/extensions/message-window.ts', {
        maxMessages: 80,
      }),
      createExtensionManifest('tool-search', './src/extensions/tool-search.ts', {
        toolName: 'tool-search__search',
        maxResults: 10,
        minQueryLength: 1,
        persistSelection: true,
      }),
      createExtensionManifest('context-message', './src/extensions/context-message.ts', {
        includeAgentPrompt: true,
        includeSwarmCatalog: false,
        includeRouteSummary: false,
        includeInboundInput: true,
      }),
      createExtensionManifest('required-tools-guard', './src/extensions/required-tools-guard.ts', {
        requiredTools: [],
        errorMessage: '',
      }),
      createExtensionManifest('inter-agent-response-format', './src/extensions/inter-agent-response-format.ts'),
    ])
  );
}

export function createBaseManifestSet(): BaseManifest[] {
  return ensureUniqueManifestIdentities([
    ...createBaseToolManifests(),
    ...createBaseExtensionManifests(),
  ]);
}

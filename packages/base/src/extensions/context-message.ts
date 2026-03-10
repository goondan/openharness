import { createHash } from 'node:crypto';

import type { ExtensionApi, InboundContentPart, JsonObject, JsonValue, Message, TurnMiddlewareContext } from '../types.js';
import { createId, isJsonObject } from '../utils.js';

const EXTENSION_NAME = 'context-message';
const EXTENSION_EVENTS_METADATA_KEY = 'extension.events';
const CONTEXT_MESSAGE_MARKER_KEY = '__goondanContextMessage';
const INBOUND_MESSAGE_METADATA_KEY = '__goondanInbound';

interface RuntimeAgentPromptMetadata {
  system?: string;
}

interface RuntimeAgentMetadata {
  prompt?: RuntimeAgentPromptMetadata;
}

interface ContextMessageMarker {
  promptHash: string;
  role?: ContextMessageRole;
  segmentIds?: string[];
}

type ContextMessageRole = 'system' | 'user';

interface ContextSegment {
  id: string;
  role: ContextMessageRole;
  content: string;
}

interface SegmentResolution {
  id: string;
  included: boolean;
}

export interface ContextMessageExtensionConfig {
  includeAgentPrompt?: boolean;
  includeInboundContext?: boolean;
  includeRouteSummary?: boolean;
  includeInboundInput?: boolean;
}

const DEFAULT_CONFIG: Required<ContextMessageExtensionConfig> = {
  includeAgentPrompt: true,
  includeInboundContext: false,
  includeRouteSummary: false,
  includeInboundInput: true,
};

function readConfig(raw: unknown): Required<ContextMessageExtensionConfig> {
  if (!isJsonObject(raw)) {
    return { ...DEFAULT_CONFIG };
  }

  const config: Required<ContextMessageExtensionConfig> = { ...DEFAULT_CONFIG };
  if (typeof raw.includeAgentPrompt === 'boolean') {
    config.includeAgentPrompt = raw.includeAgentPrompt;
  }
  if (typeof raw.includeInboundContext === 'boolean') {
    config.includeInboundContext = raw.includeInboundContext;
  }
  if (typeof raw.includeRouteSummary === 'boolean') {
    config.includeRouteSummary = raw.includeRouteSummary;
  }
  if (typeof raw.includeInboundInput === 'boolean') {
    config.includeInboundInput = raw.includeInboundInput;
  }
  return config;
}

function createPromptHash(input: { role: ContextMessageRole; content: string }): string {
  return createHash('sha256').update(`${input.role}\n${input.content}`).digest('hex');
}

function readPromptHashMarker(message: Message): string | undefined {
  const marker = readContextMessageMarker(message);
  return marker?.promptHash;
}

function readContextMessageMarker(message: Message): ContextMessageMarker | undefined {
  if (!isJsonObject(message.metadata)) {
    return undefined;
  }

  const rawMarker = message.metadata[CONTEXT_MESSAGE_MARKER_KEY];
  if (!isJsonObject(rawMarker)) {
    return undefined;
  }

  const promptHash = rawMarker.promptHash;
  if (typeof promptHash !== 'string' || promptHash.length === 0) {
    return undefined;
  }

  const marker: ContextMessageMarker = {
    promptHash,
  };
  if (rawMarker.role === 'system' || rawMarker.role === 'user') {
    marker.role = rawMarker.role;
  }
  if (Array.isArray(rawMarker.segmentIds)) {
    marker.segmentIds = rawMarker.segmentIds
      .filter((segmentId): segmentId is string => typeof segmentId === 'string' && segmentId.length > 0);
  }
  return marker;
}

function markerIncludesSegment(marker: ContextMessageMarker | undefined, segmentId: string): boolean {
  if (!marker || !Array.isArray(marker.segmentIds)) {
    return false;
  }
  return marker.segmentIds.includes(segmentId);
}

function hasPromptHashMarker(
  messages: Message[],
  promptHash: string,
  role: ContextMessageRole,
  content: string,
): boolean {
  for (const message of messages) {
    const existingHash = readPromptHashMarker(message);
    if (existingHash === promptHash) {
      return true;
    }

    if (
      message.source.type === 'extension'
      && message.source.extensionName === EXTENSION_NAME
      && message.data.role === role
      && message.data.content === content
    ) {
      return true;
    }
  }

  return false;
}

function createMessageMarker(promptHash: string, role: ContextMessageRole, segmentIds: string[]): JsonObject {
  const marker: JsonObject = {
    promptHash,
    role,
    segmentIds,
  };
  return marker;
}

function createContextMessage(
  promptHash: string,
  role: ContextMessageRole,
  content: string,
  segmentIds: string[],
): Message {
  const metadata: Record<string, JsonValue> = {
    [CONTEXT_MESSAGE_MARKER_KEY]: createMessageMarker(promptHash, role, segmentIds),
  };
  if (role === 'system') {
    metadata.pinned = true;
  }

  return {
    id: createId('msg'),
    data: {
      role,
      content,
    },
    metadata,
    createdAt: new Date(),
    source: {
      type: 'extension',
      extensionName: EXTENSION_NAME,
    },
  };
}

function createInboundInputMetadata(ctx: TurnMiddlewareContext): Record<string, JsonValue> {
  const inbound = ctx.runtime.inbound;
  const payload: Record<string, JsonValue> = {
    sourceKind: inbound.kind,
    sourceName: inbound.sourceName,
    eventName: inbound.eventType,
  };
  if (typeof inbound.connectionName === 'string' && inbound.connectionName.length > 0) {
    payload.connectionName = inbound.connectionName;
  }
  if (typeof inbound.conversationId === 'string' && inbound.conversationId.length > 0) {
    payload.conversationId = inbound.conversationId;
  }
  if (inbound.kind === 'connector') {
    if (Object.keys(inbound.properties).length > 0) {
      payload.properties = inbound.properties as unknown as JsonValue;
    }
    if (ctx.inputEvent.rawPayload !== undefined) {
      payload.rawPayload = ctx.inputEvent.rawPayload;
    }
  }
  return {
    [INBOUND_MESSAGE_METADATA_KEY]: payload,
  };
}

function createInboundInputMessage(ctx: TurnMiddlewareContext, content: string): Message {
  return {
    id: createId('msg'),
    data: {
      role: 'user',
      content,
    },
    metadata: createInboundInputMetadata(ctx),
    createdAt: new Date(),
    source: {
      type: 'user',
    },
  };
}

function renderInboundParts(parts: InboundContentPart[]): string {
  const textBlocks: string[] = [];
  const attachmentBlocks: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      const trimmed = part.text.trim();
      if (trimmed.length > 0) {
        textBlocks.push(trimmed);
      }
      continue;
    }

    if (part.type === 'image') {
      const label = typeof part.alt === 'string' && part.alt.trim().length > 0 ? ` ${part.alt.trim()}` : '';
      attachmentBlocks.push(`[image]${label} ${part.url}`.trim());
      continue;
    }

    const mimeLabel = typeof part.mimeType === 'string' && part.mimeType.trim().length > 0
      ? ` (${part.mimeType.trim()})`
      : '';
    attachmentBlocks.push(`[file] ${part.name}${mimeLabel}: ${part.url}`);
  }

  return [...textBlocks, ...attachmentBlocks].join('\n\n').trim();
}

function appendRuntimeEvent(
  ctx: TurnMiddlewareContext,
  name: string,
  data: JsonObject | undefined = undefined,
): void {
  const entries: JsonValue[] = Array.isArray(ctx.metadata[EXTENSION_EVENTS_METADATA_KEY])
    ? [...ctx.metadata[EXTENSION_EVENTS_METADATA_KEY]]
    : [];

  const entry: JsonObject = {
    name,
    actor: EXTENSION_NAME,
    at: new Date().toISOString(),
  };
  if (data !== undefined && Object.keys(data).length > 0) {
    entry.data = data;
  }

  entries.push(entry);
  ctx.metadata[EXTENSION_EVENTS_METADATA_KEY] = entries;
}

function resolveAgentPrompt(metadata: RuntimeAgentMetadata): string | null {
  const prompt = metadata.prompt;
  if (!prompt) {
    return null;
  }

  const inlinePrompt = typeof prompt.system === 'string' && prompt.system.trim().length > 0
    ? prompt.system
    : undefined;
  if (!inlinePrompt) {
    return null;
  }

  return inlinePrompt;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function resolveInboundContextSegment(ctx: TurnMiddlewareContext): ContextSegment {
  const inbound = ctx.runtime.inbound;
  const lines: string[] = [
    '[runtime_inbound]',
    `eventId=${inbound.eventId}`,
    `eventType=${inbound.eventType}`,
    `kind=${inbound.kind}`,
    `sourceName=${inbound.sourceName}`,
    `createdAt=${inbound.createdAt}`,
  ];
  if (typeof inbound.connectionName === 'string' && inbound.connectionName.length > 0) {
    lines.push(`connectionName=${inbound.connectionName}`);
  }
  if (typeof inbound.conversationId === 'string' && inbound.conversationId.length > 0) {
    lines.push(`conversationId=${inbound.conversationId}`);
  }
  if (Object.keys(inbound.properties).length > 0) {
    lines.push(`properties=${JSON.stringify(inbound.properties)}`);
  }
  if (inbound.content.length > 0) {
    lines.push(`content=${JSON.stringify(inbound.content)}`);
  }
  if (inbound.rawPayload !== undefined) {
    lines.push(`rawPayload=${JSON.stringify(inbound.rawPayload)}`);
  }
  lines.push('[/runtime_inbound]');

  return {
    id: 'runtime.inbound',
    role: 'user',
    content: lines.join('\n'),
  };
}

function resolveRouteSummarySegment(ctx: TurnMiddlewareContext): ContextSegment {
  const inbound = ctx.runtime.inbound;
  const inboundConversationId = stringOrUndefined(inbound.conversationId);

  const lines: string[] = [
    '[runtime_route]',
    'precedence=inbound',
    `senderKind=${inbound.kind}`,
    `senderName=${inbound.sourceName}`,
    `eventType=${inbound.eventType}`,
    `eventId=${inbound.eventId}`,
  ];
  if (inboundConversationId) {
    lines.push(`senderConversationId=${inboundConversationId}`);
  }
  lines.push('[/runtime_route]');

  return {
    id: 'runtime.route.summary',
    role: 'user',
    content: lines.join('\n'),
  };
}

const SEGMENT_ORDER: string[] = [
  'agent.prompt.system',
  'runtime.inbound',
  'runtime.route.summary',
];

function sortSegmentsByOrder(segments: ContextSegment[]): ContextSegment[] {
  const order = new Map<string, number>();
  SEGMENT_ORDER.forEach((id, index) => {
    order.set(id, index);
  });

  return [...segments].sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function resolveContextSegments(
  ctx: TurnMiddlewareContext,
  config: Required<ContextMessageExtensionConfig>,
): {
  resolutions: SegmentResolution[];
  segments: ContextSegment[];
} {
  const resolutions: SegmentResolution[] = [];
  const segments: ContextSegment[] = [];

  if (config.includeAgentPrompt) {
    const system = resolveAgentPrompt({ prompt: ctx.runtime.agent.prompt });
    if (system && system.trim().length > 0) {
      segments.push({
        id: 'agent.prompt.system',
        role: 'system',
        content: system,
      });
      resolutions.push({ id: 'agent.prompt.system', included: true });
    } else {
      resolutions.push({ id: 'agent.prompt.system', included: false });
    }
  }

  if (config.includeInboundContext) {
    segments.push(resolveInboundContextSegment(ctx));
    resolutions.push({ id: 'runtime.inbound', included: true });
  }

  if (config.includeRouteSummary && config.includeInboundContext) {
    segments.push(resolveRouteSummarySegment(ctx));
    resolutions.push({ id: 'runtime.route.summary', included: true });
  }

  return {
    resolutions,
    segments: sortSegmentsByOrder(segments),
  };
}

interface ContextMessageGroup {
  role: ContextMessageRole;
  content: string;
  segmentIds: string[];
}

function composeMessageGroups(segments: ContextSegment[]): ContextMessageGroup[] {
  const groups: ContextMessageGroup[] = [];
  for (const segment of segments) {
    const last = groups[groups.length - 1];
    if (last && last.role === segment.role) {
      last.content = `${last.content}\n\n${segment.content}`;
      last.segmentIds.push(segment.id);
      continue;
    }

    groups.push({
      role: segment.role,
      content: segment.content,
      segmentIds: [segment.id],
    });
  }

  return groups;
}

async function emitContextMessages(
  ctx: TurnMiddlewareContext,
  config: Required<ContextMessageExtensionConfig>,
): Promise<void> {
  const composed = resolveContextSegments(ctx, config);
  for (const resolution of composed.resolutions) {
    appendRuntimeEvent(ctx, 'context.segment.resolved', {
      id: resolution.id,
      included: resolution.included,
    });
  }

  if (composed.segments.length === 0) {
    appendRuntimeEvent(ctx, 'context.message.empty');
    return;
  }

  const existingMessages = ctx.conversationState.nextMessages;
  const groups = composeMessageGroups(composed.segments);
  const desiredSystemGroup = groups.find(
    (group) => group.role === 'system' && group.segmentIds.includes('agent.prompt.system'),
  );
  const desiredSystemHash = desiredSystemGroup
    ? createPromptHash({ role: desiredSystemGroup.role, content: desiredSystemGroup.content })
    : undefined;
  const pendingGroups: Array<{
    group: ContextMessageGroup;
    promptHash: string;
  }> = [];
  for (const group of groups) {
    const promptHash = createPromptHash({ role: group.role, content: group.content });
    if (hasPromptHashMarker(existingMessages, promptHash, group.role, group.content)) {
      appendRuntimeEvent(ctx, 'context.message.duplicate', {
        promptHash,
        role: group.role,
      });
      continue;
    }
    pendingGroups.push({ group, promptHash });
  }

  let emittedContextMutation = false;
  if (desiredSystemGroup && desiredSystemHash) {
    const existingSystems = existingMessages
      .filter((message) => message.data.role === 'system')
      .map((message) => ({
        message,
        marker: readContextMessageMarker(message),
      }));

    if (existingSystems.length > 0) {
      const preferred = existingSystems.find((entry) => entry.marker?.promptHash === desiredSystemHash)
        ?? existingSystems.find((entry) => markerIncludesSegment(entry.marker, 'agent.prompt.system'))
        ?? existingSystems[0];

      if (preferred) {
        const targetMessage = preferred.message;
        const targetMarker = preferred.marker;
        const targetMatchesDesired = targetMarker?.promptHash === desiredSystemHash
          || targetMessage.data.content === desiredSystemGroup.content;

        if (!targetMatchesDesired) {
          ctx.emitMessageEvent({
            type: 'replace',
            targetId: targetMessage.id,
            message: createContextMessage(
              desiredSystemHash,
              'system',
              desiredSystemGroup.content,
              desiredSystemGroup.segmentIds,
            ),
          });
          appendRuntimeEvent(ctx, 'context.message.replaced', {
            targetId: targetMessage.id,
            promptHash: desiredSystemHash,
            role: 'system',
            segmentIds: desiredSystemGroup.segmentIds,
          });
          emittedContextMutation = true;
        }

        for (const entry of existingSystems) {
          if (entry.message.id === targetMessage.id) {
            continue;
          }
          ctx.emitMessageEvent({
            type: 'remove',
            targetId: entry.message.id,
          });
          appendRuntimeEvent(ctx, 'context.message.removed', {
            targetId: entry.message.id,
            role: 'system',
          });
          emittedContextMutation = true;
        }

        const duplicateSystemIndex = pendingGroups.findIndex((pending) =>
          pending.group.role === 'system' && pending.group.segmentIds.includes('agent.prompt.system'));
        if (duplicateSystemIndex >= 0) {
          pendingGroups.splice(duplicateSystemIndex, 1);
        }
      }
    }
  }

  for (const pending of pendingGroups) {
    const group = pending.group;
    ctx.emitMessageEvent({
      type: 'append',
      message: createContextMessage(
        pending.promptHash,
        group.role,
        group.content,
        group.segmentIds,
      ),
    });

    appendRuntimeEvent(ctx, 'context.message.appended', {
      promptHash: pending.promptHash,
      role: group.role,
      segmentIds: group.segmentIds,
    });
    emittedContextMutation = true;
  }

  const renderedInboundInput = ctx.runtime.inbound.kind === 'connector'
    ? renderInboundParts(ctx.runtime.inbound.content)
    : '';
  const inboundInput = renderedInboundInput.trim().length > 0
    ? renderedInboundInput
    : (typeof ctx.inputEvent.input === 'string' ? ctx.inputEvent.input : '');
  if (config.includeInboundInput && inboundInput.trim().length > 0) {
    ctx.emitMessageEvent({
      type: 'append',
      message: createInboundInputMessage(ctx, inboundInput),
    });
    appendRuntimeEvent(ctx, 'context.inbound.appended');
  }

  if (!emittedContextMutation) {
    appendRuntimeEvent(ctx, 'context.message.empty');
  }
}

export function register(api: ExtensionApi, rawConfig?: unknown): void {
  const config = readConfig(rawConfig);

  api.pipeline.register('turn', async (ctx) => {
    await emitContextMessages(ctx, config);
    return ctx.next();
  });
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ConversationStateImpl, applyMessageEvents } from "../conversation/state.js";
import type { RuntimeEvent } from "../events/runtime-events.js";
import type {
  CoreMessage,
  JsonValue,
  Message,
  MessageEvent,
} from "../types.js";
import { isJsonObject } from "../types.js";
import { WorkspacePaths } from "./paths.js";

export interface InstanceMetadata {
  status: "idle" | "processing";
  agentName: string;
  instanceKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoadedConversation {
  baseMessages: Message[];
  events: MessageEvent[];
  nextMessages: Message[];
}

export class FileWorkspaceStorage {
  constructor(private readonly paths: WorkspacePaths) {}

  async initializeSystemRoot(): Promise<void> {
    await fs.mkdir(this.paths.packagesDir, { recursive: true });
    await fs.mkdir(path.join(this.paths.goondanHome, "workspaces"), { recursive: true });

    try {
      await fs.access(this.paths.configFile);
    } catch {
      await fs.writeFile(this.paths.configFile, "{}\n", "utf8");
    }
  }

  async initializeInstanceState(instanceKey: string, agentName: string): Promise<void> {
    const instanceDir = this.paths.instancePath(instanceKey);
    const messagesDir = path.join(instanceDir, "messages");
    const extensionsDir = path.join(instanceDir, "extensions");

    await fs.mkdir(messagesDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    const metadataPath = this.paths.instanceMetadataPath(instanceKey);
    const now = new Date().toISOString();

    const metadata: InstanceMetadata = {
      status: "idle",
      agentName,
      instanceKey,
      createdAt: now,
      updatedAt: now,
    };

    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await ensureFile(this.paths.instanceMessageBasePath(instanceKey));
    await ensureFile(this.paths.instanceMessageEventsPath(instanceKey));
    await ensureFile(this.paths.instanceRuntimeEventsPath(instanceKey));
  }

  async loadConversation(instanceKey: string): Promise<LoadedConversation> {
    const baseMessages = await this.readBaseMessages(instanceKey);
    const events = await this.readEvents(instanceKey);
    const applied = applyMessageEvents(baseMessages, events);

    return {
      baseMessages,
      events,
      nextMessages: applied.messages,
    };
  }

  async createConversationState(instanceKey: string): Promise<ConversationStateImpl> {
    const loaded = await this.loadConversation(instanceKey);
    return new ConversationStateImpl(loaded.baseMessages, loaded.events);
  }

  async appendMessageEvent(instanceKey: string, event: MessageEvent): Promise<void> {
    const eventPath = this.paths.instanceMessageEventsPath(instanceKey);
    await ensureParentDir(eventPath);

    const serialized = JSON.stringify(serializeMessageEvent(event));
    await fs.appendFile(eventPath, `${serialized}\n`, "utf8");
  }

  async appendRuntimeEvent(instanceKey: string, event: RuntimeEvent): Promise<void> {
    const runtimeEventPath = this.paths.instanceRuntimeEventsPath(instanceKey);
    await ensureParentDir(runtimeEventPath);

    await fs.appendFile(runtimeEventPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async foldEventsToBase(instanceKey: string): Promise<void> {
    const baseMessages = await this.readBaseMessages(instanceKey);
    const events = await this.readEvents(instanceKey);
    const applied = applyMessageEvents(baseMessages, events);

    await this.writeBaseMessages(instanceKey, applied.messages, baseMessages, events);
    await this.clearEvents(instanceKey);
  }

  /**
   * Write base messages according to spec (workspace.md §7.3.1, §2.4).
   *
   * Strategy:
   * - Prefer delta append if possible (SHOULD)
   * - Use full rewrite only on mutation (replace/remove/truncate)
   *
   * Delta append condition:
   * - All events are "append" type
   * - newMessages = oldMessages + appendedMessages
   */
  async writeBaseMessages(
    instanceKey: string,
    newMessages: Message[],
    oldMessages?: Message[],
    events?: MessageEvent[],
  ): Promise<void> {
    const basePath = this.paths.instanceMessageBasePath(instanceKey);
    await ensureParentDir(basePath);

    // Check if we can use delta append
    const canDeltaAppend =
      oldMessages !== undefined &&
      events !== undefined &&
      events.length > 0 &&
      events.every((e) => e.type === "append") &&
      newMessages.length === oldMessages.length + events.length;

    if (canDeltaAppend) {
      // Delta append: only write new messages
      const appendCount = events.length;
      const appendedMessages = newMessages.slice(-appendCount);
      const lines = appendedMessages.map((message) => JSON.stringify(serializeMessage(message)));
      const content = `${lines.join("\n")}\n`;
      await fs.appendFile(basePath, content, "utf8");
    } else {
      // Full rewrite (mutation detected or no optimization possible)
      const lines = newMessages.map((message) => JSON.stringify(serializeMessage(message)));
      const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";

      const tempPath = `${basePath}.tmp`;
      await fs.writeFile(tempPath, content, "utf8");
      await fs.rename(tempPath, basePath);
    }
  }

  async clearEvents(instanceKey: string): Promise<void> {
    const eventPath = this.paths.instanceMessageEventsPath(instanceKey);
    await ensureParentDir(eventPath);
    await fs.writeFile(eventPath, "", "utf8");
  }

  async readExtensionState(instanceKey: string, extensionName: string): Promise<Record<string, JsonValue> | undefined> {
    const statePath = this.paths.instanceExtensionStatePath(instanceKey, extensionName);

    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isJsonObject(parsed)) {
        return undefined;
      }

      return parsed;
    } catch {
      return undefined;
    }
  }

  async writeExtensionState(
    instanceKey: string,
    extensionName: string,
    state: Record<string, JsonValue>,
  ): Promise<void> {
    const statePath = this.paths.instanceExtensionStatePath(instanceKey, extensionName);
    await ensureParentDir(statePath);

    const nextSerialized = JSON.stringify(state, null, 2);
    const previous = await this.readExtensionState(instanceKey, extensionName);
    if (previous !== undefined) {
      const previousSerialized = JSON.stringify(previous, null, 2);
      if (previousSerialized === nextSerialized) {
        return;
      }
    }

    await fs.writeFile(statePath, `${nextSerialized}\n`, "utf8");
  }

  async readMetadata(instanceKey: string): Promise<InstanceMetadata | undefined> {
    const metadataPath = this.paths.instanceMetadataPath(instanceKey);

    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isInstanceMetadata(parsed)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  async updateMetadataStatus(instanceKey: string, status: "idle" | "processing"): Promise<void> {
    const metadata = await this.readMetadata(instanceKey);
    if (metadata === undefined) {
      return;
    }

    metadata.status = status;
    metadata.updatedAt = new Date().toISOString();

    const metadataPath = this.paths.instanceMetadataPath(instanceKey);
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  private async readBaseMessages(instanceKey: string): Promise<Message[]> {
    const basePath = this.paths.instanceMessageBasePath(instanceKey);
    await ensureFile(basePath);
    return readJsonl(basePath, deserializeMessage);
  }

  private async readEvents(instanceKey: string): Promise<MessageEvent[]> {
    const eventsPath = this.paths.instanceMessageEventsPath(instanceKey);
    await ensureFile(eventsPath);
    return readJsonl(eventsPath, deserializeMessageEvent);
  }
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function ensureFile(filePath: string): Promise<void> {
  await ensureParentDir(filePath);
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, "", "utf8");
  }
}

async function readJsonl<T>(filePath: string, deserialize: (value: unknown) => T | undefined): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  if (raw.trim().length === 0) {
    return [];
  }

  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const result: T[] = [];
  for (const row of rows) {
    const parsed: unknown = JSON.parse(row);
    const value = deserialize(parsed);
    if (value !== undefined) {
      result.push(value);
    }
  }

  return result;
}

function serializeMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    data: { ...message.data },
    metadata: { ...message.metadata },
    createdAt: message.createdAt.toISOString(),
    source: serializeMessageSource(message.source),
  };
}

function serializeMessageSource(source: Message["source"]): Record<string, unknown> {
  if (source.type === "assistant") {
    return { type: "assistant", stepId: source.stepId };
  }

  if (source.type === "tool") {
    return {
      type: "tool",
      toolCallId: source.toolCallId,
      toolName: source.toolName,
    };
  }

  if (source.type === "extension") {
    return {
      type: "extension",
      extensionName: source.extensionName,
    };
  }

  if (source.type === "system") {
    return { type: "system" };
  }

  return { type: "user" };
}

function deserializeMessage(value: unknown): Message | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  if (typeof value.id !== "string" || !isJsonObject(value.data) || !isJsonObject(value.metadata)) {
    return undefined;
  }

  if (typeof value.createdAt !== "string" || !isJsonObject(value.source) || typeof value.source.type !== "string") {
    return undefined;
  }

  const source = deserializeMessageSource(value.source);
  if (source === undefined) {
    return undefined;
  }

  const role = value.data.role;
  if (typeof role !== "string") {
    return undefined;
  }

  if (!("content" in value.data)) {
    return undefined;
  }

  const coreMessage: CoreMessage = {
    role,
    content: value.data.content,
  };

  return {
    id: value.id,
    data: coreMessage,
    metadata: value.metadata,
    createdAt: new Date(value.createdAt),
    source,
  };
}

function deserializeMessageSource(source: Record<string, unknown>): Message["source"] | undefined {
  if (source.type === "assistant") {
    if (typeof source.stepId !== "string") {
      return undefined;
    }
    return { type: "assistant", stepId: source.stepId };
  }

  if (source.type === "tool") {
    if (typeof source.toolCallId !== "string" || typeof source.toolName !== "string") {
      return undefined;
    }
    return {
      type: "tool",
      toolCallId: source.toolCallId,
      toolName: source.toolName,
    };
  }

  if (source.type === "extension") {
    if (typeof source.extensionName !== "string") {
      return undefined;
    }
    return {
      type: "extension",
      extensionName: source.extensionName,
    };
  }

  if (source.type === "system") {
    return { type: "system" };
  }

  if (source.type === "user") {
    return { type: "user" };
  }

  return undefined;
}

function serializeMessageEvent(event: MessageEvent): Record<string, unknown> {
  if (event.type === "append") {
    return {
      type: "append",
      message: serializeMessage(event.message),
    };
  }

  if (event.type === "replace") {
    return {
      type: "replace",
      targetId: event.targetId,
      message: serializeMessage(event.message),
    };
  }

  if (event.type === "remove") {
    return {
      type: "remove",
      targetId: event.targetId,
    };
  }

  return {
    type: "truncate",
  };
}

function deserializeMessageEvent(value: unknown): MessageEvent | undefined {
  if (!isJsonObject(value) || typeof value.type !== "string") {
    return undefined;
  }

  if (value.type === "append") {
    const message = deserializeMessage(value.message);
    if (message === undefined) {
      return undefined;
    }
    return {
      type: "append",
      message,
    };
  }

  if (value.type === "replace") {
    if (typeof value.targetId !== "string") {
      return undefined;
    }

    const message = deserializeMessage(value.message);
    if (message === undefined) {
      return undefined;
    }

    return {
      type: "replace",
      targetId: value.targetId,
      message,
    };
  }

  if (value.type === "remove") {
    if (typeof value.targetId !== "string") {
      return undefined;
    }

    return {
      type: "remove",
      targetId: value.targetId,
    };
  }

  if (value.type === "truncate") {
    return { type: "truncate" };
  }

  return undefined;
}

function isInstanceMetadata(value: unknown): value is InstanceMetadata {
  if (!isJsonObject(value)) {
    return false;
  }

  if (value.status !== "idle" && value.status !== "processing") {
    return false;
  }

  return (
    typeof value.agentName === "string" &&
    typeof value.instanceKey === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

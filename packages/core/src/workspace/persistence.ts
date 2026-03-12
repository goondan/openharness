import type {
  ConversationMetadata,
  ConversationStore,
  JsonObject,
  LoadedConversationState,
  MessageEvent,
  RuntimeEventRecord,
  RuntimeEventStore,
  WorkspacePersistence,
} from "../types.js";
import { FileWorkspaceStorage } from "./storage.js";
import { WorkspacePaths, type WorkspacePathsOptions } from "./paths.js";

export interface FileWorkspacePersistenceOptions extends WorkspacePathsOptions {}

export class FileConversationStore implements ConversationStore {
  constructor(private readonly storage: FileWorkspaceStorage) {}

  async ensureConversation(input: { conversationId: string; agentName: string }): Promise<ConversationMetadata> {
    const existing = await this.storage.readMetadata(input.conversationId);
    if (existing !== undefined) {
      return existing;
    }

    await this.storage.initializeInstanceState(input.conversationId, input.agentName);
    const created = await this.storage.readMetadata(input.conversationId);
    if (created === undefined) {
      throw new Error(`conversation metadata를 생성하지 못했습니다: ${input.conversationId}`);
    }

    return created;
  }

  async loadState(input: { conversationId: string }): Promise<LoadedConversationState> {
    const loaded = await this.storage.loadConversation(input.conversationId);
    return {
      baseMessages: loaded.baseMessages,
      events: loaded.events,
    };
  }

  async appendMessageEvents(input: { conversationId: string; events: MessageEvent[] }): Promise<void> {
    for (const event of input.events) {
      await this.storage.appendMessageEvent(input.conversationId, event);
    }
  }

  async readExtensionState(input: { conversationId: string; extensionName: string }): Promise<JsonObject | null> {
    return (await this.storage.readExtensionState(input.conversationId, input.extensionName)) ?? null;
  }

  async writeExtensionState(input: {
    conversationId: string;
    extensionName: string;
    value: JsonObject;
  }): Promise<void> {
    await this.storage.writeExtensionState(input.conversationId, input.extensionName, input.value);
  }

  async readMetadata(input: { conversationId: string }): Promise<ConversationMetadata | null> {
    return (await this.storage.readMetadata(input.conversationId)) ?? null;
  }

  async updateStatus(input: { conversationId: string; status: ConversationMetadata["status"] }): Promise<void> {
    await this.storage.updateMetadataStatus(input.conversationId, input.status);
  }
}

export class JsonlRuntimeEventStore implements RuntimeEventStore {
  constructor(private readonly storage: Pick<FileWorkspaceStorage, "appendWorkspaceRuntimeEvent" | "appendRuntimeEvent">) {}

  async append(input: { records: RuntimeEventRecord[] }): Promise<void> {
    for (const record of input.records) {
      await this.storage.appendWorkspaceRuntimeEvent(record.event);

      if (typeof record.conversationId === "string" && record.conversationId.length > 0) {
        try {
          await this.storage.appendRuntimeEvent(record.conversationId, record.event);
        } catch {
          // ingress.received/rejected 등 conversation이 아직 확정되지 않은 경우에는 workspace log만 남긴다.
        }
      }
    }
  }
}

export class FileWorkspacePersistence implements WorkspacePersistence {
  readonly paths: WorkspacePaths;
  readonly storage: FileWorkspaceStorage;
  readonly conversations: FileConversationStore;
  readonly runtimeEvents: JsonlRuntimeEventStore;

  constructor(options: FileWorkspacePersistenceOptions) {
    this.paths = new WorkspacePaths(options);
    this.storage = new FileWorkspaceStorage(this.paths);
    this.conversations = new FileConversationStore(this.storage);
    this.runtimeEvents = new JsonlRuntimeEventStore(this.storage);
  }

  get workspaceId(): string {
    return this.paths.workspaceId;
  }

  async initialize(): Promise<void> {
    await this.storage.initializeSystemRoot();
  }
}

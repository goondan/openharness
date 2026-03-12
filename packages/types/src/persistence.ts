import type { JsonObject } from "./json.js";
import type { Message, MessageEvent } from "./message.js";
import type { RuntimeEvent } from "./runtime-events.js";

export type ConversationStatus = "idle" | "processing";

export interface ConversationMetadata {
  conversationId: string;
  agentName: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LoadedConversationState {
  baseMessages: Message[];
  events: MessageEvent[];
}

export interface ConversationStore {
  ensureConversation(input: {
    conversationId: string;
    agentName: string;
  }): Promise<ConversationMetadata>;

  loadState(input: {
    conversationId: string;
  }): Promise<LoadedConversationState>;

  appendMessageEvents(input: {
    conversationId: string;
    events: MessageEvent[];
  }): Promise<void>;

  readExtensionState(input: {
    conversationId: string;
    extensionName: string;
  }): Promise<JsonObject | null>;

  writeExtensionState(input: {
    conversationId: string;
    extensionName: string;
    value: JsonObject;
  }): Promise<void>;

  readMetadata(input: {
    conversationId: string;
  }): Promise<ConversationMetadata | null>;

  updateStatus(input: {
    conversationId: string;
    status: ConversationStatus;
  }): Promise<void>;
}

export interface RuntimeEventRecord {
  workspaceId: string;
  conversationId?: string;
  event: RuntimeEvent;
}

export interface RuntimeEventStore {
  append(input: {
    records: RuntimeEventRecord[];
  }): Promise<void>;
}

export interface WorkspacePersistence {
  conversations: ConversationStore;
  runtimeEvents: RuntimeEventStore;
}

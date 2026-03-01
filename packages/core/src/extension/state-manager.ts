import type { JsonValue } from "../types.js";
import { FileWorkspaceStorage } from "../workspace/storage.js";

export interface ExtensionStateManager {
  loadAll(): Promise<void>;
  get(extensionName: string): Promise<JsonValue | null>;
  set(extensionName: string, value: JsonValue): Promise<void>;
  saveAll(): Promise<void>;
}

export class ExtensionStateManagerImpl implements ExtensionStateManager {
  private states: Map<string, JsonValue> = new Map();
  private dirty: Set<string> = new Set();

  constructor(
    private readonly storage: FileWorkspaceStorage,
    private readonly instanceKey: string,
    private readonly extensionNames: string[],
  ) {}

  async loadAll(): Promise<void> {
    for (const name of this.extensionNames) {
      const state = await this.storage.readExtensionState(this.instanceKey, name);
      if (state !== undefined) {
        this.states.set(name, state);
      }
    }
    this.dirty.clear();
  }

  async get(extensionName: string): Promise<JsonValue | null> {
    const value = this.states.get(extensionName);
    return value ?? null;
  }

  async set(extensionName: string, value: JsonValue): Promise<void> {
    this.states.set(extensionName, value);
    this.dirty.add(extensionName);
  }

  async saveAll(): Promise<void> {
    for (const name of this.dirty) {
      const state = this.states.get(name);
      if (state === undefined) {
        continue;
      }

      if (typeof state !== "object" || state === null || Array.isArray(state)) {
        throw new Error(`extension state must be JsonObject, got ${typeof state} for extension ${name}`);
      }

      await this.storage.writeExtensionState(this.instanceKey, name, state);
    }
    this.dirty.clear();
  }
}

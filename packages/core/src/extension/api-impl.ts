import type { ExtensionApi, JsonValue, ToolCatalogItem, ToolHandler } from "../types.js";
import type { PipelineRegistry } from "../pipeline/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ExtensionStateManager } from "./state-manager.js";
import { EventEmitter } from "node:events";

export class ExtensionApiImpl implements ExtensionApi {
  constructor(
    private readonly extensionName: string,
    private readonly pipelineRegistry: PipelineRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly stateManager: ExtensionStateManager,
    private readonly eventBus: EventEmitter,
    private readonly loggerImpl: Console,
  ) {}

  get pipeline(): PipelineRegistry {
    return this.pipelineRegistry;
  }

  get tools() {
    return {
      register: (item: ToolCatalogItem, handler: ToolHandler): void => {
        this.toolRegistry.register(item, handler);
      },
    };
  }

  get state() {
    return {
      get: (): Promise<JsonValue | null> => {
        return this.stateManager.get(this.extensionName);
      },
      set: (value: JsonValue): Promise<void> => {
        return this.stateManager.set(this.extensionName, value);
      },
    };
  }

  get events() {
    return {
      on: (event: string, handler: (...args: unknown[]) => void | Promise<void>): (() => void) => {
        this.eventBus.on(event, handler);
        return () => {
          this.eventBus.off(event, handler);
        };
      },
      emit: (event: string, ...args: unknown[]): Promise<void> => {
        this.eventBus.emit(event, ...args);
        return Promise.resolve();
      },
    };
  }

  get logger(): Pick<Console, "debug" | "info" | "warn" | "error"> {
    return {
      debug: (...args: unknown[]) => this.loggerImpl.debug(...args),
      info: (...args: unknown[]) => this.loggerImpl.info(...args),
      warn: (...args: unknown[]) => this.loggerImpl.warn(...args),
      error: (...args: unknown[]) => this.loggerImpl.error(...args),
    };
  }
}

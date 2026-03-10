/**
 * RuntimeEvent 타입 및 EventBus 구현.
 *
 * 타입 계약은 @goondan/openharness-types가 SSOT. 여기서는 re-export하고,
 * runtime 고유 상수 및 EventBus 구현체만 정의한다.
 */

// ---------------------------------------------------------------------------
// Re-export: @goondan/openharness-types가 소유하는 타입 계약
// ---------------------------------------------------------------------------

export type {
  RuntimeEventType,
  RuntimeEventBase,
  TokenUsage,
  IngressReceivedEvent,
  IngressAcceptedEvent,
  IngressRejectedEvent,
  StepStartedLlmInputMessageContentSource,
  StepStartedLlmInputTextPart,
  StepStartedLlmInputToolCallPart,
  StepStartedLlmInputToolResultPart,
  StepStartedLlmInputMessagePart,
  StepStartedLlmInputMessage,
  TurnStartedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  StepFailedEvent,
  ToolCalledEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  RuntimeEvent,
} from "@goondan/openharness-types";

import type { RuntimeEvent, RuntimeEventType } from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Runtime 고유 상수
// ---------------------------------------------------------------------------

export const STEP_STARTED_LLM_INPUT_MESSAGES_METADATA_KEY = "runtime.llmInputMessages";

export const RUNTIME_EVENT_TYPES: RuntimeEventType[] = [
  "ingress.received",
  "ingress.accepted",
  "ingress.rejected",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "step.started",
  "step.completed",
  "step.failed",
  "tool.called",
  "tool.completed",
  "tool.failed",
];

// ---------------------------------------------------------------------------
// Runtime 고유 EventBus 인터페이스 및 구현체
// ---------------------------------------------------------------------------

export type RuntimeEventListener = (event: RuntimeEvent) => void | Promise<void>;

export interface RuntimeEventBus {
  on(type: RuntimeEventType, listener: RuntimeEventListener): () => void;
  emit(event: RuntimeEvent): Promise<void>;
  clear(): void;
}

export class RuntimeEventBusImpl implements RuntimeEventBus {
  private listeners = new Map<RuntimeEventType, Set<RuntimeEventListener>>();

  on(type: RuntimeEventType, listener: RuntimeEventListener): () => void {
    const set = this.listeners.get(type) ?? new Set<RuntimeEventListener>();
    set.add(listener);
    this.listeners.set(type, set);

    return () => {
      const current = this.listeners.get(type);
      if (current === undefined) {
        return;
      }

      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  async emit(event: RuntimeEvent): Promise<void> {
    const listeners = this.listeners.get(event.type);
    if (listeners === undefined || listeners.size === 0) {
      return;
    }

    const snapshot = [...listeners];
    for (const listener of snapshot) {
      await listener(event);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

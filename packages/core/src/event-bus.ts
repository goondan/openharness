import type { EventPayload } from "@goondan/openharness-types";

type EventType = EventPayload["type"];

type ListenerForType<T extends EventType> = (
  payload: Extract<EventPayload, { type: T }>
) => void;

type UnsubscribeFn = () => void;

export class EventBus {
  // Map from event type → set of listeners
  private readonly _listeners: Map<EventType, Set<(payload: EventPayload) => void>> =
    new Map();

  on<T extends EventType>(event: T, listener: ListenerForType<T>): UnsubscribeFn {
    let listeners = this._listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(event, listeners);
    }
    const fn = listener as (payload: EventPayload) => void;
    listeners.add(fn);

    return () => {
      this._listeners.get(event)?.delete(fn);
    };
  }

  emit<T extends EventType>(event: T, payload: Extract<EventPayload, { type: T }>): void {
    const listeners = this._listeners.get(event);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (err) {
        console.warn(
          `[EventBus] Listener for "${event}" threw an error:`,
          err
        );
      }
    }
  }
}

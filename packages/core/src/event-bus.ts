/**
 * Typed pub/sub bus (F5).
 *
 * The bus is generic over {@link HarnessEvents} — the merged map of fixed
 * {@link CoreHarnessEvents} plus any {@link CustomHarnessEvents} an extension
 * declared via `declare module`. `on`/`emit` are keyed by event name and the
 * payload type follows the key, so a typo or a wrong payload shape is a compile
 * error at the call site. `tap` receives every payload regardless of name —
 * used to bridge a per-agent bus onto the runtime bus.
 *
 * Storage is keyed by plain string so the bus can carry custom event names the
 * library itself never sees; the typed surface is enforced at the boundary.
 */
import type { HarnessEvents } from "@goondan/openharness-types";

type AnyPayload = HarnessEvents[keyof HarnessEvents];
type AnyListener = (payload: AnyPayload) => void;
type UnsubscribeFn = () => void;

export class EventBus {
  private readonly _listeners = new Map<string, Set<AnyListener>>();
  private readonly _tapListeners = new Set<AnyListener>();

  on<T extends keyof HarnessEvents>(
    event: T,
    listener: (payload: HarnessEvents[T]) => void,
  ): UnsubscribeFn {
    const key = event as string;
    let listeners = this._listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(key, listeners);
    }
    const fn = listener as AnyListener;
    listeners.add(fn);

    return () => {
      this._listeners.get(key)?.delete(fn);
    };
  }

  emit<T extends keyof HarnessEvents>(
    event: T,
    payload: HarnessEvents[T],
  ): void {
    const key = event as string;
    const listeners = this._listeners.get(key);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(payload as AnyPayload);
        } catch (err) {
          console.warn(`[EventBus] Listener for "${key}" threw an error:`, err);
        }
      }
    }

    for (const listener of this._tapListeners) {
      try {
        listener(payload as AnyPayload);
      } catch (err) {
        console.warn(`[EventBus] Tap listener for "${key}" threw an error:`, err);
      }
    }
  }

  tap(listener: (payload: AnyPayload) => void): UnsubscribeFn {
    this._tapListeners.add(listener);

    return () => {
      this._tapListeners.delete(listener);
    };
  }
}

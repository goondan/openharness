/**
 * Turn-scoped typed slot storage (F6).
 *
 * A single {@link SlotBackingStore} holds the actual values for one turn and is
 * shared across the turn/step/toolCall chains (slots are turn-scoped). Each
 * middleware does not touch the backing store directly — it receives a gated
 * {@link SlotStore} facade built from the slots it declared via
 * `provides`/`consumes`/`consumesOptional`. Reaching for an undeclared slot
 * throws {@link SlotAccessError}; `get()` on an unset slot throws
 * {@link SlotUnsetError}.
 */
import type { SlotKey, SlotStore } from "@goondan/openharness-types";
import { SlotAccessError, SlotUnsetError } from "./errors.js";

/**
 * The per-middleware view of which slots it may touch, derived from its
 * normalized placement. All `consumes` ids are gettable because boot validation
 * guarantees every required slot has an `always: true` provider.
 */
export interface SlotDeclaration {
  /** Slot ids readable via `get()` (required `consumes`). */
  readonly gettable: ReadonlySet<string>;
  /** Slot ids readable via `tryGet()` (`consumes` + `consumesOptional`). */
  readonly readable: ReadonlySet<string>;
  /** Slot ids writable via `set()` (`provides`). */
  readonly writable: ReadonlySet<string>;
}

export class SlotBackingStore {
  private readonly _values = new Map<string, unknown>();

  has(id: string): boolean {
    return this._values.has(id);
  }

  /** Build a declaration-gated facade for one middleware. */
  facadeFor(decl: SlotDeclaration): SlotStore {
    const backing = this;
    return {
      get<T>(key: SlotKey<T>): T {
        if (!decl.gettable.has(key.id)) {
          throw new SlotAccessError(
            `Slot "${key.id}" is not declared in this middleware's \`consumes\`. ` +
              `Declare it to read it with get(), or use tryGet() with \`consumesOptional\`.`,
          );
        }
        if (!backing._values.has(key.id)) {
          throw new SlotUnsetError(
            `Slot "${key.id}" was read with get() but is unset. Its provider declared ` +
              `\`always: true\` — check that the provider sets it BEFORE calling next(), ` +
              `not after (topo order only guarantees entry order, not set-before-get).`,
          );
        }
        return backing._values.get(key.id) as T;
      },
      tryGet<T>(key: SlotKey<T>): T | undefined {
        if (!decl.readable.has(key.id)) {
          throw new SlotAccessError(
            `Slot "${key.id}" is not declared in this middleware's \`consumes\`/\`consumesOptional\`.`,
          );
        }
        return backing._values.has(key.id)
          ? (backing._values.get(key.id) as T)
          : undefined;
      },
      set<T>(key: SlotKey<T>, value: T): void {
        if (!decl.writable.has(key.id)) {
          throw new SlotAccessError(
            `Slot "${key.id}" is not declared in this middleware's \`provides\`.`,
          );
        }
        backing._values.set(key.id, value);
      },
    };
  }
}

/** A declaration that grants no slot access — used for the core handler and any
 * context that declared no slots. */
export const EMPTY_SLOT_DECLARATION: SlotDeclaration = {
  gettable: new Set<string>(),
  readable: new Set<string>(),
  writable: new Set<string>(),
};

/** A facade that rejects every slot operation — used for the core handler and
 * any context that declared no slots. */
export function emptySlotStore(): SlotStore {
  return new SlotBackingStore().facadeFor(EMPTY_SLOT_DECLARATION);
}

/**
 * Symbol under which the turn's single {@link SlotBackingStore} rides on the
 * execution context. `turn.ts` attaches it once per turn; because step/toolCall
 * contexts are spread-derived (`{ ...ctx }`), the symbol propagates down every
 * level automatically. The middleware chain reads it at invocation time to bind
 * each layer's declaration-gated {@link SlotStore} facade. When absent (ingress/
 * route, or bare test contexts) no slot facade is applied.
 *
 * It is a symbol, not a field, so it never appears in `TurnContext` and cannot
 * be reached by middleware — only the chain plumbing knows about it.
 */
export const SLOT_BACKING: unique symbol = Symbol("openharness.slotBacking");

/** Carrier mixin: an execution context that may transport the turn's slot
 * backing store under {@link SLOT_BACKING}. */
export interface SlotBackingCarrier {
  [SLOT_BACKING]?: SlotBackingStore;
}

// -----------------------------------------------------------------------
// Typed context slots (F6)
//
// Slots are a turn-scoped, type-safe channel for one middleware to hand a
// typed value to another without colliding in `InboundEnvelope.properties`
// or smuggling values through `metadata`. A `SlotKey<T>` carries the value
// type as a phantom so `slots.get(key)` is typed without any cast at the
// call site.
// -----------------------------------------------------------------------

declare const SLOT_VALUE: unique symbol;

/**
 * Opaque, type-carrying handle for a context slot.
 *
 * The `T` parameter only exists at the type level (phantom) — at runtime a
 * SlotKey is just `{ id }`. Create one with {@link createSlot} and share the
 * exported constant between the providing and consuming middleware.
 */
export interface SlotKey<T = unknown> {
  readonly id: string;
  /** Phantom — never present at runtime. */
  readonly [SLOT_VALUE]?: T;
}

/**
 * Declare a typed slot. The returned key is a stable identity; two calls with
 * the same `id` produce interchangeable keys at runtime, but boot validation
 * rejects two *different* keys (different `T`) sharing one `id`.
 *
 * @example
 * export const USER_TIMEZONE = createSlot<string>("user.timezone");
 */
export function createSlot<T>(id: string): SlotKey<T> {
  return { id };
}

/**
 * A slot a middleware declares it will populate.
 *
 * - A bare {@link SlotKey} is a *conditional* provider: the value may or may
 *   not be set, so consumers may only read it with `tryGet()`.
 * - `{ slot, always: true }` is an *unconditional* provider: the slot is
 *   guaranteed set by the time downstream (`after`) middleware run, so those
 *   consumers may use `get()`.
 */
export type SlotProvision<T = unknown> =
  | SlotKey<T>
  | { slot: SlotKey<T>; always: true };

/**
 * Turn-scoped, declaration-gated slot accessor exposed as `ctx.slots`.
 *
 * Each middleware sees a facade restricted to the slots it declared via
 * `provides` / `consumes` / `consumesOptional`. Touching an undeclared slot
 * throws — this keeps the implicit ordering dependencies between middleware
 * explicit and checkable at boot.
 */
export interface SlotStore {
  /**
   * Read a slot that this middleware declared in `consumes` and whose provider
   * declared `{ always: true }`. Throws `SlotUnsetError` if unset (which, for a
   * correctly-ordered `always` provider, indicates the provider set it after
   * `next()` rather than before).
   */
  get<T>(key: SlotKey<T>): T;
  /**
   * Read a slot declared in `consumes` or `consumesOptional`. Returns
   * `undefined` when unset instead of throwing.
   */
  tryGet<T>(key: SlotKey<T>): T | undefined;
  /** Populate a slot this middleware declared in `provides`. */
  set<T>(key: SlotKey<T>, value: T): void;
}

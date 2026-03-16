/**
 * Middleware chain implementation (chain-of-responsibility pattern).
 *
 * Lower priority number = runs first (outermost in the chain).
 * When priorities are equal, registration order determines execution order.
 */

export interface MiddlewareEntry<Ctx, Res> {
  handler: (ctx: Ctx, next: () => Promise<Res>) => Promise<Res>;
  priority: number;
  order: number;
}

/**
 * Build an executable chain from a list of middleware entries and a core handler.
 *
 * @param middlewares - Array of middleware descriptors (handler, priority, order)
 * @param coreHandler - The innermost handler executed when all middlewares have called next()
 * @returns A single function (ctx) => Promise<Res> that runs the full chain
 */
export function buildChain<Ctx, Res>(
  middlewares: Array<MiddlewareEntry<Ctx, Res>>,
  coreHandler: (ctx: Ctx) => Promise<Res>
): (ctx: Ctx) => Promise<Res> {
  // Sort: lower priority first; tie-break by registration order (ascending)
  const sorted = [...middlewares].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order - b.order;
  });

  // Build chain from inside-out.
  // The innermost function is the coreHandler.
  // We then wrap it with each middleware starting from the last (highest priority)
  // down to the first (lowest priority), so that the lowest priority middleware
  // becomes the outermost wrapper.
  let inner: (ctx: Ctx) => Promise<Res> = coreHandler;

  for (let i = sorted.length - 1; i >= 0; i--) {
    const mw = sorted[i];
    const next = inner; // capture current inner before overwriting
    inner = (ctx: Ctx) => mw.handler(ctx, () => next(ctx));
  }

  return inner;
}

/**
 * Registry that manages middleware registrations per named level and builds
 * executable chains on demand.
 */
export class MiddlewareRegistry {
  private _entries: Map<string, Array<MiddlewareEntry<unknown, unknown>>> =
    new Map();
  private _counter = 0;

  /**
   * Register a middleware handler for the given level.
   *
   * @param level   - Logical level name (e.g. "turn", "step", "toolcall")
   * @param handler - Middleware function (ctx, next) => Promise<Res>
   * @param options - Optional configuration; defaults: priority = 100
   */
  register(
    level: string,
    handler: (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    options?: { priority?: number }
  ): void {
    const priority = options?.priority ?? 100;
    const order = this._counter++;

    if (!this._entries.has(level)) {
      this._entries.set(level, []);
    }

    this._entries.get(level)!.push({ handler, priority, order });
  }

  /**
   * Build an executable chain for the given level and core handler.
   *
   * @param level       - Logical level name
   * @param coreHandler - The innermost handler
   * @returns A function (ctx: Ctx) => Promise<Res>
   */
  buildChain<Ctx, Res>(
    level: string,
    coreHandler: (ctx: Ctx) => Promise<Res>
  ): (ctx: Ctx) => Promise<Res> {
    const entries = (this._entries.get(level) ?? []) as Array<
      MiddlewareEntry<Ctx, Res>
    >;
    return buildChain<Ctx, Res>(entries, coreHandler);
  }
}

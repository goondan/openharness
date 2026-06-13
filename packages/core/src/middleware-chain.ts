/**
 * Middleware chain (chain-of-responsibility) with declarative ordering.
 *
 * There is no numeric priority and no phase band. A registration places itself
 * with optional `before`/`after` edges (other middleware names, or the `'*'`
 * sentinel), and the registry resolves a deterministic execution order by
 * topological sort. The resolved order is *outermost-first*: index 0 enters
 * first and its post-`next()` code runs last (the onion). `before`/`after` are
 * defined as **entry order** — "A before B" ⇒ A enters before B.
 *
 * The `'*'` sentinel forms a band: `before: '*'` enters before every other
 * middleware at its level (outermost band), `after: '*'` after every other
 * (innermost band). With no edges at all, registrations fall out in registration
 * order. Unknown references and cycles are boot-time hard errors.
 *
 * Each chain layer can carry a per-layer context transform (`wrapCtx`) — the
 * core uses it to inject the layer's conversation-scoped `store` view, which is
 * keyed by the registering extension's name.
 */
import type { MiddlewareLevel, MiddlewareOptions } from "@goondan/openharness-types";
import { MiddlewareOrderError } from "./errors.js";

/** The `'*'` band sentinel for before/after. */
const STAR = "*";

type Handler<Ctx, Res> = (
  ctx: Ctx,
  next: (override?: Partial<Ctx>) => Promise<Res>,
) => Promise<Res>;

/** One already-ordered link of a chain. */
export interface ChainEntry<Ctx, Res> {
  handler: Handler<Ctx, Res>;
  /**
   * Optional per-layer context transform applied before the handler runs and
   * carried into `next()`. The core uses this to inject the layer's scoped
   * `store`. Omitted ⇒ ctx passes through unchanged.
   */
  wrapCtx?: (ctx: Ctx) => Ctx;
}

interface BuildChainOptions<Ctx, Res> {
  mergeOverride?: (ctx: Ctx, override: Partial<Ctx>) => Ctx;
  prepareNextCtx?: (ctx: Ctx) => Ctx;
}

/**
 * Wrap a list of already-ordered middleware (outermost first) around a core
 * handler. Each entry may be a bare handler or a {@link ChainEntry} carrying a
 * per-layer `wrapCtx`. Ordering is *not* performed here — {@link MiddlewareRegistry}
 * owns that; this is the pure wrapping step (also handy in unit tests).
 */
export function buildChain<Ctx, Res>(
  middlewares: Array<Handler<Ctx, Res> | ChainEntry<Ctx, Res>>,
  coreHandler: (ctx: Ctx) => Promise<Res>,
  options?: BuildChainOptions<Ctx, Res>,
): (ctx: Ctx) => Promise<Res> {
  const entries: Array<ChainEntry<Ctx, Res>> = middlewares.map((m) =>
    typeof m === "function" ? { handler: m } : m,
  );

  let inner: (ctx: Ctx) => Promise<Res> = coreHandler;

  // Wrap from the innermost registered middleware outward, so index 0 becomes
  // the outermost layer.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const next = inner; // capture before reassigning
    inner = (ctx: Ctx) => {
      const handlerCtx = entry.wrapCtx ? entry.wrapCtx(ctx) : ctx;
      return entry.handler(handlerCtx, (override?: Partial<Ctx>) => {
        const mergedCtx = override
          ? options?.mergeOverride
            ? options.mergeOverride(handlerCtx, override)
            : ({ ...handlerCtx, ...override } as Ctx)
          : handlerCtx;
        const nextCtx = options?.prepareNextCtx
          ? options.prepareNextCtx(mergedCtx)
          : mergedCtx;
        return next(nextCtx);
      });
    };
  }

  return inner;
}

// -----------------------------------------------------------------------
// Ordering engine
// -----------------------------------------------------------------------

/** A registration normalized into the fields the planner and validator need. */
export interface NormalizedPlacement {
  /** Effective identity (explicit `name`, else extension name, else anon). */
  name: string;
  /** Source extension, when registered through an extension. */
  extensionName?: string;
  /** Named before refs (the `'*'` sentinel is stripped into `bandBefore`). */
  before: string[];
  /** Named after refs (the `'*'` sentinel is stripped into `bandAfter`). */
  after: string[];
  /** `before: '*'` — enter before every non-band middleware at this level. */
  bandBefore: boolean;
  /** `after: '*'` — enter after every non-band middleware at this level. */
  bandAfter: boolean;
  level: string;
  /** Global registration sequence number — the deterministic tie-break. */
  order: number;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

interface RawRegistration {
  handler: Handler<unknown, unknown>;
  options: MiddlewareOptions;
  extensionName?: string;
  level: string;
  order: number;
}

function normalize(reg: RawRegistration): NormalizedPlacement {
  const o = reg.options;
  const name = o.name ?? reg.extensionName ?? `__anon_${reg.level}_${reg.order}`;
  if (name === STAR) {
    throw new MiddlewareOrderError(
      `Middleware at level "${reg.level}" cannot be named "*" — it is reserved as ` +
        `the before/after band sentinel.`,
    );
  }
  const rawBefore = toArray(o.before);
  const rawAfter = toArray(o.after);
  return {
    name,
    extensionName: reg.extensionName,
    before: rawBefore.filter((r) => r !== STAR),
    after: rawAfter.filter((r) => r !== STAR),
    bandBefore: rawBefore.includes(STAR),
    bandAfter: rawAfter.includes(STAR),
    level: reg.level,
    order: reg.order,
  };
}

/**
 * Resolve a single named `before`/`after` reference to the entry index it
 * targets. An unknown name is a hard error.
 */
function resolveRef(
  ref: string,
  byName: Map<string, number>,
  who: NormalizedPlacement,
  kind: "before" | "after",
): number {
  const idx = byName.get(ref);
  if (idx === undefined) {
    throw new MiddlewareOrderError(
      `Middleware "${who.name}" (level "${who.level}") has ${kind}: "${ref}" ` +
        `referencing an unknown middleware. Use '*' to band against all others, ` +
        `or remove the reference.`,
    );
  }
  return idx;
}

/**
 * Topologically order one level's registrations into outermost-first execution
 * order. Edges come from named `before`/`after` refs and from the `'*'` band
 * (a `bandBefore` node precedes every non-band node; a `bandAfter` node follows
 * every non-band node). Ties break by registration order. Throws
 * {@link MiddlewareOrderError} on a cycle.
 */
export function planMiddlewareOrder(
  entries: NormalizedPlacement[],
): NormalizedPlacement[] {
  const n = entries.length;

  const byName = new Map<string, number>();
  entries.forEach((e, i) => byName.set(e.name, i));

  // Even a single registration may carry an unknown `before`/`after` reference,
  // which must surface as a boot error. Resolve refs up front (also catches a
  // self-reference, which `resolveRef` treats as a real edge and Kahn ignores).
  if (n <= 1) {
    entries.forEach((e) => {
      for (const ref of e.before) resolveRef(ref, byName, e, "before");
      for (const ref of e.after) resolveRef(ref, byName, e, "after");
    });
    return entries.slice();
  }

  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const indegree = new Array<number>(n).fill(0);
  // Reason for each edge "from:to", for cycle diagnostics.
  const edgeReason = new Map<string, string>();

  const addEdge = (from: number, to: number, reason: string): void => {
    if (from === to) return;
    if (adj[from].has(to)) return;
    adj[from].add(to);
    indegree[to]++;
    edgeReason.set(`${from}:${to}`, reason);
  };

  // Named before/after edges. "i before ref" ⇒ i precedes ref (edge i→ref).
  // "i after ref" ⇒ ref precedes i (edge ref→i).
  entries.forEach((e, i) => {
    for (const ref of e.before) addEdge(i, resolveRef(ref, byName, e, "before"), "before");
    for (const ref of e.after) addEdge(resolveRef(ref, byName, e, "after"), i, "after");
  });

  // '*' band edges. A bandBefore node enters before every non-bandBefore node;
  // a bandAfter node enters after every non-bandAfter node. (A node that is both
  // bandBefore and bandAfter only constrains relative to plain nodes.)
  entries.forEach((e, i) => {
    if (e.bandBefore) {
      entries.forEach((other, j) => {
        if (i !== j && !other.bandBefore) addEdge(i, j, "before:*");
      });
    }
    if (e.bandAfter) {
      entries.forEach((other, j) => {
        if (i !== j && !other.bandAfter) addEdge(j, i, "after:*");
      });
    }
  });

  // Kahn's algorithm; among indegree-0 nodes pick the smallest registration
  // order so ordering is fully deterministic.
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i);
  const rank = (i: number): number => entries[i].order;
  ready.sort((a, b) => rank(a) - rank(b));

  const result: NormalizedPlacement[] = [];
  while (ready.length > 0) {
    const i = ready.shift() as number;
    result.push(entries[i]);
    const unlocked: number[] = [];
    for (const t of adj[i]) {
      if (--indegree[t] === 0) unlocked.push(t);
    }
    if (unlocked.length > 0) {
      // Insert keeping `ready` sorted by rank.
      for (const u of unlocked) {
        let lo = 0;
        let hi = ready.length;
        const ru = rank(u);
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (rank(ready[mid]) < ru) lo = mid + 1;
          else hi = mid;
        }
        ready.splice(lo, 0, u);
      }
    }
  }

  if (result.length !== n) {
    const cyclePath = findCycle(adj, indegree, entries, edgeReason);
    throw new MiddlewareOrderError(
      `Middleware ordering has a cycle at level "${entries[0].level}": ${cyclePath}. ` +
        `Break it by relaxing a before/after edge or a '*' band.`,
    );
  }
  return result;
}

/** Find one cycle among the nodes Kahn could not drain, formatted with edge
 * reasons, e.g. `a --before--> b --after:*--> a`. */
function findCycle(
  adj: Set<number>[],
  indegree: number[],
  entries: NormalizedPlacement[],
  edgeReason: Map<string, string>,
): string {
  const remaining = new Set<number>();
  for (let i = 0; i < entries.length; i++) if (indegree[i] > 0) remaining.add(i);

  const onPath: number[] = [];
  const inPath = new Set<number>();
  const visited = new Set<number>();

  const dfs = (node: number): number[] | null => {
    onPath.push(node);
    inPath.add(node);
    for (const next of adj[node]) {
      if (!remaining.has(next)) continue;
      if (inPath.has(next)) {
        const start = onPath.indexOf(next);
        return onPath.slice(start).concat(next);
      }
      if (!visited.has(next)) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    onPath.pop();
    inPath.delete(node);
    visited.add(node);
    return null;
  };

  for (const start of remaining) {
    if (visited.has(start)) continue;
    const cycle = dfs(start);
    if (cycle) {
      let out = entries[cycle[0]].name;
      for (let i = 1; i < cycle.length; i++) {
        const reason = edgeReason.get(`${cycle[i - 1]}:${cycle[i]}`) ?? "edge";
        out += ` --${reason}--> ${entries[cycle[i]].name}`;
      }
      return out;
    }
  }
  // Fallback: just name the trapped nodes.
  return [...remaining].map((i) => entries[i].name).join(", ");
}

// -----------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------

/** Sink for boot-time warnings (defaults to console.warn). */
export type WarnFn = (message: string) => void;

/**
 * Per-level registry of middleware. Owns ordering (via {@link planMiddlewareOrder})
 * and registry-wide boot validation (duplicate names, ordering legality). Plans
 * are memoized per level and invalidated on every `register`; validation runs
 * lazily before the first chain is built (and explicitly by `create-harness`
 * after `registerExtensions`).
 */
export class MiddlewareRegistry {
  private readonly _byLevel = new Map<string, RawRegistration[]>();
  private readonly _planCache = new Map<string, NormalizedPlacement[]>();
  private _counter = 0;
  private _validated = false;
  private readonly _allowedLevels?: ReadonlySet<string>;
  private readonly _warn: WarnFn;

  constructor(allowedLevels?: readonly MiddlewareLevel[], warn?: WarnFn) {
    this._allowedLevels = allowedLevels ? new Set<string>(allowedLevels) : undefined;
    this._warn = warn ?? ((m) => console.warn(m));
  }

  /**
   * Register a middleware at `level`. `options` carries before/after placement;
   * `extensionName` is the default identity and the source for diagnostics.
   * Registering at a level outside `allowedLevels` is a boot error (e.g. an
   * agent registry cannot take `ingress`).
   */
  register(
    level: string,
    handler: Handler<unknown, unknown>,
    options?: MiddlewareOptions,
    extensionName?: string,
  ): void {
    if (this._allowedLevels && !this._allowedLevels.has(level)) {
      throw new MiddlewareOrderError(
        `Cannot register middleware at level "${level}" on this registry; ` +
          `allowed levels: ${[...this._allowedLevels].join(", ")}.`,
      );
    }
    const reg: RawRegistration = {
      handler,
      options: options ?? {},
      extensionName,
      level,
      order: this._counter++,
    };
    const list = this._byLevel.get(level);
    if (list) list.push(reg);
    else this._byLevel.set(level, [reg]);

    // Any registration invalidates memoized plans and validation.
    this._planCache.clear();
    this._validated = false;
  }

  /**
   * Run registry-wide boot validation. Idempotent until the next `register`.
   * Throws {@link MiddlewareOrderError} on the first problem found, and emits a
   * one-shot warning per level when multiple unordered middleware coexist (a
   * possible source of nondeterministic mutation order).
   */
  validate(): void {
    if (this._validated) return;

    const byLevel = new Map<string, NormalizedPlacement[]>();
    for (const [level, list] of this._byLevel) {
      byLevel.set(level, list.map(normalize));
    }

    // 1. Duplicate names within a level.
    for (const [level, placements] of byLevel) {
      const names = new Set<string>();
      for (const e of placements) {
        if (names.has(e.name)) {
          const hint = e.extensionName
            ? ` Extension "${e.extensionName}" registers two middleware at level ` +
              `"${level}"; give at least one an explicit \`name\`.`
            : "";
          throw new MiddlewareOrderError(
            `Duplicate middleware name "${e.name}" at level "${level}".${hint}`,
          );
        }
        names.add(e.name);
      }
    }

    // 2. Unordered-multiple warning (robustness, not an error). When a level has
    //    more than one middleware that declares no before/after placement at
    //    all, their relative order rests only on registration order — fine for
    //    observers, surprising for mutators. Warn once per level.
    for (const [level, placements] of byLevel) {
      const unordered = placements.filter(
        (e) =>
          e.before.length === 0 &&
          e.after.length === 0 &&
          !e.bandBefore &&
          !e.bandAfter,
      );
      if (unordered.length > 1) {
        this._warn(
          `[MiddlewareRegistry] Level "${level}" has ${unordered.length} middleware with no ` +
            `before/after placement (${unordered.map((e) => `"${e.name}"`).join(", ")}); ` +
            `their relative order falls back to registration order. If any of them mutate the ` +
            `conversation, add explicit before/after to make the order intentional.`,
        );
      }
    }

    // 3. Force a planning pass per level so cycles/unknown refs surface at boot.
    for (const level of this._byLevel.keys()) this._plan(level);

    this._validated = true;
  }

  /** Compute (and memoize) the ordered plan for one level. */
  private _plan(level: string): NormalizedPlacement[] {
    const cached = this._planCache.get(level);
    if (cached) return cached;
    const list = this._byLevel.get(level) ?? [];
    const planned = planMiddlewareOrder(list.map(normalize));
    this._planCache.set(level, planned);
    return planned;
  }

  /**
   * Build an executable chain for `level`. Validates the registry on first use,
   * then wraps the planned (ordered) handlers around `coreHandler`.
   *
   * `wrapCtxFor` optionally produces a per-layer ctx transform for a given
   * registration (keyed by extension name) — the core uses it to inject the
   * layer's scoped `store`.
   */
  buildChain<Ctx, Res>(
    level: string,
    coreHandler: (ctx: Ctx) => Promise<Res>,
    options?: BuildChainOptions<Ctx, Res> & {
      wrapCtxFor?: (extensionName: string | undefined, name: string) => ((ctx: Ctx) => Ctx) | undefined;
    },
  ): (ctx: Ctx) => Promise<Res> {
    this.validate();
    const planned = this._plan(level);
    const list = this._byLevel.get(level) ?? [];
    const byOrder = new Map<number, RawRegistration>();
    for (const reg of list) byOrder.set(reg.order, reg);
    const entries: Array<ChainEntry<Ctx, Res>> = planned.map((p) => {
      const reg = byOrder.get(p.order) as RawRegistration;
      const wrapCtx = options?.wrapCtxFor?.(p.extensionName, p.name);
      return { handler: reg.handler as Handler<Ctx, Res>, wrapCtx };
    });
    return buildChain<Ctx, Res>(entries, coreHandler, options);
  }
}

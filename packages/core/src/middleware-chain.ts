/**
 * Middleware chain (chain-of-responsibility) with declarative ordering (F1).
 *
 * There is no numeric priority. A registration places itself with a coarse
 * {@link MiddlewarePhase} band plus optional `before`/`after` edges, and the
 * registry resolves a deterministic execution order by topological sort. The
 * resolved order is *outermost-first*: index 0 enters first and its
 * post-`next()` code runs last (the onion). `before`/`after` are defined as
 * **entry order** — "A before B" ⇒ A enters before B.
 *
 * Phases are only a tie-break inside the topo ready-set, never hard edges: with
 * no edges at all, registrations fall out in `observe → context → guard → model`
 * then registration order. Any ordering you actually depend on must be an
 * explicit edge.
 *
 * The chain also threads turn-scoped typed slots (F6): when the context carries
 * a {@link SlotBackingStore} under {@link SLOT_BACKING}, each layer's handler
 * sees a declaration-gated {@link SlotStore} facade built from what it declared
 * via `provides`/`consumes`/`consumesOptional`.
 */
import type {
  MiddlewareLevel,
  MiddlewareOptions,
  MiddlewarePhase,
  SlotKey,
  SlotProvision,
} from "@goondan/openharness-types";
import { MiddlewareOrderError, SlotWiringError } from "./errors.js";
import {
  EMPTY_SLOT_DECLARATION,
  SLOT_BACKING,
  type SlotBackingCarrier,
  type SlotBackingStore,
  type SlotDeclaration,
} from "./slot-store.js";

/** Outer→inner ordering of the phase bands. */
const PHASE_ORDER: Record<MiddlewarePhase, number> = {
  observe: 0,
  context: 1,
  guard: 2,
  model: 3,
};

/** Containment order of the execution levels (outer→inner). Slots are
 * turn-scoped and shared down this nesting, so a slot provider must sit at a
 * level outer-or-equal to its consumer. Ingress/route are not slot-bearing. */
const LEVEL_ORDER: Record<string, number> = {
  turn: 0,
  step: 1,
  toolCall: 2,
};

type Handler<Ctx, Res> = (
  ctx: Ctx,
  next: (override?: Partial<Ctx>) => Promise<Res>,
) => Promise<Res>;

/** One already-ordered link of a chain, with the slot gate for its layer. */
export interface ChainEntry<Ctx, Res> {
  handler: Handler<Ctx, Res>;
  /** Slot declaration gate for this layer; omitted ⇒ no slot facade applied. */
  declaration?: SlotDeclaration;
}

interface BuildChainOptions<Ctx, Res> {
  mergeOverride?: (ctx: Ctx, override: Partial<Ctx>) => Ctx;
  prepareNextCtx?: (ctx: Ctx) => Ctx;
}

/**
 * Wrap a list of already-ordered middleware (outermost first) around a core
 * handler. Each entry may be a bare handler or a {@link ChainEntry} carrying a
 * slot declaration. Ordering is *not* performed here — {@link MiddlewareRegistry}
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

  // Core handler: gets an empty (deny-all) facade when a backing store rides on
  // the context, so it can never reach a slot it didn't (and can't) declare.
  let inner: (ctx: Ctx) => Promise<Res> = (ctx: Ctx) => {
    const backing = (ctx as SlotBackingCarrier)[SLOT_BACKING];
    const coreCtx = backing
      ? ({ ...ctx, slots: backing.facadeFor(EMPTY_SLOT_DECLARATION) } as Ctx)
      : ctx;
    return coreHandler(coreCtx);
  };

  // Wrap from the innermost registered middleware outward, so index 0 becomes
  // the outermost layer.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const next = inner; // capture before reassigning
    inner = (ctx: Ctx) => {
      const backing = (ctx as SlotBackingCarrier)[SLOT_BACKING];
      const handlerCtx =
        backing && entry.declaration
          ? ({ ...ctx, slots: backing.facadeFor(entry.declaration) } as Ctx)
          : ctx;
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
  phase: MiddlewarePhase;
  before: string[];
  after: string[];
  beforeOptional: string[];
  afterOptional: string[];
  provides: Array<{ id: string; always: boolean }>;
  consumes: string[];
  consumesOptional: string[];
  level: string;
  /** Global registration sequence number — the deterministic tie-break. */
  order: number;
  declaration: SlotDeclaration;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function provisionId(p: SlotProvision): { id: string; always: boolean } {
  return "slot" in p
    ? { id: p.slot.id, always: p.always === true }
    : { id: (p as SlotKey).id, always: false };
}

const PHASE_REF_PREFIX = "phase:";

interface RawRegistration {
  handler: Handler<unknown, unknown>;
  options: MiddlewareOptions;
  extensionName?: string;
  level: string;
  order: number;
}

function normalize(reg: RawRegistration): NormalizedPlacement {
  const o = reg.options;
  const name =
    o.name ?? reg.extensionName ?? `__anon_${reg.level}_${reg.order}`;
  const provides = toArray<SlotProvision>(o.provides).map(provisionId);
  const consumes = toArray<SlotKey>(o.consumes).map((k) => k.id);
  const consumesOptional = toArray<SlotKey>(o.consumesOptional).map((k) => k.id);
  const declaration: SlotDeclaration = {
    gettable: new Set(consumes),
    readable: new Set([...consumes, ...consumesOptional]),
    writable: new Set(provides.map((p) => p.id)),
  };
  return {
    name,
    extensionName: reg.extensionName,
    phase: o.phase ?? "context",
    before: toArray(o.before),
    after: toArray(o.after),
    beforeOptional: toArray(o.beforeOptional),
    afterOptional: toArray(o.afterOptional),
    provides,
    consumes,
    consumesOptional,
    level: reg.level,
    order: reg.order,
    declaration,
  };
}

/**
 * Resolve a single `before`/`after` reference to the entry indices it targets.
 * A `phase:<phase>` ref matches every entry in that phase (an unknown phase is a
 * hard error). A name ref matches the one entry with that name; for a hard edge
 * an unknown name throws, for an `*Optional` edge it is silently dropped.
 */
function resolveRef(
  ref: string,
  byName: Map<string, number>,
  byPhase: Map<string, number[]>,
  optional: boolean,
  who: NormalizedPlacement,
  kind: "before" | "after",
): number[] {
  if (ref.startsWith(PHASE_REF_PREFIX)) {
    const phase = ref.slice(PHASE_REF_PREFIX.length);
    if (!(phase in PHASE_ORDER)) {
      throw new MiddlewareOrderError(
        `Middleware "${who.name}" (level "${who.level}") has ${kind}: "${ref}" ` +
          `referencing an unknown phase. Valid phases: observe, context, guard, model.`,
      );
    }
    return byPhase.get(phase) ?? [];
  }
  const idx = byName.get(ref);
  if (idx === undefined) {
    if (optional) return [];
    throw new MiddlewareOrderError(
      `Middleware "${who.name}" (level "${who.level}") has ${kind}: "${ref}" ` +
        `referencing an unknown middleware. Use \`${kind}Optional\` if "${ref}" ` +
        `may be absent, or prefix with "phase:" to reference a phase.`,
    );
  }
  return [idx];
}

/**
 * Topologically order one level's registrations into outermost-first execution
 * order. Edges come from `before`/`after`/`*Optional` and from same-level slot
 * provider→consumer pairs; phase is the ready-set tie-break, then registration
 * order. Throws {@link MiddlewareOrderError} on a cycle.
 */
export function planMiddlewareOrder(
  entries: NormalizedPlacement[],
): NormalizedPlacement[] {
  const n = entries.length;
  if (n <= 1) return entries.slice();

  const byName = new Map<string, number>();
  entries.forEach((e, i) => byName.set(e.name, i));
  const byPhase = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const list = byPhase.get(e.phase);
    if (list) list.push(i);
    else byPhase.set(e.phase, [i]);
  });

  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const indegree = new Array<number>(n).fill(0);
  // Reason for each edge "a:b", for cycle diagnostics.
  const edgeReason = new Map<string, string>();

  const addEdge = (from: number, to: number, reason: string): void => {
    if (from === to) return;
    if (adj[from].has(to)) return;
    adj[from].add(to);
    indegree[to]++;
    edgeReason.set(`${from}:${to}`, reason);
  };

  // before/after edges. "i before ref" ⇒ i precedes ref (edge i→ref).
  // "i after ref" ⇒ ref precedes i (edge ref→i).
  entries.forEach((e, i) => {
    for (const ref of e.before)
      for (const t of resolveRef(ref, byName, byPhase, false, e, "before"))
        addEdge(i, t, "before");
    for (const ref of e.beforeOptional)
      for (const t of resolveRef(ref, byName, byPhase, true, e, "before"))
        addEdge(i, t, "before");
    for (const ref of e.after)
      for (const t of resolveRef(ref, byName, byPhase, false, e, "after"))
        addEdge(t, i, "after");
    for (const ref of e.afterOptional)
      for (const t of resolveRef(ref, byName, byPhase, true, e, "after"))
        addEdge(t, i, "after");
  });

  // Same-level slot edges: provider enters before consumer.
  const providerOf = new Map<string, number>();
  entries.forEach((e, i) => {
    for (const p of e.provides) providerOf.set(p.id, i);
  });
  entries.forEach((e, i) => {
    for (const id of [...e.consumes, ...e.consumesOptional]) {
      const p = providerOf.get(id);
      if (p !== undefined) addEdge(p, i, `slot:${id}`);
    }
  });

  // Kahn's algorithm; among indegree-0 nodes pick the smallest
  // (phaseOrder, registration order) so ordering is fully deterministic.
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i);
  const rank = (i: number): number =>
    PHASE_ORDER[entries[i].phase] * 1_000_000 + entries[i].order;
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
        `Break it by relaxing a before/after edge or a slot provider→consumer dependency.`,
    );
  }
  return result;
}

/** Find one cycle among the nodes Kahn could not drain, formatted with edge
 * reasons, e.g. `a --before--> b --slot:x--> a`. */
function findCycle(
  adj: Set<number>[],
  indegree: number[],
  entries: NormalizedPlacement[],
  edgeReason: Map<string, string>,
): string {
  const remaining = new Set<number>();
  for (let i = 0; i < entries.length; i++)
    if (indegree[i] > 0) remaining.add(i);

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

/**
 * Per-level registry of middleware. Owns ordering (via {@link planMiddlewareOrder})
 * and registry-wide boot validation (duplicate names, phase/level legality, slot
 * wiring). Plans are memoized per level and invalidated on every `register`, and
 * validation is run lazily before the first chain is built (and explicitly by
 * `create-harness` after `registerExtensions`).
 */
export class MiddlewareRegistry {
  private readonly _byLevel = new Map<string, RawRegistration[]>();
  private readonly _planCache = new Map<string, NormalizedPlacement[]>();
  private _counter = 0;
  private _validated = false;
  private readonly _allowedLevels?: ReadonlySet<string>;

  constructor(allowedLevels?: readonly MiddlewareLevel[]) {
    this._allowedLevels = allowedLevels
      ? new Set<string>(allowedLevels)
      : undefined;
  }

  /**
   * Register a middleware at `level`. `options` carries phase/before/after/slot
   * declarations (F1/F6); `extensionName` is the default identity and the source
   * for diagnostics. Registering at a level outside `allowedLevels` is a boot
   * error (e.g. an agent registry cannot take `ingress`).
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
   * Throws {@link MiddlewareOrderError} / {@link SlotWiringError} on the first
   * problem found.
   */
  validate(): void {
    if (this._validated) return;

    const all: NormalizedPlacement[] = [];
    for (const [, list] of this._byLevel)
      for (const reg of list) all.push(normalize(reg));

    // 1. Duplicate names within a level.
    const seen = new Map<string, Set<string>>();
    for (const e of all) {
      let names = seen.get(e.level);
      if (!names) {
        names = new Set();
        seen.set(e.level, names);
      }
      if (names.has(e.name)) {
        const hint = e.extensionName
          ? ` Extension "${e.extensionName}" registers two middleware at level ` +
            `"${e.level}"; give at least one an explicit \`name\`.`
          : "";
        throw new MiddlewareOrderError(
          `Duplicate middleware name "${e.name}" at level "${e.level}".${hint}`,
        );
      }
      names.add(e.name);
    }

    // 2. `model` phase is step-level only.
    for (const e of all) {
      if (e.phase === "model" && e.level !== "step") {
        throw new MiddlewareOrderError(
          `Middleware "${e.name}" uses phase "model" at level "${e.level}". ` +
            `The "model" phase is only valid at the step level.`,
        );
      }
    }

    // 3. Slots are forbidden at ingress/route.
    for (const e of all) {
      const declaresSlots =
        e.provides.length > 0 ||
        e.consumes.length > 0 ||
        e.consumesOptional.length > 0;
      if (declaresSlots && !(e.level in LEVEL_ORDER)) {
        throw new SlotWiringError(
          `Middleware "${e.name}" at level "${e.level}" declares slots, but slots ` +
            `are only available at turn/step/toolCall levels.`,
        );
      }
    }

    // 4. Slot wiring across the whole registry.
    const providers = new Map<string, NormalizedPlacement & { always: boolean }>();
    for (const e of all) {
      for (const p of e.provides) {
        const existing = providers.get(p.id);
        if (existing) {
          throw new SlotWiringError(
            `Slot "${p.id}" has more than one provider ("${existing.name}" and ` +
              `"${e.name}"). Each slot id may be provided by exactly one middleware.`,
          );
        }
        providers.set(p.id, { ...e, always: p.always });
      }
    }
    const levelOf = (e: NormalizedPlacement): number => LEVEL_ORDER[e.level];
    for (const e of all) {
      for (const id of e.consumes) {
        const prov = providers.get(id);
        if (!prov) {
          throw new SlotWiringError(
            `Middleware "${e.name}" requires slot "${id}" (via \`consumes\`) but ` +
              `no middleware provides it.`,
          );
        }
        if (!prov.always) {
          throw new SlotWiringError(
            `Middleware "${e.name}" reads slot "${id}" with \`consumes\`/get(), but ` +
              `its provider "${prov.name}" is conditional. Either declare the provider ` +
              `\`{ slot, always: true }\`, or read it with \`consumesOptional\`/tryGet().`,
          );
        }
        if (levelOf(prov) > levelOf(e)) {
          throw new SlotWiringError(
            `Slot "${id}" is provided at level "${prov.level}" but consumed at the ` +
              `outer level "${e.level}". A provider must sit at a level outer-or-equal ` +
              `to its consumer.`,
          );
        }
      }
      for (const id of e.consumesOptional) {
        const prov = providers.get(id);
        if (prov && levelOf(prov) > levelOf(e)) {
          throw new SlotWiringError(
            `Slot "${id}" is provided at level "${prov.level}" but optionally consumed ` +
              `at the outer level "${e.level}". A provider must sit at a level ` +
              `outer-or-equal to its consumer.`,
          );
        }
      }
    }

    // 5. Force a planning pass per level so cycles/unknown refs surface at boot.
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
   */
  buildChain<Ctx, Res>(
    level: string,
    coreHandler: (ctx: Ctx) => Promise<Res>,
    options?: BuildChainOptions<Ctx, Res>,
  ): (ctx: Ctx) => Promise<Res> {
    this.validate();
    const planned = this._plan(level);
    const list = this._byLevel.get(level) ?? [];
    const byOrder = new Map<number, RawRegistration>();
    for (const reg of list) byOrder.set(reg.order, reg);
    const entries: Array<ChainEntry<Ctx, Res>> = planned.map((p) => {
      const reg = byOrder.get(p.order) as RawRegistration;
      return {
        handler: reg.handler as Handler<Ctx, Res>,
        declaration: p.declaration,
      };
    });
    return buildChain<Ctx, Res>(entries, coreHandler, options);
  }
}

export type { SlotBackingStore };

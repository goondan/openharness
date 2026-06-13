/**
 * Prompt-view projection registry (F2).
 *
 * The conversation event log is the durable truth; the *prompt view* is a
 * per-step, throwaway rendering of that truth for the model. Extensions register
 * projections via `api.prompt.transform(name, fn, { before?, after? })`; the
 * registry resolves a deterministic pipeline order (same before/after semantics
 * as middleware — "A before B" ⇒ A runs earlier) and `apply()` runs that
 * pipeline over a message set, enforcing the view invariants after every stage.
 *
 * A projection never persists: if it ran zero times the durable log would still
 * be correct. Projections re-run on every step (including recovery retries), so
 * they must be idempotent; expensive work belongs in the `transform()` closure.
 * Throwing — or producing an invalid view — fails the step loudly via
 * {@link PromptProjectionError}; a projection is never silently skipped.
 */
import type {
  Message,
  PromptProjection,
  PromptTransformOptions,
  PromptView,
  StepContext,
} from "@goondan/openharness-types";
import { PromptProjectionError } from "./errors.js";

interface ProjectionEntry {
  name: string;
  projection: PromptProjection;
  before: string[];
  after: string[];
  /** Registration sequence number — the deterministic tie-break. */
  order: number;
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Order projections into pipeline (earliest-first) order by before/after edges,
 * with registration order as the deterministic tie-break. Unknown references are
 * a boot error; cycles throw with the offending names.
 */
export function planProjectionOrder(
  entries: ProjectionEntry[],
): ProjectionEntry[] {
  const n = entries.length;
  if (n <= 1) return entries.slice();

  const byName = new Map<string, number>();
  entries.forEach((e, i) => byName.set(e.name, i));

  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const indegree = new Array<number>(n).fill(0);

  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    if (adj[from].has(to)) return;
    adj[from].add(to);
    indegree[to]++;
  };

  const resolve = (e: ProjectionEntry, ref: string, kind: string): number => {
    const idx = byName.get(ref);
    if (idx === undefined) {
      throw new PromptProjectionError(
        `Prompt projection "${e.name}" has ${kind}: "${ref}" referencing an ` +
          `unknown projection. Registered projections: ${entries
            .map((x) => `"${x.name}"`)
            .join(", ")}.`,
      );
    }
    return idx;
  };

  // "i before ref" ⇒ i precedes ref (edge i→ref).
  // "i after ref"  ⇒ ref precedes i (edge ref→i).
  entries.forEach((e, i) => {
    for (const ref of e.before) addEdge(i, resolve(e, ref, "before"));
    for (const ref of e.after) addEdge(resolve(e, ref, "after"), i);
  });

  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i);
  ready.sort((a, b) => entries[a].order - entries[b].order);

  const result: ProjectionEntry[] = [];
  while (ready.length > 0) {
    const i = ready.shift() as number;
    result.push(entries[i]);
    const unlocked: number[] = [];
    for (const t of adj[i]) {
      if (--indegree[t] === 0) unlocked.push(t);
    }
    for (const u of unlocked) {
      // Keep `ready` sorted by registration order.
      let lo = 0;
      let hi = ready.length;
      const ou = entries[u].order;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[ready[mid]].order < ou) lo = mid + 1;
        else hi = mid;
      }
      ready.splice(lo, 0, u);
    }
  }

  if (result.length !== n) {
    const trapped = entries
      .filter((_, i) => indegree[i] > 0)
      .map((e) => `"${e.name}"`)
      .join(", ");
    throw new PromptProjectionError(
      `Prompt projection ordering has a cycle among ${trapped}. ` +
        `Break it by relaxing a before/after edge.`,
    );
  }
  return result;
}

// -----------------------------------------------------------------------
// View invariants
// -----------------------------------------------------------------------

function roleOf(message: Message): string {
  return message.data.role;
}

/** Tool-call ids declared by an assistant message (its `tool-call` parts). */
function toolCallIdsOf(message: Message): string[] {
  if (message.data.role !== "assistant") return [];
  const content = message.data.content;
  if (typeof content === "string") return [];
  const ids: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "tool-call") {
      const id = (part as { toolCallId?: string }).toolCallId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/** Tool-result ids answered by a tool message (its `tool-result` parts). */
function toolResultIdsOf(message: Message): string[] {
  if (message.data.role !== "tool") return [];
  const content = message.data.content;
  if (typeof content === "string") return [];
  const ids: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "tool-result") {
      const id = (part as { toolCallId?: string }).toolCallId;
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/**
 * Enforce the prompt-view invariants the model and provider adapters require.
 * This is the contract the Karby tool-history-sanitizer used to enforce by hand,
 * promoted into the library: a projection that windows or reorders must keep
 * tool-call/result pairs whole, system messages leading, and ids unique.
 *
 * @param where Label for the error message (projection name or "input").
 */
export function validateView(view: PromptView, where: string): void {
  const seenIds = new Set<string>();
  let seenNonSystem = false;
  // tool-call id → index where it was declared.
  const callIndex = new Map<string, number>();
  // tool-result id → index where it was answered.
  const resultIndex = new Map<string, number>();

  view.forEach((message, i) => {
    if (seenIds.has(message.id)) {
      throw new PromptProjectionError(
        `Prompt view from ${where} has a duplicate message id "${message.id}". ` +
          `Each message in the view must be unique.`,
      );
    }
    seenIds.add(message.id);

    const role = roleOf(message);
    if (role === "system") {
      if (seenNonSystem) {
        throw new PromptProjectionError(
          `Prompt view from ${where} has a system message ("${message.id}") after a ` +
            `non-system message. System messages must lead the view.`,
        );
      }
    } else {
      seenNonSystem = true;
    }

    for (const id of toolCallIdsOf(message)) callIndex.set(id, i);
    for (const id of toolResultIdsOf(message)) {
      if (resultIndex.has(id)) {
        throw new PromptProjectionError(
          `Prompt view from ${where} has two tool results for tool-call "${id}".`,
        );
      }
      resultIndex.set(id, i);
    }
  });

  // Every tool result must answer a tool-call that appears before it.
  for (const [id, ri] of resultIndex) {
    const ci = callIndex.get(id);
    if (ci === undefined) {
      throw new PromptProjectionError(
        `Prompt view from ${where} has an orphan tool result for tool-call "${id}" ` +
          `(no matching assistant tool-call in the view). A projection that windows ` +
          `history must keep tool-call/result pairs together.`,
      );
    }
    if (ci > ri) {
      throw new PromptProjectionError(
        `Prompt view from ${where} has a tool result for "${id}" before its ` +
          `assistant tool-call. Results must follow their call.`,
      );
    }
  }

  // Every tool-call must be answered by a later tool result (no severed pair).
  for (const [id, ci] of callIndex) {
    const ri = resultIndex.get(id);
    if (ri === undefined) {
      throw new PromptProjectionError(
        `Prompt view from ${where} has an unanswered tool-call "${id}" (no matching ` +
          `tool result in the view). A projection that windows history must extend the ` +
          `boundary to keep tool-call/result pairs together.`,
      );
    }
    if (ri < ci) {
      throw new PromptProjectionError(
        `Prompt view from ${where} has a tool result for "${id}" before its ` +
          `assistant tool-call. Results must follow their call.`,
      );
    }
  }
}

// -----------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------

/**
 * Holds the registered projections and runs them as an ordered pipeline. One
 * instance is created per agent and shared by the extension API (`transform`)
 * and the step loop / out-of-step callers (`apply`).
 */
export class PromptProjectionRegistry {
  private readonly _entries: ProjectionEntry[] = [];
  private _counter = 0;
  private _planCache: ProjectionEntry[] | null = null;

  /** Register a projection. Ordering is resolved lazily on first `apply`. */
  transform(
    name: string,
    projection: PromptProjection,
    options?: PromptTransformOptions,
  ): void {
    this._entries.push({
      name,
      projection,
      before: toArray(options?.before),
      after: toArray(options?.after),
      order: this._counter++,
    });
    this._planCache = null;
  }

  /** True when no projections are registered (the common no-op fast path). */
  get isEmpty(): boolean {
    return this._entries.length === 0;
  }

  /**
   * Force the ordering pass so unknown before/after references and cycles surface
   * at boot rather than on the first step. Idempotent (the plan is memoized).
   */
  validate(): void {
    this._plan();
  }

  private _plan(): ProjectionEntry[] {
    if (this._planCache) return this._planCache;
    this._planCache = planProjectionOrder(this._entries);
    return this._planCache;
  }

  /**
   * Run the ordered projection pipeline over `messages` and return the frozen
   * projected view. Validates the input and the output of every stage; a stage
   * that throws is wrapped in {@link PromptProjectionError} (the originating
   * error is preserved as `cause`).
   */
  async apply(
    messages: readonly Message[],
    ctx: StepContext,
  ): Promise<PromptView> {
    let view: PromptView = messages;
    if (this._entries.length === 0) {
      return Object.freeze(view.slice());
    }

    validateView(view, "input");
    for (const entry of this._plan()) {
      let next: PromptView;
      try {
        next = await entry.projection(view, ctx);
      } catch (err) {
        throw new PromptProjectionError(
          `Prompt projection "${entry.name}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      validateView(next, `projection "${entry.name}"`);
      view = next;
    }
    return Object.freeze(view.slice());
  }
}

import { describe, it, expect } from "vitest";
import {
  AGENT_SCOPE_EVENTS,
  CONNECTION_SCOPE_EVENTS,
  type AgentScopeEventType,
  type ConnectionScopeEventType,
  type CoreHarnessEventType,
} from "@goondan/openharness-types";

// The full set of core events, frozen here as a deliberate fixation point. If a
// core event is added or removed, this list must change in lockstep with the
// scope arrays — that is the regression this test guards (a new event silently
// missing from both scopes would never reach a bus).
const ALL_CORE_EVENTS = [
  "turn.start",
  "turn.done",
  "turn.error",
  "step.start",
  "step.done",
  "step.error",
  "step.retry",
  "recovery.exhausted",
  "step.textDelta",
  "step.toolCallDelta",
  "step.toolCallsSuppressed",
  "tool.start",
  "tool.done",
  "tool.error",
  "ingress.received",
  "ingress.accepted",
  "ingress.rejected",
  "inbound.appended",
  "inbound.duplicate",
  "inbound.leased",
  "inbound.delivered",
  "inbound.blocked",
  "inbound.consumed",
  "inbound.failed",
  "inbound.deadLettered",
  "humanApproval.created",
  "humanTask.created",
  "humanTask.resolved",
  "humanTask.rejected",
  "humanApproval.ready",
  "humanApproval.resuming",
  "humanApproval.completed",
  "humanApproval.failed",
  "humanApproval.canceled",
] as const;

describe("event scope split (F5)", () => {
  it("fixes the core event count at 34", () => {
    expect(ALL_CORE_EVENTS).toHaveLength(34);
    expect(new Set(ALL_CORE_EVENTS).size).toBe(34); // no accidental dupes
  });

  it("has disjoint agent and connection scopes", () => {
    const agent = new Set<string>(AGENT_SCOPE_EVENTS);
    const overlap = CONNECTION_SCOPE_EVENTS.filter((e) => agent.has(e));
    expect(overlap).toEqual([]);
  });

  it("neither scope array contains duplicates", () => {
    expect(new Set(AGENT_SCOPE_EVENTS).size).toBe(AGENT_SCOPE_EVENTS.length);
    expect(new Set(CONNECTION_SCOPE_EVENTS).size).toBe(
      CONNECTION_SCOPE_EVENTS.length,
    );
  });

  it("the union of the two scopes exactly covers every core event", () => {
    const union = new Set<string>([
      ...AGENT_SCOPE_EVENTS,
      ...CONNECTION_SCOPE_EVENTS,
    ]);
    expect(union.size).toBe(ALL_CORE_EVENTS.length);
    expect(union).toEqual(new Set<string>(ALL_CORE_EVENTS));
  });

  it("splits 27 agent-scoped + 7 connection-scoped", () => {
    expect(AGENT_SCOPE_EVENTS).toHaveLength(27);
    expect(CONNECTION_SCOPE_EVENTS).toHaveLength(7);
  });
});

// -----------------------------------------------------------------------
// Type-level exhaustiveness: AgentScopeEventType | ConnectionScopeEventType
// must equal CoreHarnessEventType exactly. If a new core event is added but not
// placed in a scope array (or vice versa), one of these assertions fails to
// compile — caught by `pnpm typecheck`, not just at runtime.
// -----------------------------------------------------------------------

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type Assert<T extends true> = T;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ScopesCoverCore = Assert<
  Eq<AgentScopeEventType | ConnectionScopeEventType, CoreHarnessEventType>
>;

describe("event scope split — type level", () => {
  it("compiles the exhaustiveness assertion", () => {
    // The assertion above is the real test; this keeps the type referenced.
    const _check: _ScopesCoverCore = true;
    expect(_check).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { IngressPipeline } from "../../ingress/pipeline.js";
import { MiddlewareRegistry } from "../../middleware-chain.js";
import { EventBus } from "../../event-bus.js";
import type {
  Connector,
  ConnectorContext,
  InboundEnvelope,
  IngressDisposition,
  RoutingRule,
  IngressContext,
  RouteContext,
  IngressAcceptResult,
} from "@goondan/openharness-types";

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeEnvelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    name: "test.event",
    content: [{ type: "text", text: "hello" }],
    properties: {},
    conversationId: "conv-1",
    source: {
      connector: "test",
      connectionName: "conn1",
      receivedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    name: "test-connector",
    verify: vi.fn().mockResolvedValue(undefined),
    normalize: vi.fn().mockResolvedValue(makeEnvelope()),
    ...overrides,
  };
}

function makeRules(agentName = "agent1"): RoutingRule[] {
  return [
    {
      match: { event: "test.event" },
      agent: agentName,
      conversationId: "conv-1",
    },
  ];
}

interface MakePipelineOptions {
  connector?: Connector;
  rules?: RoutingRule[];
  agentNames?: string[];
  connectionName?: string;
  connectionMiddleware?: MiddlewareRegistry;
  agentMiddlewareByAgent?: Map<string, MiddlewareRegistry>;
  dispatchTurn?: (
    turnId: string,
    agentName: string,
    envelope: InboundEnvelope,
    conversationId: string,
  ) =>
    | { turnId: string; disposition: IngressDisposition }
    | { batchId: string; pendingRequestIds: string[]; disposition: "queuedForHitl" };
}

function makePipeline(opts: MakePipelineOptions = {}) {
  const {
    connector = makeConnector(),
    rules = makeRules(),
    agentNames = ["agent1"],
    connectionName = "conn1",
    connectionMiddleware = new MiddlewareRegistry(),
    agentMiddlewareByAgent = new Map(
      agentNames.map((agentName) => [agentName, new MiddlewareRegistry()]),
    ),
    dispatchTurn = vi.fn((turnId: string) => ({ turnId, disposition: "started" as const })),
  } = opts;

  const eventBus = new EventBus();
  const registeredAgents = new Set(agentNames);

  const connections = new Map<string, {
    connector: Connector;
    rules: RoutingRule[];
    connectionMiddleware: MiddlewareRegistry;
  }>();

  connections.set(connectionName, {
    connector,
    rules,
    connectionMiddleware,
  });

  const pipeline = new IngressPipeline({
    connections,
    agentMiddlewareByAgent,
    registeredAgents,
    eventBus,
    dispatchTurn,
  });

  return { pipeline, eventBus, dispatchTurn, connector };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe("IngressPipeline", () => {
  // Test 1: Full pipeline: ingress → route → accepted
  it("full pipeline: ingress → route → accepted", async () => {
    const { pipeline, dispatchTurn } = makePipeline();

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: { text: "hello" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
    expect(results[0].agentName).toBe("agent1");
    expect(results[0].conversationId).toBe("conv-1");
    expect(results[0].turnId).toEqual(expect.any(String));
    expect(results[0].disposition).toBe("started");
    expect(dispatchTurn).toHaveBeenCalledOnce();
    expect(dispatchTurn).toHaveBeenCalledWith(
      expect.any(String), "agent1", expect.any(Object), "conv-1"
    );
  });

  // Test 2: verify fails → rejected, ingress.rejected event
  it("verify fails → rejected, ingress.rejected event emitted", async () => {
    const connector = makeConnector({
      verify: vi.fn().mockRejectedValue(new Error("invalid signature")),
    });
    const { pipeline, eventBus } = makePipeline({ connector });

    const rejectedEvents: unknown[] = [];
    eventBus.on("ingress.rejected", (e) => rejectedEvents.push(e));

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: {},
    });

    expect(results).toHaveLength(0);
    expect(rejectedEvents).toHaveLength(1);
    const ev = rejectedEvents[0] as { type: string; connectionName: string; reason: string };
    expect(ev.type).toBe("ingress.rejected");
    expect(ev.connectionName).toBe("conn1");
    expect(ev.reason).toContain("invalid signature");
  });

  // Test 3: verify undefined → skip verify stage
  it("verify undefined → skip verify stage, pipeline proceeds normally", async () => {
    const connector = makeConnector({
      verify: undefined,
    });
    const { pipeline } = makePipeline({ connector });

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: {},
    });

    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
  });

  // Test 4: normalize returns single envelope → 1 dispatch
  it("normalize returns single envelope → 1 dispatch", async () => {
    const envelope = makeEnvelope();
    const connector = makeConnector({
      normalize: vi.fn().mockResolvedValue(envelope),
    });
    const { pipeline, dispatchTurn } = makePipeline({ connector });

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: {},
    });

    expect(results).toHaveLength(1);
    expect(dispatchTurn).toHaveBeenCalledOnce();
  });

  // Test 5: normalize returns array (fan-out) → N dispatches
  it("normalize returns array → N dispatches (fan-out)", async () => {
    const envelopes = [
      makeEnvelope({ conversationId: "conv-1" }),
      makeEnvelope({ conversationId: "conv-2" }),
      makeEnvelope({ conversationId: "conv-3" }),
    ];
    const connector = makeConnector({
      normalize: vi.fn().mockResolvedValue(envelopes),
    });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "agent1",
      },
    ];
    // envelopes have conversationId set, so routing can use envelope.conversationId
    const { pipeline, dispatchTurn } = makePipeline({ connector, rules });

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: {},
    });

    expect(results).toHaveLength(3);
    expect(dispatchTurn).toHaveBeenCalledTimes(3);
  });

  // Test 6: normalize returns empty array → empty result
  it("normalize returns empty array → empty result", async () => {
    const connector = makeConnector({
      normalize: vi.fn().mockResolvedValue([]),
    });
    const { pipeline, dispatchTurn } = makePipeline({ connector });

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: {},
    });

    expect(results).toHaveLength(0);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  // Test 7: dispatch is fire-and-forget (INGRESS-CONST-004)
  // receive() returns immediately; the Turn runs asynchronously.
  it("dispatch is fire-and-forget — receive() resolves before Turn completes", async () => {
    let turnResolve: () => void;
    const turnCompleted = vi.fn();
    const turnPromise = new Promise<void>((resolve) => { turnResolve = resolve; });

    // dispatchTurn simulates a long-running turn; pipeline must NOT await it
    const dispatchTurn = vi.fn().mockImplementation((turnId: string) => {
      // This is synchronous — fires the turn in background
      void turnPromise.then(() => turnCompleted());
      return { turnId, disposition: "started" as const };
    });

    const { pipeline } = makePipeline({ dispatchTurn });

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: {},
    });

    // receive() already returned — turn has NOT completed yet
    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
    expect(turnCompleted).not.toHaveBeenCalled();
    expect(dispatchTurn).toHaveBeenCalledOnce();

    // Now let the turn complete
    turnResolve!();
    await turnPromise;
    expect(turnCompleted).toHaveBeenCalled();
  });

  // Test 8: dispatch() method skips ingress stage
  it("dispatch() method skips ingress stage", async () => {
    const connector = makeConnector();
    const { pipeline, dispatchTurn } = makePipeline({ connector });

    const envelope = makeEnvelope();
    const result = await pipeline.dispatch({
      connectionName: "conn1",
      envelope,
    });

    expect(result.accepted).toBe(true);
    expect(result.agentName).toBe("agent1");
    expect(result.turnId).toEqual(expect.any(String));
    expect(result.disposition).toBe("started");
    // verify and normalize should NOT have been called
    expect(connector.verify).not.toHaveBeenCalled();
    expect(connector.normalize).not.toHaveBeenCalled();
    expect(dispatchTurn).toHaveBeenCalledOnce();
  });

  // Test 9: ingress.received / ingress.accepted / ingress.rejected events emitted
  it("emits ingress.received and ingress.accepted events on success", async () => {
    const { pipeline, eventBus } = makePipeline();

    const received: unknown[] = [];
    const accepted: unknown[] = [];
    eventBus.on("ingress.received", (e) => received.push(e));
    eventBus.on("ingress.accepted", (e) => accepted.push(e));

    await pipeline.receive({ connectionName: "conn1", payload: { data: "x" } });

    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe("ingress.received");

    expect(accepted).toHaveLength(1);
    const acc = accepted[0] as {
      type: string;
      connectionName: string;
      agentName: string;
      conversationId: string;
      turnId: string;
      disposition: string;
    };
    expect(acc.type).toBe("ingress.accepted");
    expect(acc.connectionName).toBe("conn1");
    expect(acc.agentName).toBe("agent1");
    expect(acc.conversationId).toBe("conv-1");
    expect(acc.turnId).toEqual(expect.any(String));
    expect(acc.disposition).toBe("started");
  });

  it("returns steered disposition and active turnId when dispatch callback steers", async () => {
    const dispatchTurn = vi.fn((turnId: string) => ({
      turnId: `active-${turnId}`,
      disposition: "steered" as const,
    }));
    const { pipeline, eventBus } = makePipeline({ dispatchTurn });
    const accepted: unknown[] = [];
    eventBus.on("ingress.accepted", (e) => accepted.push(e));

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: { text: "steer me" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].disposition).toBe("steered");
    expect(results[0].turnId).toMatch(/^active-turn-/);
    expect((accepted[0] as { disposition: string }).disposition).toBe("steered");
    expect((accepted[0] as { turnId: string }).turnId).toBe(results[0].turnId);
  });

  it("returns queuedForHitl disposition without a synthetic turnId", async () => {
    const dispatchTurn = vi.fn(() => ({
      batchId: "batch-queued-1",
      pendingRequestIds: ["request-queued-1"],
      disposition: "queuedForHitl" as const,
    }));
    const { pipeline, eventBus } = makePipeline({ dispatchTurn });
    const accepted: unknown[] = [];
    eventBus.on("ingress.accepted", (e) => accepted.push(e));

    const results = await pipeline.receive({
      connectionName: "conn1",
      payload: { text: "queue for HITL" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].disposition).toBe("queuedForHitl");
    expect(results[0].batchId).toBe("batch-queued-1");
    expect(results[0].pendingRequestIds).toEqual(["request-queued-1"]);
    expect("turnId" in results[0]).toBe(false);
    expect((accepted[0] as { disposition: string }).disposition).toBe("queuedForHitl");
    expect((accepted[0] as { batchId: string }).batchId).toBe("batch-queued-1");
    expect("turnId" in (accepted[0] as Record<string, unknown>)).toBe(false);
  });

  it("emits ingress.rejected when route fails (no matching rule)", async () => {
    const connector = makeConnector({
      normalize: vi.fn().mockResolvedValue(makeEnvelope({ name: "unmatched.event" })),
    });
    // Rules only match "test.event", but envelope has "unmatched.event"
    const { pipeline, eventBus } = makePipeline({ connector });

    const rejected: unknown[] = [];
    eventBus.on("ingress.rejected", (e) => rejected.push(e));

    const results = await pipeline.receive({ connectionName: "conn1", payload: {} });

    expect(results).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { type: string }).type).toBe("ingress.rejected");
  });

  // Test 10: Connection-level middleware on ingress stage
  it("connection-level middleware runs on ingress stage", async () => {
    const ingressMiddlewareCalled = vi.fn();

    const connectionMiddleware = new MiddlewareRegistry();

    connectionMiddleware.register(
      "ingress",
      async (ctx: unknown, next: () => Promise<unknown>) => {
        ingressMiddlewareCalled(ctx);
        return next();
      }
    );

    const { pipeline } = makePipeline({ connectionMiddleware });

    await pipeline.receive({ connectionName: "conn1", payload: {} });

    expect(ingressMiddlewareCalled).toHaveBeenCalledOnce();
  });

  // Test 11: Agent-level middleware on route stage
  it("agent-level middleware runs on route stage", async () => {
    const routeMiddlewareCalled = vi.fn();

    const agentMiddleware = new MiddlewareRegistry();

    agentMiddleware.register(
      "route",
      async (ctx: unknown, next: () => Promise<unknown>) => {
        routeMiddlewareCalled(ctx);
        return next();
      }
    );

    const { pipeline } = makePipeline({
      agentMiddlewareByAgent: new Map([["agent1", agentMiddleware]]),
    });

    await pipeline.receive({ connectionName: "conn1", payload: {} });

    expect(routeMiddlewareCalled).toHaveBeenCalledOnce();
  });

  // Test 12: Scope enforcement — Connection Extension cannot affect route stage
  it("scope enforcement: connection middleware does NOT affect route stage", async () => {
    const routeIntercepted = vi.fn();

    // Register "route" middleware on the connection registry — should be ignored
    const connectionMiddleware = new MiddlewareRegistry();
    connectionMiddleware.register(
      "route",
      async (ctx: unknown, next: () => Promise<unknown>) => {
        routeIntercepted(); // should NOT be called
        return next();
      }
    );

    const { pipeline } = makePipeline({ connectionMiddleware });

    await pipeline.receive({ connectionName: "conn1", payload: {} });

    // Route middleware registered on connectionMiddleware should NOT have been called
    expect(routeIntercepted).not.toHaveBeenCalled();
  });

  // Test 13: Scope enforcement — Agent Extension cannot affect ingress stage
  it("scope enforcement: agent middleware does NOT affect ingress stage", async () => {
    const ingressIntercepted = vi.fn();

    // Register "ingress" middleware on the agent registry — should be ignored
    const agentMiddleware = new MiddlewareRegistry();
    agentMiddleware.register(
      "ingress",
      async (ctx: unknown, next: () => Promise<unknown>) => {
        ingressIntercepted(); // should NOT be called
        return next();
      }
    );

    const { pipeline } = makePipeline({
      agentMiddlewareByAgent: new Map([["agent1", agentMiddleware]]),
    });

    await pipeline.receive({ connectionName: "conn1", payload: {} });

    // Ingress middleware registered on agentMiddleware should NOT have been called
    expect(ingressIntercepted).not.toHaveBeenCalled();
  });

  // Test 14: listConnections() returns all registered connections
  it("listConnections() returns all registered connections", () => {
    const connector1 = makeConnector({ name: "connector-a" });
    const connector2 = makeConnector({ name: "connector-b" });

    const connections = new Map<string, {
      connector: Connector;
      rules: RoutingRule[];
      connectionMiddleware: MiddlewareRegistry;
    }>();

    connections.set("conn1", {
      connector: connector1,
      rules: makeRules("agent1"),
      connectionMiddleware: new MiddlewareRegistry(),
    });
    connections.set("conn2", {
      connector: connector2,
      rules: makeRules("agent2"),
      connectionMiddleware: new MiddlewareRegistry(),
    });

    const pipeline = new IngressPipeline({
      connections,
      agentMiddlewareByAgent: new Map([
        ["agent1", new MiddlewareRegistry()],
        ["agent2", new MiddlewareRegistry()],
      ]),
      registeredAgents: new Set(["agent1", "agent2"]),
      eventBus: new EventBus(),
      dispatchTurn: vi.fn(),
    });

    const infos = pipeline.listConnections();

    expect(infos).toHaveLength(2);
    const names = infos.map((i) => i.name);
    expect(names).toContain("conn1");
    expect(names).toContain("conn2");

    const conn1Info = infos.find((i) => i.name === "conn1")!;
    expect(conn1Info.connectorName).toBe("connector-a");
    expect(conn1Info.ruleCount).toBe(1);

    const conn2Info = infos.find((i) => i.name === "conn2")!;
    expect(conn2Info.connectorName).toBe("connector-b");
    expect(conn2Info.ruleCount).toBe(1);
  });
});

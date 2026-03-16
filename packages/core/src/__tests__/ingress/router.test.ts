import { describe, it, expect } from "vitest";
import { routeEnvelope } from "../../ingress/router.js";
import type { InboundEnvelope, RoutingRule } from "@goondan/openharness-types";

function makeEnvelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    name: "test.event",
    content: [],
    properties: {},
    source: { connector: "test", connectionName: "conn1", receivedAt: new Date().toISOString() },
    ...overrides,
  };
}

describe("routeEnvelope", () => {
  // Test 1: Rule matches by event name → returns agentName
  it("matches by event name and returns agentName", () => {
    const envelope = makeEnvelope({ name: "user.message" });
    const rules: RoutingRule[] = [
      {
        match: { event: "user.message" },
        agent: "chatAgent",
        conversationId: "conv-fixed",
      },
    ];
    const registered = new Set(["chatAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.agentName).toBe("chatAgent");
    }
  });

  // Test 2: First-match-wins: two matching rules → first applied
  it("applies first matching rule when multiple rules match", () => {
    const envelope = makeEnvelope({ name: "user.message" });
    const rules: RoutingRule[] = [
      {
        match: { event: "user.message" },
        agent: "firstAgent",
        conversationId: "conv-first",
      },
      {
        match: { event: "user.message" },
        agent: "secondAgent",
        conversationId: "conv-second",
      },
    ];
    const registered = new Set(["firstAgent", "secondAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.agentName).toBe("firstAgent");
      expect(result.conversationId).toBe("conv-first");
    }
  });

  // Test 3: conversationId from rule.conversationId (highest priority)
  it("uses rule.conversationId as highest priority", () => {
    const envelope = makeEnvelope({
      name: "test.event",
      properties: { sessionId: "prop-conv" },
      conversationId: "envelope-conv",
    });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "myAgent",
        conversationId: "rule-fixed-conv",
        conversationIdProperty: "sessionId",
      },
    ];
    const registered = new Set(["myAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.conversationId).toBe("rule-fixed-conv");
    }
  });

  // Test 4: conversationId from rule.conversationIdProperty + envelope.properties
  it("extracts conversationId from envelope.properties via conversationIdProperty", () => {
    const envelope = makeEnvelope({
      name: "test.event",
      properties: { sessionId: "session-abc" },
    });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "myAgent",
        conversationIdProperty: "sessionId",
      },
    ];
    const registered = new Set(["myAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.conversationId).toBe("session-abc");
    }
  });

  // Test 5: conversationId with prefix
  it("applies conversationIdPrefix when resolving from property", () => {
    const envelope = makeEnvelope({
      name: "test.event",
      properties: { userId: "user-123" },
    });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "myAgent",
        conversationIdProperty: "userId",
        conversationIdPrefix: "chat-",
      },
    ];
    const registered = new Set(["myAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.conversationId).toBe("chat-user-123");
    }
  });

  // Test 6: conversationId from envelope.conversationId (lowest priority)
  it("falls back to envelope.conversationId as lowest priority", () => {
    const envelope = makeEnvelope({
      name: "test.event",
      conversationId: "envelope-conv-id",
    });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "myAgent",
      },
    ];
    const registered = new Set(["myAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.conversationId).toBe("envelope-conv-id");
    }
  });

  // Test 7: No conversationId from any source → reject
  it("rejects when no conversationId can be resolved", () => {
    const envelope = makeEnvelope({ name: "test.event" });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "myAgent",
      },
    ];
    const registered = new Set(["myAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBeTruthy();
    }
  });

  // Test 8: No matching rule → reject
  it("rejects when no rule matches the envelope", () => {
    const envelope = makeEnvelope({ name: "unknown.event" });
    const rules: RoutingRule[] = [
      {
        match: { event: "other.event" },
        agent: "myAgent",
        conversationId: "conv-1",
      },
    ];
    const registered = new Set(["myAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBeTruthy();
    }
  });

  // Test 9: Target agent not registered → reject
  it("rejects when target agent is not registered", () => {
    const envelope = makeEnvelope({ name: "test.event" });
    const rules: RoutingRule[] = [
      {
        match: { event: "test.event" },
        agent: "unknownAgent",
        conversationId: "conv-1",
      },
    ];
    const registered = new Set(["knownAgent"]);

    const result = routeEnvelope(envelope, rules, registered);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.reason).toBeTruthy();
    }
  });
});

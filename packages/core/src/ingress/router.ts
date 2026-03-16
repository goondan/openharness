import type { InboundEnvelope, RoutingRule } from "@goondan/openharness-types";

export type RouteSuccess = {
  matched: true;
  agentName: string;
  conversationId: string;
};

export type RouteRejected = {
  matched: false;
  reason: string;
};

/**
 * Attempt to match an envelope against the provided routing rules.
 *
 * Resolution order (INGRESS-ROUTE-01):
 *  1. rule.conversationId   — fixed value
 *  2. rule.conversationIdProperty + envelope.properties[key]  (+ optional prefix)
 *  3. envelope.conversationId  — set by Connector during normalize
 *
 * Returns the first matching rule; rejects when no rule matches, the target
 * agent is not registered, or no conversationId can be resolved.
 */
export function routeEnvelope(
  envelope: InboundEnvelope,
  rules: RoutingRule[],
  registeredAgents: Set<string>
): RouteSuccess | RouteRejected {
  for (const rule of rules) {
    if (!matchesRule(envelope, rule)) {
      continue;
    }

    // Rule matched — check agent registration
    if (!registeredAgents.has(rule.agent)) {
      return {
        matched: false,
        reason: `Agent "${rule.agent}" is not registered`,
      };
    }

    // Resolve conversationId
    const conversationId = resolveConversationId(envelope, rule);
    if (conversationId === undefined) {
      return {
        matched: false,
        reason: "No conversationId could be resolved from rule or envelope",
      };
    }

    return {
      matched: true,
      agentName: rule.agent,
      conversationId,
    };
  }

  return {
    matched: false,
    reason: "No routing rule matched the envelope",
  };
}

/**
 * Returns true when all conditions in rule.match are satisfied by the envelope.
 *
 * - `match.event` is tested against `envelope.name`
 * - All other keys are tested against `envelope.properties`
 * - An empty match object always matches (AND of zero conditions)
 */
function matchesRule(envelope: InboundEnvelope, rule: RoutingRule): boolean {
  const { event, ...rest } = rule.match;

  if (event !== undefined && envelope.name !== event) {
    return false;
  }

  for (const [key, expected] of Object.entries(rest)) {
    if (envelope.properties[key] !== expected) {
      return false;
    }
  }

  return true;
}

/**
 * Resolve conversationId according to priority order.
 * Returns undefined when none of the sources yield a value.
 */
function resolveConversationId(
  envelope: InboundEnvelope,
  rule: RoutingRule
): string | undefined {
  // Priority 1: fixed value from rule
  if (rule.conversationId !== undefined) {
    return rule.conversationId;
  }

  // Priority 2: extract from envelope.properties via conversationIdProperty
  if (rule.conversationIdProperty !== undefined) {
    const raw = envelope.properties[rule.conversationIdProperty];
    if (raw !== undefined) {
      const value = String(raw);
      return rule.conversationIdPrefix !== undefined
        ? `${rule.conversationIdPrefix}${value}`
        : value;
    }
  }

  // Priority 3: envelope.conversationId set by Connector
  if (envelope.conversationId !== undefined) {
    return envelope.conversationId;
  }

  return undefined;
}

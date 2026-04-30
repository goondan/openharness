import type {
  IngressApi,
  IngressAcceptResult,
  ConnectionInfo,
  InboundEnvelope,
  Connector,
  RoutingRule,
  IngressContext,
  RouteContext,
  RouteResult,
  IngressDisposition,
} from "@goondan/openharness-types";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { routeEnvelope } from "./router.js";
import { randomUUID } from "node:crypto";

// -----------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------

/**
 * Outcome returned by `dispatchTurn`. Discriminated by `disposition`:
 * - `"queuedForHitl"` carries `batchId` + `pendingRequestIds` (no `turnId`)
 * - any other `IngressDisposition` carries `turnId`
 */
export type DispatchTurnOutcome =
  | { turnId: string; disposition: IngressDisposition }
  | { batchId: string; pendingRequestIds: string[]; disposition: "queuedForHitl" };

/**
 * Narrowing type guard for the `queuedForHitl` branch of `DispatchTurnOutcome`.
 */
export function isQueuedForHitlOutcome(
  outcome: DispatchTurnOutcome,
): outcome is Extract<DispatchTurnOutcome, { disposition: "queuedForHitl" }> {
  return outcome.disposition === "queuedForHitl";
}

export interface IngressPipelineConfig {
  connections: Map<
    string,
    {
      connector: Connector;
      rules: RoutingRule[];
      connectionMiddleware: MiddlewareRegistry;
    }
  >;
  agentMiddlewareByAgent: Map<string, MiddlewareRegistry>;
  registeredAgents: Set<string>;
  eventBus: EventBus;
  /**
   * Fires a turn for the given agent/conversation.
   * The pipeline provides the turnId; the callback starts the turn
   * asynchronously (fire-and-forget). Errors are handled via events,
   * not propagated to the caller.
   */
  dispatchTurn: (
    turnId: string,
    agentName: string,
    envelope: InboundEnvelope,
    conversationId: string,
  ) => DispatchTurnOutcome | Promise<DispatchTurnOutcome>;
}

// -----------------------------------------------------------------------
// IngressPipeline
// -----------------------------------------------------------------------

export class IngressPipeline implements IngressApi {
  private readonly _config: IngressPipelineConfig;

  constructor(config: IngressPipelineConfig) {
    this._config = config;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Full 2-stage pipeline: ingress → route per envelope.
   *
   * Stage 1 (ingress): connection-level — verify + normalize raw payload into InboundEnvelope(s).
   * Stage 2 (route): agent-level — route envelope to agent and dispatch turn.
   */
  async receive(input: {
    connectionName: string;
    payload: unknown;
    receivedAt?: string;
  }): Promise<IngressAcceptResult[]> {
    const { connectionName, payload, receivedAt = new Date().toISOString() } =
      input;
    const { eventBus } = this._config;

    // Emit ingress.received
    eventBus.emit("ingress.received", {
      type: "ingress.received",
      connectionName,
      payload,
      receivedAt,
    });

    // Look up connection
    const connection = this._config.connections.get(connectionName);
    if (!connection) {
      throw new Error(`Unknown connection: "${connectionName}"`);
    }

    const { connector, rules, connectionMiddleware } = connection;
    const ingressCtx: IngressContext = { connectionName, payload, receivedAt };

    // Stage 1: Ingress (connection-level middleware wrapping verify + normalize)
    const ingressCore = async (
      ctx: IngressContext
    ): Promise<InboundEnvelope | InboundEnvelope[]> => {
      // Verify (skip if connector.verify is undefined)
      if (connector.verify !== undefined) {
        await connector.verify(ctx);
      }
      // Normalize
      return connector.normalize(ctx);
    };

    const ingressChain = connectionMiddleware.buildChain<
      IngressContext,
      InboundEnvelope | InboundEnvelope[]
    >("ingress", ingressCore);

    let normalizeResult: InboundEnvelope | InboundEnvelope[];
    try {
      normalizeResult = await ingressChain(ingressCtx);
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        reason,
      });
      return [];
    }

    // Fan-out: normalise to array
    const envelopes: InboundEnvelope[] = Array.isArray(normalizeResult)
      ? normalizeResult
      : [normalizeResult];

    if (envelopes.length === 0) {
      return [];
    }

    // Stage 2: Route per envelope (agent-level middleware wrapping route + dispatch)
    const results: IngressAcceptResult[] = [];
    for (const envelope of envelopes) {
      const result = await this._routeAndDispatch(
        connectionName,
        envelope,
        rules,
        receivedAt
      );
      if (result !== null) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Skip ingress stage — go straight to route stage.
   */
  async dispatch(input: {
    connectionName: string;
    envelope: InboundEnvelope;
    receivedAt?: string;
  }): Promise<IngressAcceptResult> {
    const {
      connectionName,
      envelope,
      receivedAt = new Date().toISOString(),
    } = input;

    const connection = this._config.connections.get(connectionName);
    if (!connection) {
      throw new Error(`Unknown connection: "${connectionName}"`);
    }

    const result = await this._routeAndDispatch(
      connectionName,
      envelope,
      connection.rules,
      receivedAt
    );

    if (result === null) {
      throw new Error(
        `Dispatch rejected for connection "${connectionName}": no matching route`
      );
    }

    return result;
  }

  listConnections(): ConnectionInfo[] {
    const infos: ConnectionInfo[] = [];
    for (const [name, conn] of this._config.connections) {
      infos.push({
        name,
        connectorName: conn.connector.name,
        ruleCount: conn.rules.length,
      });
    }
    return infos;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /**
   * Route + dispatch for a single envelope (agent-level "route" middleware).
   * Returns IngressAcceptResult on success, null on rejection.
   */
  private async _routeAndDispatch(
    connectionName: string,
    envelope: InboundEnvelope,
    rules: RoutingRule[],
    receivedAt: string
  ): Promise<IngressAcceptResult | null> {
    const { agentMiddlewareByAgent, registeredAgents, eventBus, dispatchTurn } =
      this._config;

    const routeMatch = routeEnvelope(envelope, rules, registeredAgents);
    if (!routeMatch.matched) {
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        reason: routeMatch.reason,
      });
      return null;
    }

    const baseResult: RouteResult = {
      accepted: true,
      connectionName,
      agentName: routeMatch.agentName,
      conversationId: routeMatch.conversationId,
      eventName: envelope.name,
      turnId: `turn-${randomUUID()}`,
    };

    const routeMiddleware =
      agentMiddlewareByAgent.get(routeMatch.agentName) ?? null;
    const routeChain = (routeMiddleware ?? {
      buildChain: <Ctx, Res>(_level: string, coreHandler: (ctx: Ctx) => Promise<Res>) =>
        (ctx: Ctx) => coreHandler(ctx),
    }).buildChain<RouteContext, RouteResult>(
      "route",
      async () => baseResult,
    );

    let result: RouteResult;
    try {
      result = await routeChain({ connectionName, envelope });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        reason,
      });
      return null;
    }

    if (!registeredAgents.has(result.agentName)) {
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        reason: `Agent "${result.agentName}" is not registered`,
      });
      return null;
    }

    if (!result.conversationId) {
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        reason: "Route middleware returned an empty conversationId",
      });
      return null;
    }

    // Dispatch: fire turn AFTER route chain completes successfully (INGRESS-CONST-004)
    let dispatchOutcome: Awaited<ReturnType<typeof dispatchTurn>>;
    try {
      dispatchOutcome = await dispatchTurn(
        result.turnId,
        result.agentName,
        envelope,
        result.conversationId,
      );
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        reason,
      });
      return null;
    }

    const acceptResult: IngressAcceptResult = isQueuedForHitlOutcome(dispatchOutcome)
      ? {
          accepted: result.accepted,
          connectionName: result.connectionName,
          agentName: result.agentName,
          conversationId: result.conversationId,
          eventName: result.eventName,
          turnId: result.turnId,
          batchId: dispatchOutcome.batchId,
          pendingRequestIds: dispatchOutcome.pendingRequestIds,
          disposition: dispatchOutcome.disposition,
        }
      : {
          accepted: result.accepted,
          connectionName: result.connectionName,
          agentName: result.agentName,
          conversationId: result.conversationId,
          eventName: result.eventName,
          turnId: dispatchOutcome.turnId,
          disposition: dispatchOutcome.disposition,
        };

    // Emit ingress.accepted
    eventBus.emit("ingress.accepted", {
      type: "ingress.accepted",
      connectionName,
      agentName: acceptResult.agentName,
      conversationId: acceptResult.conversationId,
      ...("turnId" in acceptResult ? { turnId: acceptResult.turnId } : {}),
      ...("batchId" in acceptResult ? { batchId: acceptResult.batchId } : {}),
      disposition: acceptResult.disposition,
    });

    return acceptResult;
  }
}

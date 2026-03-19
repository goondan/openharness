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
} from "@goondan/openharness-types";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { routeEnvelope } from "./router.js";
import { randomUUID } from "node:crypto";

// -----------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------

export interface IngressPipelineConfig {
  connections: Map<
    string,
    {
      connector: Connector;
      rules: RoutingRule[];
      connectionMiddleware: MiddlewareRegistry;
    }
  >;
  agentMiddleware: MiddlewareRegistry;
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
  ) => void;
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
    const { agentMiddleware, registeredAgents, eventBus, dispatchTurn } =
      this._config;

    // "route" middleware chain handles routing only — dispatch happens after
    const routeCore = async (ctx: RouteContext): Promise<RouteResult> => {
      const routeMatch = routeEnvelope(ctx.envelope, rules, registeredAgents);
      if (!routeMatch.matched) {
        throw new RouteRejectedError(routeMatch.reason);
      }

      const { agentName, conversationId } = routeMatch;

      return {
        accepted: true,
        connectionName: ctx.connectionName,
        agentName,
        conversationId,
        eventName: ctx.envelope.name,
        turnId: randomUUID(),
      };
    };

    const routeChain = agentMiddleware.buildChain<RouteContext, RouteResult>(
      "route",
      routeCore
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

    // Dispatch: fire turn AFTER route chain completes successfully (INGRESS-CONST-004)
    dispatchTurn(result.turnId, result.agentName, envelope, result.conversationId);

    const acceptResult: IngressAcceptResult = {
      accepted: result.accepted,
      connectionName: result.connectionName,
      agentName: result.agentName,
      conversationId: result.conversationId,
      eventName: result.eventName,
      turnId: result.turnId,
    };

    // Emit ingress.accepted
    eventBus.emit("ingress.accepted", {
      type: "ingress.accepted",
      connectionName,
      agentName: acceptResult.agentName,
      conversationId: acceptResult.conversationId,
      turnId: acceptResult.turnId,
    });

    return acceptResult;
  }
}

// -----------------------------------------------------------------------
// Internal error type
// -----------------------------------------------------------------------

class RouteRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RouteRejectedError";
  }
}

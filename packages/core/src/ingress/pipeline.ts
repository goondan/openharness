import type {
  IngressApi,
  IngressAcceptResult,
  ConnectionInfo,
  InboundEnvelope,
  Connector,
  RoutingRule,
  VerifyContext,
  NormalizeContext,
  RouteContext,
  DispatchContext,
  RouteResult,
} from "@goondan/openharness-types";
import type { MiddlewareRegistry } from "../middleware-chain.js";
import type { EventBus } from "../event-bus.js";
import { routeEnvelope } from "./router.js";

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
   * Returns the turnId (the turn itself runs asynchronously).
   */
  dispatchTurn: (
    agentName: string,
    envelope: InboundEnvelope,
    conversationId: string
  ) => Promise<string>;
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
   * Full 4-stage pipeline: verify → normalize → (route → dispatch) per envelope.
   */
  async receive(input: {
    connectionName: string;
    payload: unknown;
    receivedAt?: string;
  }): Promise<IngressAcceptResult[]> {
    const { connectionName, payload, receivedAt = new Date().toISOString() } =
      input;
    const { eventBus } = this._config;

    // Stage 0: emit ingress.received
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
    const verifyCtx: VerifyContext = { connectionName, payload, receivedAt };
    const normalizeCtx: NormalizeContext = {
      connectionName,
      payload,
      receivedAt,
    };

    // Stage 1: Verify (skip if connector.verify is undefined)
    if (connector.verify !== undefined) {
      const verifyCore = async (ctx: VerifyContext): Promise<void> => {
        await connector.verify!(ctx);
      };

      const verifyChain = connectionMiddleware.buildChain<VerifyContext, void>(
        "verify",
        verifyCore
      );

      try {
        await verifyChain(verifyCtx);
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        // Verification failed — emit rejection and return empty results
        // There's no envelope yet, so we emit with a placeholder
        const placeholder: InboundEnvelope = {
          name: "_verify_failed_",
          content: [],
          properties: {},
          source: {
            connector: connector.name,
            connectionName,
            receivedAt,
          },
        };
        eventBus.emit("ingress.rejected", {
          type: "ingress.rejected",
          connectionName,
          envelope: placeholder,
          reason,
        });
        return [];
      }
    }

    // Stage 2: Normalize (connection-level middleware)
    const normalizeCore = async (
      ctx: NormalizeContext
    ): Promise<InboundEnvelope | InboundEnvelope[]> => {
      return connector.normalize(ctx);
    };

    const normalizeChain = connectionMiddleware.buildChain<
      NormalizeContext,
      InboundEnvelope | InboundEnvelope[]
    >("normalize", normalizeCore);

    const normalizeResult = await normalizeChain(normalizeCtx);

    // Fan-out: normalise to array
    const envelopes: InboundEnvelope[] = Array.isArray(normalizeResult)
      ? normalizeResult
      : [normalizeResult];

    if (envelopes.length === 0) {
      return [];
    }

    // Stages 3 & 4: route + dispatch per envelope
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
   * Skip verify/normalize — go straight to route + dispatch.
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
   * Stage 3 (route) + Stage 4 (dispatch) for a single envelope.
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

    // Stage 3: Route (agent-level middleware)
    const routeCore = async (ctx: RouteContext): Promise<RouteResult> => {
      const routeResult = routeEnvelope(ctx.envelope, rules, registeredAgents);
      if (!routeResult.matched) {
        throw new RouteRejectedError(routeResult.reason);
      }
      return {
        agentName: routeResult.agentName,
        conversationId: routeResult.conversationId,
      };
    };

    const routeChain = agentMiddleware.buildChain<RouteContext, RouteResult>(
      "route",
      routeCore
    );

    let routeResult: RouteResult;
    try {
      routeResult = await routeChain({ connectionName, envelope });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      eventBus.emit("ingress.rejected", {
        type: "ingress.rejected",
        connectionName,
        envelope,
        reason,
      });
      return null;
    }

    const { agentName, conversationId } = routeResult;

    // Stage 4: Dispatch (agent-level middleware)
    const dispatchCore = async (
      ctx: DispatchContext
    ): Promise<IngressAcceptResult> => {
      const turnId = await dispatchTurn(
        ctx.agentName,
        ctx.envelope,
        ctx.conversationId
      );
      return {
        accepted: true,
        connectionName: ctx.connectionName,
        agentName: ctx.agentName,
        conversationId: ctx.conversationId,
        eventName: ctx.envelope.name,
        turnId,
      };
    };

    const dispatchChain = agentMiddleware.buildChain<
      DispatchContext,
      IngressAcceptResult
    >("dispatch", dispatchCore);

    const dispatchCtx: DispatchContext = {
      connectionName,
      envelope,
      agentName,
      conversationId,
    };

    const acceptResult = await dispatchChain(dispatchCtx);

    // Emit ingress.accepted
    eventBus.emit("ingress.accepted", {
      type: "ingress.accepted",
      connectionName,
      envelope,
      result: acceptResult,
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

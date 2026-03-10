import type {
  IngressAcceptResult,
  IngressDispatchContext,
  IngressDispatchMiddleware,
  IngressNormalizeContext,
  IngressNormalizeMiddleware,
  IngressRegistry,
  IngressRouteContext,
  IngressRouteMiddleware,
  IngressRouteResolution,
  IngressVerifyContext,
  IngressVerifyMiddleware,
  InboundEnvelope,
  JsonValue,
} from "../types.js";

export interface IngressMiddlewareOptions {
  priority?: number;
}

interface MiddlewareEntry<T> {
  readonly fn: T;
  readonly priority: number;
  readonly registrationOrder: number;
}

interface VerifyMutableState extends Omit<IngressVerifyContext, "next"> {}
interface NormalizeMutableState extends Omit<IngressNormalizeContext, "next"> {}
interface RouteMutableState extends Omit<IngressRouteContext, "next"> {}
interface DispatchMutableState extends Omit<IngressDispatchContext, "next"> {}

export interface IngressExecutionRegistry extends IngressRegistry {
  runVerify(ctx: Omit<IngressVerifyContext, "next">, core: IngressVerifyMiddleware): Promise<void>;
  runNormalize(ctx: Omit<IngressNormalizeContext, "next">, core: IngressNormalizeMiddleware): Promise<InboundEnvelope[]>;
  runRoute(
    ctx: Omit<IngressRouteContext, "next">,
    core: IngressRouteMiddleware,
  ): Promise<IngressRouteResolution>;
  runDispatch(
    ctx: Omit<IngressDispatchContext, "next">,
    core: IngressDispatchMiddleware,
  ): Promise<IngressAcceptResult>;
}

export class IngressRegistryImpl implements IngressExecutionRegistry {
  private verifyMiddlewares: MiddlewareEntry<IngressVerifyMiddleware>[] = [];
  private normalizeMiddlewares: MiddlewareEntry<IngressNormalizeMiddleware>[] = [];
  private routeMiddlewares: MiddlewareEntry<IngressRouteMiddleware>[] = [];
  private dispatchMiddlewares: MiddlewareEntry<IngressDispatchMiddleware>[] = [];

  register(...args: ["verify", IngressVerifyMiddleware, IngressMiddlewareOptions?]): void;
  register(...args: ["normalize", IngressNormalizeMiddleware, IngressMiddlewareOptions?]): void;
  register(...args: ["route", IngressRouteMiddleware, IngressMiddlewareOptions?]): void;
  register(...args: ["dispatch", IngressDispatchMiddleware, IngressMiddlewareOptions?]): void;
  register(
    ...args:
      | ["verify", IngressVerifyMiddleware, IngressMiddlewareOptions?]
      | ["normalize", IngressNormalizeMiddleware, IngressMiddlewareOptions?]
      | ["route", IngressRouteMiddleware, IngressMiddlewareOptions?]
      | ["dispatch", IngressDispatchMiddleware, IngressMiddlewareOptions?]
  ): void {
    const [type, fn, options] = args;
    const priority = options?.priority ?? 0;

    if (type === "verify") {
      this.verifyMiddlewares.push({ fn, priority, registrationOrder: this.verifyMiddlewares.length });
      return;
    }

    if (type === "normalize") {
      this.normalizeMiddlewares.push({ fn, priority, registrationOrder: this.normalizeMiddlewares.length });
      return;
    }

    if (type === "route") {
      this.routeMiddlewares.push({ fn, priority, registrationOrder: this.routeMiddlewares.length });
      return;
    }

    this.dispatchMiddlewares.push({ fn, priority, registrationOrder: this.dispatchMiddlewares.length });
  }

  async runVerify(ctx: Omit<IngressVerifyContext, "next">, core: IngressVerifyMiddleware): Promise<void> {
    const state: VerifyMutableState = { ...ctx };
    const ordered = this.sortEntries(this.verifyMiddlewares);

    const dispatch = async (index: number): Promise<void> => {
      if (index >= ordered.length) {
        return core(this.createVerifyContext(state, this.createNeverNext("verify")));
      }

      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("ingress verify middleware entry is missing");
      }

      return entry.fn(this.createVerifyContext(state, async () => dispatch(index + 1)));
    };

    await dispatch(0);
  }

  async runNormalize(
    ctx: Omit<IngressNormalizeContext, "next">,
    core: IngressNormalizeMiddleware,
  ): Promise<InboundEnvelope[]> {
    const state: NormalizeMutableState = { ...ctx };
    const ordered = this.sortEntries(this.normalizeMiddlewares);

    const dispatch = async (index: number): Promise<InboundEnvelope[]> => {
      if (index >= ordered.length) {
        return core(this.createNormalizeContext(state, this.createNeverNext("normalize")));
      }

      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("ingress normalize middleware entry is missing");
      }

      return entry.fn(this.createNormalizeContext(state, async () => dispatch(index + 1)));
    };

    return dispatch(0);
  }

  async runRoute(
    ctx: Omit<IngressRouteContext, "next">,
    core: IngressRouteMiddleware,
  ): Promise<IngressRouteResolution> {
    const state: RouteMutableState = { ...ctx };
    const ordered = this.sortEntries(this.routeMiddlewares);

    const dispatch = async (index: number): Promise<IngressRouteResolution> => {
      if (index >= ordered.length) {
        return core(this.createRouteContext(state, this.createNeverNext("route")));
      }

      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("ingress route middleware entry is missing");
      }

      return entry.fn(this.createRouteContext(state, async () => dispatch(index + 1)));
    };

    return dispatch(0);
  }

  async runDispatch(
    ctx: Omit<IngressDispatchContext, "next">,
    core: IngressDispatchMiddleware,
  ): Promise<IngressAcceptResult> {
    const state: DispatchMutableState = { ...ctx };
    const ordered = this.sortEntries(this.dispatchMiddlewares);

    const dispatch = async (index: number): Promise<IngressAcceptResult> => {
      if (index >= ordered.length) {
        return core(this.createDispatchContext(state, this.createNeverNext("dispatch")));
      }

      const entry = ordered[index];
      if (entry === undefined) {
        throw new Error("ingress dispatch middleware entry is missing");
      }

      return entry.fn(this.createDispatchContext(state, async () => dispatch(index + 1)));
    };

    return dispatch(0);
  }

  private createVerifyContext(state: VerifyMutableState, next: () => Promise<void>): IngressVerifyContext {
    return {
      get connectionName() {
        return state.connectionName;
      },
      get connectorName() {
        return state.connectorName;
      },
      get payload() {
        return state.payload;
      },
      get config() {
        return state.config;
      },
      get secrets() {
        return state.secrets;
      },
      get receivedAt() {
        return state.receivedAt;
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private createNormalizeContext(
    state: NormalizeMutableState,
    next: () => Promise<InboundEnvelope[]>,
  ): IngressNormalizeContext {
    return {
      get connectionName() {
        return state.connectionName;
      },
      get connectorName() {
        return state.connectorName;
      },
      get payload() {
        return state.payload;
      },
      get config() {
        return state.config;
      },
      get secrets() {
        return state.secrets;
      },
      get receivedAt() {
        return state.receivedAt;
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private createRouteContext(
    state: RouteMutableState,
    next: () => Promise<IngressRouteResolution>,
  ): IngressRouteContext {
    return {
      get connectionName() {
        return state.connectionName;
      },
      get connectorName() {
        return state.connectorName;
      },
      get event() {
        return state.event;
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private createDispatchContext(
    state: DispatchMutableState,
    next: () => Promise<IngressAcceptResult>,
  ): IngressDispatchContext {
    return {
      get plan() {
        return state.plan;
      },
      set plan(value) {
        state.plan = value;
      },
      get metadata() {
        return state.metadata;
      },
      set metadata(value: Record<string, JsonValue>) {
        state.metadata = value;
      },
      next,
    };
  }

  private sortEntries<T>(entries: MiddlewareEntry<T>[]): MiddlewareEntry<T>[] {
    return [...entries].sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.registrationOrder - right.registrationOrder;
    });
  }

  private createNeverNext<T>(kind: string): () => Promise<T> {
    return async () => {
      throw new Error(`${kind} middleware next() must not be called by the core handler`);
    };
  }
}

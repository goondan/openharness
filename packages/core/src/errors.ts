export class HarnessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ConfigError extends HarnessError {
  constructor(message: string) {
    super(message);
  }
}

export class ToolValidationError extends HarnessError {
  constructor(message: string) {
    super(message);
  }
}

export class IngressRejectedError extends HarnessError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Boot-time failure while planning middleware order (F1): a dependency cycle,
 * an unknown `before`/`after` reference, a duplicate name at one level, or a
 * `model` phase used outside the step level. Carries enough context for the
 * operator to find the offending registration.
 */
export class MiddlewareOrderError extends ConfigError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Boot-time failure while wiring typed slots (F6): a required slot with no
 * (or a merely conditional) provider, more than one provider for a slot id, a
 * provider at an inner level than its consumer, or a slot declared on an
 * ingress/route middleware.
 */
export class SlotWiringError extends ConfigError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Runtime failure when a middleware touches a slot it did not declare (F6).
 * The declaration gate (`provides`/`consumes`/`consumesOptional`) is what keeps
 * inter-middleware ordering dependencies explicit; reaching around it is a bug.
 */
export class SlotAccessError extends HarnessError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Runtime failure from `slots.get` on a slot that was never set (F6). For a
 * correctly-ordered `always: true` provider this means the provider set the
 * slot *after* calling `next()` rather than before.
 */
export class SlotUnsetError extends HarnessError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A prompt projection (F2) produced an invalid view — duplicate message ids, a
 * non-leading system message, or an orphaned/severed tool-call/result pair —
 * or threw while running. Projection failures fail the step loudly; they are
 * never silently skipped.
 */
export class PromptProjectionError extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

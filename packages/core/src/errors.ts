export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
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
 * Boot-time failure while planning middleware order: a dependency cycle, an
 * unknown `before`/`after` reference, or a duplicate name at one level. Carries
 * enough context for the operator to find the offending registration.
 */
export class MiddlewareOrderError extends ConfigError {
  constructor(message: string) {
    super(message);
  }
}

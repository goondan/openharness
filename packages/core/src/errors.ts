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

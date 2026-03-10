const OPENHARNESS_ABORT_CODE = "E_OPENHARNESS_ABORTED";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export class OpenHarnessAbortError extends Error {
  readonly code = OPENHARNESS_ABORT_CODE;

  constructor(message = "OpenHarness turn aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export function createAbortError(reason?: unknown): OpenHarnessAbortError {
  if (reason instanceof OpenHarnessAbortError) {
    return reason;
  }

  if (reason instanceof Error && isAbortLikeError(reason)) {
    const wrapped = new OpenHarnessAbortError(reason.message);
    return wrapped;
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return new OpenHarnessAbortError(reason.trim());
  }

  return new OpenHarnessAbortError();
}

export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof OpenHarnessAbortError) {
    return true;
  }

  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return true;
    }
    const code = getErrorCode(error);
    return code === OPENHARNESS_ABORT_CODE || code === "ABORT_ERR";
  }

  const code = getErrorCode(error);
  return code === OPENHARNESS_ABORT_CODE || code === "ABORT_ERR";
}

export function toAbortError(error: unknown, fallbackReason?: unknown): OpenHarnessAbortError {
  if (error instanceof OpenHarnessAbortError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new OpenHarnessAbortError(error.message);
  }

  if (error instanceof Error && isAbortLikeError(error)) {
    return new OpenHarnessAbortError(error.message);
  }

  return createAbortError(fallbackReason);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  throw toAbortError(signal.reason);
}

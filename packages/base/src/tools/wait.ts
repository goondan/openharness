import type { JsonObject, JsonValue, ToolContext, ToolHandler } from '../types.js';

const MAX_WAIT_SECONDS = 300;

function readSeconds(input: JsonObject): number {
  const value = input.seconds;
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error("'seconds' must be a finite number");
  }

  if (value < 0) {
    throw new Error("'seconds' must be greater than or equal to 0");
  }

  if (value > MAX_WAIT_SECONDS) {
    throw new Error(`'seconds' must be less than or equal to ${MAX_WAIT_SECONDS}`);
  }

  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const seconds: ToolHandler = async (_ctx: ToolContext, input: JsonObject): Promise<JsonValue> => {
  const waitSeconds = readSeconds(input);
  const waitedMs = Math.round(waitSeconds * 1000);
  await delay(waitedMs);

  return {
    waitedSeconds: waitSeconds,
    waitedMs,
  };
};

export const handlers = {
  seconds,
} satisfies Record<string, ToolHandler>;

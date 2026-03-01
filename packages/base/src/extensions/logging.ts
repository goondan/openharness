import type {
  ExtensionApi,
  JsonObject,
  ToolCallMiddlewareContext,
  TurnMiddlewareContext,
} from '../types.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggingExtensionConfig {
  level?: LogLevel;
  includeToolArgs?: boolean;
  includeTurnMetadata?: boolean;
}

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shouldLog(minimum: LogLevel, level: LogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[minimum];
}

function buildTurnMeta(ctx: TurnMiddlewareContext): JsonObject {
  return {
    turnId: ctx.turnId,
    traceId: ctx.traceId,
    inputType: ctx.inputEvent.type,
  };
}

function buildToolMeta(ctx: ToolCallMiddlewareContext): JsonObject {
  return {
    turnId: ctx.turnId,
    traceId: ctx.traceId,
    stepIndex: ctx.stepIndex,
    toolCallId: ctx.toolCallId,
    toolName: ctx.toolName,
  };
}

export function registerLoggingExtension(
  api: ExtensionApi,
  config: LoggingExtensionConfig = {}
): void {
  const level: LogLevel = config.level ?? 'info';
  const includeToolArgs = config.includeToolArgs ?? false;
  const includeTurnMetadata = config.includeTurnMetadata ?? true;

  api.pipeline.register('turn', async (ctx) => {
    const startedAt = Date.now();
    if (shouldLog(level, 'info')) {
      if (includeTurnMetadata) {
        api.logger.info('[logging.turn] start', buildTurnMeta(ctx));
      } else {
        api.logger.info(`[logging.turn] start turnId=${ctx.turnId}`);
      }
    }

    try {
      const result = await ctx.next();
      if (shouldLog(level, 'info')) {
        api.logger.info('[logging.turn] complete', {
          turnId: ctx.turnId,
          durationMs: Date.now() - startedAt,
          finishReason: result.finishReason,
        });
      }
      return result;
    } catch (error) {
      if (shouldLog(level, 'error')) {
        api.logger.error('[logging.turn] failed', {
          turnId: ctx.turnId,
          durationMs: Date.now() - startedAt,
          error: toErrorMessage(error),
        });
      }
      throw error;
    }
  });

  api.pipeline.register('step', async (ctx) => {
    const startedAt = Date.now();
    if (shouldLog(level, 'info')) {
      api.logger.info('[logging.step] start', {
        turnId: ctx.turnId,
        stepIndex: ctx.stepIndex,
        catalogSize: ctx.toolCatalog.length,
      });
    }

    try {
      const result = await ctx.next();
      if (shouldLog(level, 'info')) {
        api.logger.info('[logging.step] complete', {
          turnId: ctx.turnId,
          stepIndex: ctx.stepIndex,
          durationMs: Date.now() - startedAt,
          shouldContinue: result.shouldContinue,
        });
      }
      return result;
    } catch (error) {
      if (shouldLog(level, 'error')) {
        api.logger.error('[logging.step] failed', {
          turnId: ctx.turnId,
          stepIndex: ctx.stepIndex,
          durationMs: Date.now() - startedAt,
          error: toErrorMessage(error),
        });
      }
      throw error;
    }
  });

  api.pipeline.register('toolCall', async (ctx) => {
    const startedAt = Date.now();

    if (shouldLog(level, 'debug')) {
      if (includeToolArgs) {
        api.logger.debug('[logging.toolCall] start', {
          ...buildToolMeta(ctx),
          args: ctx.args,
        });
      } else {
        api.logger.debug('[logging.toolCall] start', buildToolMeta(ctx));
      }
    }

    try {
      const result = await ctx.next();
      if (shouldLog(level, 'debug')) {
        api.logger.debug('[logging.toolCall] complete', {
          ...buildToolMeta(ctx),
          durationMs: Date.now() - startedAt,
          status: result.status,
        });
      }
      return result;
    } catch (error) {
      if (shouldLog(level, 'error')) {
        api.logger.error('[logging.toolCall] failed', {
          ...buildToolMeta(ctx),
          durationMs: Date.now() - startedAt,
          error: toErrorMessage(error),
        });
      }
      throw error;
    }
  });
}

export function register(api: ExtensionApi, config?: LoggingExtensionConfig): void {
  registerLoggingExtension(api, config);
}

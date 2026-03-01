import type { ExtensionApi } from '../types.js';

export interface RequiredToolsGuardConfig {
  /** Turn 종료 전 반드시 성공 호출되어야 하는 tool 이름 목록 (최소 1개). */
  requiredTools?: string[];
  /** 미충족 시 LLM에 주입할 오류 메시지. */
  errorMessage?: string;
}

function createUserMessage(text: string) {
  return {
    id: `rtg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    data: { role: 'user' as const, content: text },
    metadata: {},
    createdAt: new Date(),
    source: { type: 'extension' as const, extensionName: 'required-tools-guard' },
  };
}

function normalizeConfig(raw?: RequiredToolsGuardConfig): RequiredToolsGuardConfig {
  const config: RequiredToolsGuardConfig = {};

  if (Array.isArray(raw?.requiredTools)) {
    const requiredTools = raw.requiredTools.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
    if (requiredTools.length > 0) {
      config.requiredTools = requiredTools;
    }
  }

  if (typeof raw?.errorMessage === 'string') {
    config.errorMessage = raw.errorMessage;
  }

  return config;
}

export function register(api: ExtensionApi, config?: RequiredToolsGuardConfig): void {
  const rawConfig = normalizeConfig(config);
  const requiredTools: string[] = Array.isArray(rawConfig.requiredTools) ? rawConfig.requiredTools : [];
  const errorMessage =
    typeof rawConfig.errorMessage === 'string' && rawConfig.errorMessage.trim().length > 0
      ? rawConfig.errorMessage
      : `다음 도구 중 하나를 반드시 호출하세요: ${requiredTools.join(', ')}`;

  if (requiredTools.length === 0) return;

  // turnId별 성공한 tool 호출 추적
  const calledToolsPerTurn = new Map<string, Set<string>>();

  api.pipeline.register('turn', async (ctx) => {
    // turn 경계에서 누적 상태를 강제 리셋한다.
    calledToolsPerTurn.clear();
    calledToolsPerTurn.set(ctx.turnId, new Set());
    try {
      return await ctx.next();
    } finally {
      calledToolsPerTurn.delete(ctx.turnId);
      calledToolsPerTurn.clear();
    }
  });

  api.pipeline.register('toolCall', async (ctx) => {
    const result = await ctx.next();
    if (result.status === 'ok') {
      if (!calledToolsPerTurn.has(ctx.turnId)) {
        calledToolsPerTurn.set(ctx.turnId, new Set());
      }
      calledToolsPerTurn.get(ctx.turnId)?.add(ctx.toolName);
    }
    return result;
  });

  api.pipeline.register('step', async (ctx) => {
    const result = await ctx.next();

    if (result.shouldContinue) return result;

    // 현재 step의 결과도 반영
    const calledTools = calledToolsPerTurn.get(ctx.turnId) ?? new Set<string>();
    for (const tr of result.toolResults) {
      if (tr.status === 'ok') calledTools.add(tr.toolName);
    }

    const satisfied = requiredTools.some((t) => calledTools.has(t));
    if (satisfied) {
      calledToolsPerTurn.delete(ctx.turnId);
      return result;
    }

    ctx.emitMessageEvent({ type: 'append', message: createUserMessage(errorMessage) });
    return { ...result, shouldContinue: true };
  });
}

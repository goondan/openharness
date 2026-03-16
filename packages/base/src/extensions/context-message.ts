import type { Extension, ExtensionApi } from "@goondan/openharness-types";

/**
 * ContextMessage extension — prepends a system message to the conversation
 * at the start of every turn.
 *
 * Priority 10 (HIGH) ensures it runs before other turn middleware.
 */
export function ContextMessage(text: string): Extension {
  return {
    name: "context-message",

    register(api: ExtensionApi): void {
      api.pipeline.register(
        "turn",
        async (ctx, next) => {
          ctx.conversation.emit({
            type: "append",
            message: {
              id: `ctx-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: "system",
              content: text,
            },
          });
          return next();
        },
        { priority: 10 },
      );
    },
  };
}

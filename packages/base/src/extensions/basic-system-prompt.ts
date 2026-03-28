import type { Extension, ExtensionApi } from "@goondan/openharness-types";

const SYSTEM_MESSAGE_ID = "sys-basic-system-prompt";

/**
 * BasicSystemPrompt extension — prepends a system message to the conversation
 * at the start of every turn.
 *
 * Uses a fixed message ID so the system prompt is only appended once;
 * subsequent turns detect the existing message and skip the append.
 *
 * Priority 10 (HIGH) ensures it runs before other turn middleware.
 */
export function BasicSystemPrompt(text: string): Extension {
  return {
    name: "basic-system-prompt",

    register(api: ExtensionApi): void {
      api.pipeline.register(
        "turn",
        async (ctx, next) => {
          const alreadyExists = ctx.conversation.messages.some(
            (m) => m.id === SYSTEM_MESSAGE_ID,
          );

          if (!alreadyExists) {
            ctx.conversation.emit({
              type: "append",
              message: {
                id: SYSTEM_MESSAGE_ID,
                data: {
                  role: "system",
                  content: text,
                },
                metadata: {
                  __createdBy: "basic-system-prompt",
                },
              },
            });
          }

          return next();
        },
        { priority: 10 },
      );
    },
  };
}

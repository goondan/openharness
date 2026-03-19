import type { Extension, ExtensionApi } from "@goondan/openharness-types";
import { randomUUID } from "node:crypto";

/**
 * BasicSystemPrompt extension — prepends a system message to the conversation
 * at the start of every turn.
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
          ctx.conversation.emit({
            type: "append",
            message: {
              id: `sys-${randomUUID()}`,
              data: {
                role: "system",
                content: text,
              },
              metadata: {
                __createdBy: "basic-system-prompt",
              },
            },
          });
          return next();
        },
        { priority: 10 },
      );
    },
  };
}

import type { Extension, ExtensionApi } from "@goondan/openharness-types";

/**
 * MessageWindow extension — truncates conversation history to keep only
 * the most recent `maxMessages` messages before each step.
 */
export function MessageWindow(config: { maxMessages: number }): Extension {
  return {
    name: "message-window",

    register(api: ExtensionApi): void {
      api.pipeline.register("step", async (ctx, next) => {
        if (ctx.conversation.messages.length > config.maxMessages) {
          ctx.conversation.emit({
            type: "truncate",
            keepLast: config.maxMessages,
          });
        }
        return next();
      });
    },
  };
}

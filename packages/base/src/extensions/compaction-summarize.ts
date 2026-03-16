import type { Extension, ExtensionApi } from "@goondan/openharness-types";

/**
 * CompactionSummarize extension — when message count exceeds `threshold`,
 * removes the oldest messages and prepends a summary system message.
 *
 * For MVP the "summary" is just the concatenation of removed message text.
 */
export function CompactionSummarize(config: {
  threshold: number;
  summaryPrompt?: string;
}): Extension {
  return {
    name: "compaction-summarize",

    register(api: ExtensionApi): void {
      api.pipeline.register("step", async (ctx, next) => {
        const messages = ctx.conversation.messages;
        if (messages.length > config.threshold) {
          const keepCount = Math.floor(config.threshold / 2);
          const removeCount = messages.length - keepCount;
          const toRemove = messages.slice(0, removeCount);

          // Build a naive summary from removed messages
          const summaryText = toRemove
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join(" ");

          // Remove old messages
          for (const msg of toRemove) {
            ctx.conversation.emit({ type: "remove", messageId: msg.id });
          }

          // Prepend summary
          ctx.conversation.emit({
            type: "append",
            message: {
              id: `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: "system",
              content: `[Summary of earlier conversation]: ${summaryText}`,
            },
          });
        }
        return next();
      });
    },
  };
}

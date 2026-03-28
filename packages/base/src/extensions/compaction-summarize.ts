import type { Extension, ExtensionApi, Message, LlmChatOptions } from "@goondan/openharness-types";
import { randomUUID } from "node:crypto";

const DEFAULT_SUMMARY_PROMPT =
  "You are a conversation compactor. Summarize the following messages into a concise summary " +
  "that preserves all important context, decisions, facts, and action items. " +
  "Be thorough but brief. Output only the summary text, nothing else.";

/**
 * Extract plain-text representation of a Message for summarization.
 */
function messageToText(m: Message): string {
  const role = m.data.role;
  const content =
    typeof m.data.content === "string"
      ? m.data.content
      : JSON.stringify(m.data.content);
  return `[${role}]: ${content}`;
}

/**
 * CompactionSummarize extension — when message count exceeds `threshold`,
 * removes the oldest messages and replaces them with an LLM-generated summary.
 *
 * By default, uses the agent's own LLM (`ctx.llm`) to produce the summary.
 * A custom `summarizer` callback can override this for advanced use cases
 * (e.g. using a cheaper model, external API, or deterministic logic).
 *
 * @param config.threshold - Trigger compaction when messages exceed this count.
 * @param config.summaryPrompt - Custom system prompt for the LLM summarizer.
 * @param config.summarizer - Optional override: produce summary text from messages.
 */
export function CompactionSummarize(config: {
  threshold: number;
  summaryPrompt?: string;
  /** LLM options for the summarization call (e.g. model override for cheaper summarization). */
  llmOptions?: LlmChatOptions;
  summarizer?: (messages: Message[]) => Promise<string>;
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

          let summaryText: string;

          if (config.summarizer) {
            // User-provided summarizer takes precedence
            summaryText = await config.summarizer([...toRemove]);
          } else {
            // Default: LLM-based summarization via ctx.llm
            const transcript = toRemove.map(messageToText).join("\n");
            const prompt = config.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;

            const llmResponse = await ctx.llm.chat(
              [
                { id: `compaction-sys-${randomUUID()}`, data: { role: "system", content: prompt }, metadata: {} },
                { id: `compaction-usr-${randomUUID()}`, data: { role: "user", content: transcript }, metadata: {} },
              ],
              [], // no tools needed for summarization
              ctx.abortSignal,
              config.llmOptions,
            );

            summaryText = llmResponse.text ?? transcript;
          }

          // Remove old messages, replace first with summary for stable ordering
          const [firstToRemove, ...restToRemove] = toRemove;
          // Replace the first message with the summary
          ctx.conversation.emit({
            type: "remove",
            messageId: firstToRemove.id,
          });
          for (const msg of restToRemove) {
            ctx.conversation.emit({ type: "remove", messageId: msg.id });
          }

          // Prepend summary as a system message
          ctx.conversation.emit({
            type: "append",
            message: {
              id: `summary-${randomUUID()}`,
              data: {
                role: "system",
                content: `[Summary of earlier conversation]: ${summaryText}`,
              },
              metadata: {
                __createdBy: "compaction-summarize",
              },
            },
          });
        }
        return next();
      });
    },
  };
}

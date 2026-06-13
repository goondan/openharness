import {
  type AgentExtension,
  type AgentExtensionApi,
  type Message,
  type LlmChatOptions,
  type SystemModelMessage,
  createMessage,
} from "@goondan/openharness-types";
import { randomUUID } from "node:crypto";

const DEFAULT_SUMMARY_PROMPT =
  "You are a conversation compactor. Summarize the following messages into a concise summary " +
  "that preserves all important context, decisions, facts, and action items. " +
  "Be thorough but brief. Output only the summary text, nothing else.";

const CREATED_BY = "compaction-summarize";

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
 * removes the oldest *non-system* messages and replaces them with an
 * LLM-generated summary.
 *
 * This is a durable mutation, not a projection: removing history and recording a
 * summary changes the log itself, and must survive replay. It runs as step
 * middleware (`useStep`) so it assembles context before the model call. System
 * messages are never folded into the summary — filtering them out keeps stale
 * prompts/summaries out of the new summary.
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
}): AgentExtension {
  return {
    name: "compaction-summarize",

    register(api: AgentExtensionApi): void {
      api.useStep(async (ctx, next) => {
        const messages = ctx.conversation.getMessages();
        if (messages.length > config.threshold) {
          const keepCount = Math.floor(config.threshold / 2);
          // Only non-system messages are compaction candidates. System
          // messages (the prompt, prior summaries) must lead the view and
          // must not be summarized away.
          const removable = messages.filter((m) => m.data.role !== "system");
          if (removable.length <= keepCount) return next();

          const removeCount = removable.length - keepCount;
          const toRemove = removable.slice(0, removeCount);

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
                createMessage<SystemModelMessage>({
                  id: `compaction-sys-${randomUUID()}`,
                  data: { role: "system", content: prompt },
                  createdBy: CREATED_BY,
                }),
                createMessage({
                  id: `compaction-usr-${randomUUID()}`,
                  data: { role: "user", content: transcript },
                  createdBy: CREATED_BY,
                }),
              ],
              [], // no tools needed for summarization
              ctx.abortSignal,
              config.llmOptions,
            );

            summaryText = llmResponse.text ?? transcript;
          }

          // Remove the old non-system messages. Durable — survives replay.
          for (const msg of toRemove) {
            ctx.conversation.append({ type: "remove", messageId: msg.id });
          }

          // Record the summary as a system message so it keeps leading the
          // durable log and the model-input view stays valid.
          ctx.conversation.append({
            type: "appendSystem",
            message: createMessage<SystemModelMessage>({
              id: `summary-${randomUUID()}`,
              data: {
                role: "system",
                content: `[Summary of earlier conversation]: ${summaryText}`,
              },
              createdBy: CREATED_BY,
            }),
          });
        }
        return next();
      });
    },
  };
}

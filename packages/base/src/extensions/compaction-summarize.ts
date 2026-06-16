import {
  type AgentExtension,
  type AgentExtensionApi,
  type Message,
  type SubrunOptions,
  type SystemModelMessage,
  type UserModelMessage,
  createMessage,
} from "@goondan/openharness-types";
import { randomUUID } from "node:crypto";

const DEFAULT_SUMMARY_INSTRUCTION =
  "Summarize the conversation so far into a concise summary that preserves all " +
  "important context, decisions, facts, and action items. Be thorough but brief. " +
  "Output only the summary text, nothing else.";

const CREATED_BY = "compaction-summarize";

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
 * The summary is produced by `ctx.subrun` — a one-step sub-run in the agent's
 * *own* model (a single step is offered no tools, so the summarizer can't trigger
 * side effects). We send the slice being removed followed by a short summarize
 * instruction; the agent's projection assembles the system prompt, so the request
 * largely hits the main turn's prompt cache instead of re-paying for the whole
 * history as a fresh prompt. If the sub-run fails or returns no text, history is
 * left untouched. A custom `summarizer` callback can override this for advanced
 * use cases (deterministic logic, external API).
 *
 * @param config.threshold - Trigger compaction when messages exceed this count.
 * @param config.summaryInstruction - Custom trailing instruction for the summarizer.
 * @param config.subrunOptions - Extra sub-run options (e.g. overrideModel for a cheaper summarizer).
 * @param config.summarizer - Optional override: produce summary text from messages.
 */
export function CompactionSummarize(config: {
  threshold: number;
  summaryInstruction?: string;
  /** Extra sub-run options for the summarization call (maxSteps stays 1). */
  subrunOptions?: SubrunOptions;
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
            // Default: summarize via a one-step sub-run in the agent's own model.
            // Seed it with exactly the slice being removed (`toRemove`), not the
            // whole conversation: if a windowing projection (e.g. MessageWindow) is
            // also installed, seeding the full history lets it trim the front —
            // precisely `toRemove` — before the summarizer sees it, so we'd delete
            // messages we never summarized. `toRemove` is a prefix, so the request
            // still shares the main turn's prompt-cache prefix.
            const instruction = config.summaryInstruction ?? DEFAULT_SUMMARY_INSTRUCTION;
            const result = await ctx.subrun(
              [
                ...toRemove,
                createMessage<UserModelMessage>({
                  id: `compaction-instruction-${randomUUID()}`,
                  data: { role: "user", content: instruction },
                  createdBy: CREATED_BY,
                }),
              ],
              { maxSteps: 1, signal: ctx.abortSignal, ...config.subrunOptions },
            );

            // A failed / aborted / no-text sub-run must NOT delete history — leave
            // the durable log untouched rather than replacing real messages with an
            // empty `[Summary]:`. `ctx.subrun` reports failure via status, not throw.
            if (result.status !== "completed" || !result.text) {
              return next();
            }
            summaryText = result.text;
          }

          // An empty summary (incl. from a user summarizer) must not delete history.
          if (summaryText.trim().length === 0) {
            return next();
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

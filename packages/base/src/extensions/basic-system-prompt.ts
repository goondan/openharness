import {
  type AgentExtension,
  type AgentExtensionApi,
  type ModelInput,
  createMessage,
} from "@goondan/openharness-types";

/**
 * Id of the system message that pre-1.0 versions persisted into the durable
 * log. The projection no longer writes it; the turn middleware below removes
 * any leftover copy from old conversations exactly once.
 */
const LEGACY_SYSTEM_MESSAGE_ID = "sys-basic-system-prompt";
const CREATED_BY = "basic-system-prompt";

/**
 * Extension returned by {@link BasicSystemPrompt}. Carries the prompt text so
 * consumers that used to read it off the durable system message (compaction,
 * prewarm, slack.host) can recover it via {@link getSystemPromptText} now that
 * the prompt lives only in the projected view.
 */
export interface BasicSystemPromptExtension extends AgentExtension {
  readonly systemPromptText: string;
}

/**
 * Recover the system prompt text from a {@link BasicSystemPrompt} extension.
 * Returns `undefined` for any other extension.
 */
export function getSystemPromptText(
  extension: AgentExtension,
): string | undefined {
  return (extension as Partial<BasicSystemPromptExtension>).systemPromptText;
}

/**
 * BasicSystemPrompt extension — makes a system message lead the prompt on every
 * step.
 *
 * As of 1.0 this is a *projection* via `useModelInput`: the system prompt is
 * part of the throwaway model input, never the durable log. If this projection
 * ran zero times the durable log would still be correct — which is exactly the
 * test for "view, not mutation". A one-time turn middleware (registered with
 * `{ before: "*" }`, so it lands at the outermost band before any step) removes
 * the legacy persisted copy from conversations created by older versions.
 */
export function BasicSystemPrompt(text: string): BasicSystemPromptExtension {
  return {
    name: "basic-system-prompt",
    systemPromptText: text,

    register(api: AgentExtensionApi): void {
      // One-time migration: drop the legacy persisted system message so the
      // durable log and the projected view don't carry it twice. `remove` is an
      // idempotent no-op when the message is absent, so this is safe on
      // conversations that never had the legacy copy.
      api.useTurn(
        async (ctx, next) => {
          const hasLegacy = ctx.conversation
            .getMessages()
            .some((m) => m.id === LEGACY_SYSTEM_MESSAGE_ID);
          if (hasLegacy) {
            ctx.conversation.append({
              type: "remove",
              messageId: LEGACY_SYSTEM_MESSAGE_ID,
            });
          }
          return next();
        },
        { before: "*" },
      );

      // Model-input projection: prepend the system message to the view.
      // Filtering an existing copy first keeps the projection idempotent and
      // collision-free even if the legacy message is still present on the first
      // step. Never persisted.
      api.useModelInput((view): ModelInput => {
        const rest = view.filter((m) => m.id !== LEGACY_SYSTEM_MESSAGE_ID);
        const system = createMessage({
          id: LEGACY_SYSTEM_MESSAGE_ID,
          data: { role: "system", content: text },
          createdBy: CREATED_BY,
        });
        return [system, ...rest];
      });
    },
  };
}

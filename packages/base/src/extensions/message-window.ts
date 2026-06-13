import type {
  AgentExtension,
  AgentExtensionApi,
  Message,
  PromptView,
} from "@goondan/openharness-types";

/** Does this message carry any tool-result parts (i.e. answer a tool-call)? */
function isToolResult(message: Message): boolean {
  if (message.data.role !== "tool") return false;
  const content = message.data.content;
  if (typeof content === "string") return false;
  return content.some(
    (part) =>
      part != null &&
      typeof part === "object" &&
      (part as { type?: string }).type === "tool-result",
  );
}

/**
 * MessageWindow extension — keeps the prompt view to roughly the most recent
 * `maxMessages` non-system messages.
 *
 * As of 1.0 this is a *projection* (F2), not a durable truncation. The old
 * `truncate` event mutated the log and made history unrecoverable; windowing the
 * view instead leaves the durable log intact (pair this with CompactionSummarize
 * if the log itself needs bounding — see CHANGELOG).
 *
 * Two boundary rules keep the windowed view valid:
 *  - leading system messages are always retained (the view invariant requires
 *    system messages to lead, and the system prompt must survive windowing);
 *  - the start boundary is extended backward off any tool-result so a windowed
 *    view never begins with an orphaned tool-result whose assistant tool-call
 *    was dropped.
 */
export function MessageWindow(config: { maxMessages: number }): AgentExtension {
  return {
    name: "message-window",

    register(api: AgentExtensionApi): void {
      api.prompt.transform("message-window", (view) => {
        const system = view.filter((m) => m.data.role === "system");
        const body = view.filter((m) => m.data.role !== "system");

        if (body.length <= config.maxMessages) return view;

        let start = body.length - config.maxMessages;
        // Extend the boundary left so the window never opens on a tool-result
        // severed from its assistant tool-call.
        while (start > 0 && isToolResult(body[start])) start--;

        return [...system, ...body.slice(start)] as PromptView;
      });
    },
  };
}

import type { LlmClient, LlmResponse, Message, ToolDefinition, ModelConfig, EnvRef } from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function OpenAI(config: {
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
}): ModelConfig {
  return { provider: "openai", ...config };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function transformMessages(messages: Message[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "system") {
      return {
        role: "system",
        content: typeof msg.content === "string" ? msg.content : "",
      };
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
      }
      // Array content: check for tool_result parts
      const hasTool = msg.content.some((p) => p.type === "tool_result");
      if (hasTool) {
        // OpenAI expects tool results as separate "tool" role messages
        return msg.content
          .filter((p) => p.type === "tool_result")
          .map((p) => {
            if (p.type !== "tool_result") return null;
            const resultContent =
              p.result.type === "text"
                ? p.result.text
                : JSON.stringify(p.result.type === "json" ? p.result.data : p.result.error);
            return {
              role: "tool",
              tool_call_id: p.toolCallId,
              content: resultContent,
            };
          })
          .filter(Boolean);
      }
      return {
        role: "user",
        content: msg.content
          .map((p) => (p.type === "text" ? { type: "text", text: p.text } : null))
          .filter(Boolean),
      };
    }

    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        return { role: "assistant", content: msg.content };
      }
      const textParts = msg.content
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      const toolCalls = msg.content
        .filter((p) => p.type === "tool_use")
        .map((p) => {
          if (p.type !== "tool_use") return null;
          return {
            id: p.toolCallId,
            type: "function",
            function: {
              name: p.toolName,
              arguments: JSON.stringify(p.args),
            },
          };
        })
        .filter(Boolean);

      return {
        role: "assistant",
        content: textParts || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }

    return { role: msg.role, content: typeof msg.content === "string" ? msg.content : "" };
  }).flat();
}

function transformTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function createOpenAIClient(
  model: string,
  apiKey: string,
  baseUrl?: string,
): LlmClient {
  return {
    async chat(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<LlmResponse> {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore -- openai is a peer dependency, not installed at build time
      const { default: OpenAISDK } = await import("openai");
      const client = new OpenAISDK({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });

      const openaiMessages = transformMessages(messages);

      const requestParams: Record<string, unknown> = {
        model,
        messages: openaiMessages,
      };

      if (tools.length > 0) {
        requestParams["tools"] = transformTools(tools);
        requestParams["tool_choice"] = "auto";
      }

      const response = await client.chat.completions.create(
        requestParams as Parameters<typeof client.chat.completions.create>[0],
      );

      const choice = response.choices[0];
      const message = choice?.message;

      const text = message?.content || undefined;

      const toolCalls = message?.tool_calls?.map(
        (tc: { id: string; function: { name: string; arguments: string } }) => ({
          toolCallId: tc.id,
          toolName: tc.function.name,
          args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        }),
      );

      return {
        text: text || undefined,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      };
    },
  };
}

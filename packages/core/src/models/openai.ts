import type { LlmClient, LlmChatOptions, LlmResponse, Message, ToolDefinition, ModelConfig, EnvRef } from "@goondan/openharness-types";

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
    const data = msg.data;

    if (data.role === "system") {
      return {
        role: "system",
        content: data.content,
      };
    }

    if (data.role === "user") {
      if (typeof data.content === "string") {
        return { role: "user", content: data.content };
      }

      return {
        role: "user",
        content: data.content
          .map((p) => {
            if (p.type === "text") return { type: "text", text: p.text };
            return null;
          })
          .filter(Boolean),
      };
    }

    if (data.role === "assistant") {
      if (typeof data.content === "string") {
        return { role: "assistant", content: data.content };
      }

      const textParts = data.content
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      const toolCalls = data.content
        .filter((p) => p.type === "tool-call")
        .map((p) => {
          if (p.type !== "tool-call") return null;
          return {
            id: p.toolCallId,
            type: "function",
            function: {
              name: p.toolName,
              arguments: JSON.stringify(p.input),
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

    if (data.role === "tool") {
      // OpenAI expects tool results as separate "tool" role messages with tool_call_id
      return data.content
          .filter((p) => p.type === "tool-result")
          .map((p) => {
            if (p.type !== "tool-result") return null;
            const resultContent =
              p.output.type === "text"
                ? p.output.value
                : p.output.type === "json"
                  ? JSON.stringify(p.output.value)
                  : p.output.type === "error-text"
                    ? p.output.value
                    : p.output.type === "error-json"
                      ? JSON.stringify(p.output.value)
                      : JSON.stringify(p.output);
            return {
              role: "tool",
              tool_call_id: p.toolCallId,
              content: resultContent,
            };
          })
          .filter(Boolean);
    }

    const fallback = data as { content?: unknown };
    return {
      role: "user",
      content: typeof fallback.content === "string" ? fallback.content : "",
    };
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
  // Cached SDK client — initialized lazily on first call, then reused
  let client: any;

  return {
    async chat(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, options?: LlmChatOptions): Promise<LlmResponse> {
      if (!client) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore -- openai is a peer dependency, not installed at build time
        const { default: OpenAISDK } = await import("openai");
        client = new OpenAISDK({
          apiKey,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
      }

      const openaiMessages = transformMessages(messages);

      const requestParams: Record<string, unknown> = {
        model: options?.model ?? model,
        messages: openaiMessages,
      };

      if (options?.maxTokens !== undefined) {
        requestParams["max_tokens"] = options.maxTokens;
      }
      if (options?.temperature !== undefined) {
        requestParams["temperature"] = options.temperature;
      }

      if (tools.length > 0) {
        requestParams["tools"] = transformTools(tools);
        requestParams["tool_choice"] = "auto";
      }

      type OpenAIResponse = {
        choices: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
      };
      const response = await client!.chat.completions.create(requestParams, { signal }) as OpenAIResponse;

      const choice = response.choices[0];
      const message = choice?.message;

      const text = message?.content || undefined;

      const toolCalls = message?.tool_calls?.map(
        (tc: { id: string; function: { name: string; arguments: string } }) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // Invalid JSON in tool arguments — use empty object; the tool handler will surface the error
            args = {};
          }
          return {
            toolCallId: tc.id,
            toolName: tc.function.name,
            args,
          };
        },
      );

      return {
        text: text || undefined,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      };
    },
  };
}

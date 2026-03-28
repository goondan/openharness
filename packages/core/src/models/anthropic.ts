import type { LlmClient, LlmChatOptions, LlmResponse, Message, ToolDefinition, ModelConfig, EnvRef } from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function Anthropic(config: {
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
}): ModelConfig {
  return { provider: "anthropic", ...config };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function transformMessages(messages: Message[]): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    const data = msg.data;

    if (data.role === "system") {
      // Anthropic takes system separately; skip here — extracted in chat()
      continue;
    }

    if (data.role === "user") {
      result.push({
        role: "user",
        content:
          typeof data.content === "string"
            ? data.content
            : data.content
                .map((part) => {
                  if (part.type === "text") return { type: "text", text: part.text };
                  return null;
                })
                .filter(Boolean),
      });
    } else if (data.role === "tool") {
      // Anthropic expects tool results as role: "user" with tool_result content blocks
      const toolResultContent = data.content
        .filter((part): part is Extract<typeof part, { type: "tool-result" }> => part.type === "tool-result")
        .map((part) => {
          const resultContent =
            part.output.type === "text"
              ? part.output.value
              : part.output.type === "json"
                ? JSON.stringify(part.output.value)
                : part.output.type === "error-text"
                  ? part.output.value
                  : part.output.type === "error-json"
                    ? JSON.stringify(part.output.value)
                    : JSON.stringify(part.output);
          return {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            content: resultContent,
          };
        });

      if (toolResultContent.length > 0) {
        result.push({ role: "user", content: toolResultContent });
      }
    } else if (data.role === "assistant") {
      result.push({
        role: "assistant",
        content:
          typeof data.content === "string"
            ? data.content
            : data.content
                .map((part) => {
                  if (part.type === "text") return { type: "text", text: part.text };
                  if (part.type === "tool-call") {
                    return {
                      type: "tool_use",
                      id: part.toolCallId,
                      name: part.toolName,
                      input: part.input,
                    };
                  }
                  return null;
                })
                .filter(Boolean),
      });
    }
  }

  return result;
}

function transformTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function createAnthropicClient(
  model: string,
  apiKey: string,
  baseUrl?: string,
): LlmClient {
  // Cached SDK client — initialized lazily on first call, then reused
  let client: InstanceType<{ new (opts: Record<string, unknown>): unknown }> | undefined;

  return {
    async chat(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, options?: LlmChatOptions): Promise<LlmResponse> {
      if (!client) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore -- @anthropic-ai/sdk is a peer dependency, not installed at build time
        const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
        client = new AnthropicSDK({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      }

      // Extract system message
      const systemMsg = messages.find((m) => m.data.role === "system");
      const systemText = systemMsg
        ? typeof systemMsg.data.content === "string"
          ? systemMsg.data.content
          : ""
        : undefined;

      const anthropicMessages = transformMessages(messages);

      const requestParams: Record<string, unknown> = {
        model: options?.model ?? model,
        max_tokens: options?.maxTokens ?? 4096,
        messages: anthropicMessages,
      };

      if (options?.temperature !== undefined) {
        requestParams["temperature"] = options.temperature;
      }

      if (systemText) {
        requestParams["system"] = systemText;
      }

      if (tools.length > 0) {
        requestParams["tools"] = transformTools(tools);
      }

      type AnthropicResponse = { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
      const response = await (client as { messages: { create: (p: unknown, o: unknown) => Promise<AnthropicResponse> } }).messages.create(requestParams, { signal });

      const text = response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("") || undefined;

      const toolCalls = response.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          toolCallId: c.id!,
          toolName: c.name!,
          args: c.input!,
        }));

      return {
        text: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    },
  };
}

import type { LlmClient, LlmResponse, Message, ToolDefinition, ModelConfig, EnvRef } from "@goondan/openharness-types";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function Google(config: {
  model: string;
  apiKey: string | EnvRef;
}): ModelConfig {
  return { provider: "google", ...config };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function transformContents(messages: Message[]): unknown[] {
  return messages
    .filter((m) => m.data.role !== "system")
    .map((msg) => {
      const data = msg.data;
      // Google SDK roles: "user", "model", "function"
      // role: "tool" messages carry functionResponse parts → role: "function"
      const role =
        data.role === "assistant" ? "model" : data.role === "tool" ? "function" : "user";

      if (typeof data.content === "string") {
        return {
          role,
          parts: [{ text: data.content }],
        };
      }

      const parts = data.content
        .map((part) => {
          if (part.type === "text") return { text: part.text };
          if (part.type === "tool-call") {
            return {
              functionCall: {
                name: part.toolName,
                args: part.input,
              },
            };
          }
          if (part.type === "tool-result") {
            // Google SDK uses function NAME (not call ID) to correlate responses.
            const funcName = part.toolName ?? part.toolCallId;
            const resultValue =
              part.output.type === "text"
                ? { output: part.output.value }
                : part.output.type === "json"
                  ? (part.output.value as Record<string, unknown>)
                  : part.output.type === "error-text"
                    ? { error: part.output.value }
                    : part.output.type === "error-json"
                      ? { error: part.output.value }
                      : { output: part.output };
            return {
              functionResponse: {
                name: funcName,
                response: resultValue,
              },
            };
          }
          return null;
        })
        .filter(Boolean);

      return { role, parts };
    });
}

function transformTools(tools: ToolDefinition[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

export function createGoogleClient(model: string, apiKey: string): LlmClient {
  // Cached genAI instance — initialized lazily on first call, then reused
  let genAI: any;

  return {
    async chat(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<LlmResponse> {
      if (!genAI) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore -- @google/generative-ai is a peer dependency, not installed at build time
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        genAI = new GoogleGenerativeAI(apiKey);
      }

      // Extract system instruction
      const systemMsg = messages.find((m) => m.data.role === "system");
      const systemInstruction = systemMsg
        ? typeof systemMsg.data.content === "string"
          ? systemMsg.data.content
          : ""
        : undefined;

      const modelConfig: Record<string, unknown> = {};
      if (systemInstruction) {
        modelConfig["systemInstruction"] = systemInstruction;
      }
      if (tools.length > 0) {
        modelConfig["tools"] = transformTools(tools);
      }

      const geminiModel = genAI!.getGenerativeModel({ model, ...modelConfig });

      const contents = transformContents(messages);

      const result = await geminiModel.generateContent({ contents }, { signal });

      const response = result.response;
      const candidate = response?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];

      let text: string | undefined;
      const toolCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];

      for (const part of parts as Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }>) {
        if (part.text) {
          text = (text ?? "") + part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            // Google SDK does not provide call IDs — generate a synthetic one so that
            // tool_result messages can be correlated back to the correct function call.
            toolCallId: `${part.functionCall.name}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            toolName: part.functionCall.name,
            args: part.functionCall.args,
          });
        }
      }

      return {
        text: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    },
  };
}

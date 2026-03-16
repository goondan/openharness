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
    .filter((m) => m.role !== "system")
    .map((msg) => {
      // Google SDK roles: "user", "model", "function"
      // role: "tool" messages carry functionResponse parts → role: "function"
      const role = msg.role === "assistant" ? "model" : msg.role === "tool" ? "function" : "user";

      if (typeof msg.content === "string") {
        return {
          role,
          parts: [{ text: msg.content }],
        };
      }

      const parts = msg.content
        .map((part) => {
          if (part.type === "text") return { text: part.text };
          if (part.type === "tool_use") {
            return {
              functionCall: {
                name: part.toolName,
                args: part.args,
              },
            };
          }
          if (part.type === "tool_result") {
            // Google SDK uses function NAME (not call ID) to correlate responses.
            const funcName = part.toolName ?? part.toolCallId;
            const resultValue =
              part.result.type === "text"
                ? { output: part.result.text }
                : part.result.type === "json"
                  ? (part.result.data as Record<string, unknown>)
                  : { error: part.result.error };
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
  type GeminiModel = { generateContent: (req: unknown, opts?: unknown) => Promise<{ response: { candidates?: Array<{ content?: { parts?: unknown[] } }> } }> };
  type GenAI = { getGenerativeModel: (config: Record<string, unknown>) => GeminiModel };
  // Cached genAI instance — initialized lazily on first call, then reused
  let genAI: GenAI | undefined;

  return {
    async chat(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<LlmResponse> {
      if (!genAI) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore -- @google/generative-ai is a peer dependency, not installed at build time
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        genAI = new GoogleGenerativeAI(apiKey);
      }

      // Extract system instruction
      const systemMsg = messages.find((m) => m.role === "system");
      const systemInstruction = systemMsg
        ? typeof systemMsg.content === "string"
          ? systemMsg.content
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

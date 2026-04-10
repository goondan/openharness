# Phase 2: Streaming via ai-sdk `streamText`

## Goal

Add streaming LLM responses to openharness so consumers (connectors, middleware, extensions) can observe text deltas in real-time via EventBus, while keeping the existing step loop and `generateText` fallback intact.

## Decision: EventBus-only streaming

Streaming is an **observation** concern. The step loop still needs the full response to decide whether to continue (tool calls present → next step) or stop (text-only → turn complete). Therefore streaming chunks are emitted as EventBus events — no API surface change to `processTurn` or `TurnResult`.

## Architecture

### 1. New `LlmClient.streamChat()` method

```typescript
// packages/types/src/middleware.ts

export interface LlmStreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCallDelta?: (toolCallId: string, toolName: string, argsDelta: string) => void;
}

export interface LlmClient {
  // Existing — unchanged
  chat(messages, tools, signal, options?): Promise<LlmResponse>;

  // New — optional. If not implemented, executeStep falls back to chat().
  streamChat?(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    callbacks: LlmStreamCallbacks,
    options?: LlmChatOptions,
  ): Promise<LlmResponse>;
}
```

`streamChat` has the same return type as `chat` — it resolves with the final `LlmResponse` once the stream completes. The difference is that it calls `callbacks.onTextDelta` / `callbacks.onToolCallDelta` while streaming.

Why callbacks instead of returning an AsyncIterable:
- `executeStep` needs the final `LlmResponse` to build the assistant message and run tools — that doesn't change.
- Callbacks let `executeStep` wire up EventBus emissions without managing stream consumption.
- The adapter internally `for await`s over ai-sdk's `fullStream` and calls the callbacks, then resolves the promise with the assembled `LlmResponse`.

### 2. New EventBus events

```typescript
// packages/types/src/events.ts

export interface StepTextDeltaPayload {
  type: "step.textDelta";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  delta: string;
}

export interface StepToolCallDeltaPayload {
  type: "step.toolCallDelta";
  turnId: string;
  agentName: string;
  conversationId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  argsDelta: string;
}
```

Added to `EventPayload` union. `step.textDelta` fires per text chunk. `step.toolCallDelta` fires per tool-call argument chunk (optional — mainly for debugging/observability). Both fire between `step.start` and `step.done`.

### 3. `ai-sdk-adapter.ts` changes

Add `streamChat` implementation using `streamText` + `fullStream`:

```typescript
import { streamText } from "ai";

async streamChat(messages, tools, signal, callbacks, options?) {
  const factory = await getProviderFactory(provider, apiKey, baseUrl);
  const model = factory.languageModel(options?.model ?? defaultModel);
  const aiTools = tools.length > 0 ? toAiSdkTools(tools) : undefined;

  const result = streamText({
    model,
    messages: toModelMessages(messages),
    ...(aiTools ? { tools: aiTools } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    abortSignal: signal,
  });

  // Consume fullStream for granular events
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        callbacks.onTextDelta?.(part.textDelta);
        break;
      case "tool-call-delta":
        callbacks.onToolCallDelta?.(part.toolCallId, part.toolName, part.argsTextDelta);
        break;
    }
  }

  // After stream completes, build LlmResponse from resolved promises
  const text = await result.text;
  const toolCalls = await result.toolCalls;

  return {
    text: text && text.trim().length > 0 ? text : undefined,
    toolCalls: toolCalls && toolCalls.length > 0
      ? toolCalls.map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: (tc.input ?? {}) as JsonObject,
        }))
      : undefined,
  };
}
```

### 4. `executeStep` changes

In `step.ts`, the core handler checks for `streamChat`:

```typescript
// If streaming is available, use it with EventBus callbacks
const llmResponse = llmClient.streamChat
  ? await llmClient.streamChat(
      messages, tools, stepCtx.abortSignal,
      {
        onTextDelta: (delta) => eventBus.emit("step.textDelta", {
          type: "step.textDelta",
          turnId, agentName, conversationId, stepNumber,
          delta,
        }),
        onToolCallDelta: (toolCallId, toolName, argsDelta) => eventBus.emit("step.toolCallDelta", {
          type: "step.toolCallDelta",
          turnId, agentName, conversationId, stepNumber,
          toolCallId, toolName, argsDelta,
        }),
      },
      // no LlmChatOptions override in step — use defaults
    )
  : await llmClient.chat(messages, tools, stepCtx.abortSignal);
```

No other step/turn logic changes. Tool execution, conversation append, step loop — all unchanged.

### 5. Configuration

No new config flag. Streaming is always-on when the adapter supports it (ai-sdk adapter always implements `streamChat`). If someone provides a custom `LlmClient` without `streamChat`, it gracefully falls back to `chat()`.

This follows openharness's principle of sensible defaults — streaming has no downside (the final `LlmResponse` is identical), and EventBus subscribers are opt-in.

## Files to change

| File | Change |
|------|--------|
| `packages/types/src/middleware.ts` | Add `LlmStreamCallbacks`, add `streamChat?` to `LlmClient` |
| `packages/types/src/events.ts` | Add `StepTextDeltaPayload`, `StepToolCallDeltaPayload`, extend `EventPayload` union |
| `packages/types/src/index.ts` | Export new types |
| `packages/core/src/models/ai-sdk-adapter.ts` | Add `streamChat` using `streamText` + `fullStream` |
| `packages/core/src/execution/step.ts` | Prefer `streamChat` over `chat` with EventBus wiring |
| Tests | New tests for streaming adapter, step streaming, event emissions |

## What does NOT change

- `LlmResponse` type — identical for both paths
- `TurnResult`, `StepResult` — no streaming data in results
- Step loop logic in `turn.ts` — unchanged
- Tool execution — unchanged
- Conversation state append — unchanged
- `chat()` method — remains, used as fallback

## Edge cases

- **Abort mid-stream**: ai-sdk's `streamText` respects `AbortSignal`. The `fullStream` loop breaks, and the resolved promise rejects. `executeStep` catches it and emits `step.error` as usual.
- **Empty text stream**: If the model returns only tool calls with no text, `onTextDelta` is simply never called. Final `LlmResponse.text` is `undefined` as before.
- **EventBus listener throws**: Already handled — `EventBus.emit` wraps listeners in try/catch with console.warn. A broken listener doesn't break the stream.

## Testing strategy

1. **Unit: `streamChat` adapter** — mock `streamText` to yield text-delta and tool-call parts, verify callbacks are called with correct deltas, verify final `LlmResponse` matches.
2. **Unit: `executeStep` streaming** — mock `streamChat` on LlmClient, verify `step.textDelta` events are emitted, verify fallback to `chat()` when `streamChat` is absent.
3. **Integration: full turn with streaming** — verify text deltas arrive between `step.start` and `step.done`, verify tool calls still execute correctly after streaming completes.

# Model Effort Interface Design

## Goal

OpenHarness model configuration must support provider request options that are applied to every model call. Anthropic users must be able to configure `effort` without intercepting or rewriting HTTP requests.

Karby will use this interface to run both its main Harness agents and `karby-subagent` with Anthropic effort `medium`. Existing Codex and Claude coding-tool complexity policies are outside this change.

## Current Problem

`ModelConfig.providerOptions` configures the AI SDK provider factory. Anthropic `effort`, however, is a request option and must be passed to AI SDK `generateText` and `streamText` through request-level `providerOptions.anthropic.effort`.

OpenHarness currently forwards model, temperature, and maximum output tokens to the AI SDK calls, but has no model-level or call-level request provider options. Omitting `effort` therefore leaves Opus requests at the provider's default effort.

## Public Interface

OpenHarness will distinguish provider-construction options from request provider options.

```ts
type ProviderRequestOptions = Record<string, Record<string, unknown>>;

interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string | EnvRef;
  baseUrl?: string | EnvRef;
  providerOptions?: Record<string, unknown>;
  requestProviderOptions?: ProviderRequestOptions;
}

interface LlmChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: ProviderRequestOptions;
}
```

The Anthropic model factory will add an ergonomic, typed option:

```ts
Anthropic({
  model: "claude-opus-5",
  effort: "medium",
});
```

Its accepted values are `low`, `medium`, `high`, and `max`. The factory removes `effort` from provider-construction settings and stores it as:

```ts
requestProviderOptions: {
  anthropic: { effort: "medium" },
}
```

OpenAI and Google factories are unchanged in this delivery. Their consumers can still use the generic request-provider-options interface when needed later.

## Runtime Data Flow

1. The model factory creates a `ModelConfig` containing provider-construction options and optional default request provider options.
2. `createLlmClient` passes both groups independently to the AI SDK adapter.
3. Each `chat` or `streamChat` call merges model defaults with call-specific `LlmChatOptions.providerOptions`.
4. The merged value is passed to AI SDK `generateText` or `streamText` as `providerOptions`.
5. AI SDK validates the provider-specific shape and serializes Anthropic effort into the outgoing request.

Provider blocks are shallow-merged independently. Call-specific keys win while unrelated model defaults remain present. For example, a call-specific Anthropic cache option does not remove the model's default effort.

## Karby Integration

Karby's `buildHarnessModelConfig` will set `effort: "medium"` for both direct Anthropic and Amazon-routed Anthropic models. Because all Karby Harness profiles use the same model-config builder, this covers Slack, API, background, CLI, and Harness subagent profiles.

This does not alter:

- Codex coding-agent reasoning effort selected by complexity.
- Claude coding-agent effort selected by complexity.
- Legacy non-Harness `task` tool model selection.
- Non-Anthropic Harness model overrides.

Karby's PRD, runtime specification, and TECH implementation notes will record the new default.

## Error Handling

- Invalid literal effort values fail TypeScript compilation for typed Anthropic factory callers.
- Dynamically produced invalid provider options are not silently normalized or replaced; AI SDK/provider validation remains authoritative.
- If no effort is configured, OpenHarness preserves existing behavior and omits request provider options.
- The implementation adds no fallback request path.

## Verification

OpenHarness tests will verify:

- `Anthropic({ effort: "medium" })` separates effort from provider-construction settings.
- Both `chat` and `streamChat` pass the configured effort to AI SDK.
- Call-specific provider options override matching default keys and preserve unrelated keys.
- Model configurations without request provider options retain their existing call shape.
- Type checking and the full OpenHarness test suite pass.

Karby tests will verify:

- The default Harness model request sent through the router contains Anthropic effort `medium`.
- Main and subagent profiles receive model configurations built with the same medium default.
- Existing max-output-token and router-model rewrite behavior remains unchanged.

## Delivery

1. Implement and release the OpenHarness `v1` package update.
2. Upgrade Karby's three OpenHarness packages with `pnpm`.
3. Configure Karby effort `medium`, update product/technical/runtime specifications, and run `pnpm fix` plus `pnpm check:type` and focused tests.
4. Push both branches and create the required pull requests.


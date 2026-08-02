# Model Effort Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider request options to OpenHarness, expose typed Anthropic effort configuration, and configure every Karby Harness profile to use effort `medium`.

**Architecture:** Keep AI SDK provider-construction settings separate from request-level provider options. `ModelConfig.requestProviderOptions` supplies model defaults, `LlmChatOptions.providerOptions` supplies per-call overrides, and the AI SDK adapter merges provider blocks before both non-streaming and streaming calls. Karby consumes the released OpenHarness interface through its existing shared Harness model builder.

**Tech Stack:** TypeScript, pnpm workspaces, AI SDK 6, Vitest, Node test runner, OpenHarness v1 packages, Karby Fastify/Harness runtime.

---

## File Map

### OpenHarness

- Modify `packages/types/src/config.ts`: declare and attach default request provider options to `ModelConfig`.
- Modify `packages/types/src/middleware.ts`: expose per-call provider options on `LlmChatOptions`.
- Modify `packages/types/src/index.ts`: export the new public type.
- Modify `packages/core/src/models/anthropic.ts`: add typed Anthropic effort and map it to request options.
- Modify `packages/core/src/models/index.ts`: pass model defaults into the AI SDK adapter.
- Modify `packages/core/src/models/ai-sdk-adapter.ts`: merge and forward request provider options for chat and streaming.
- Modify `packages/core/src/__tests__/models.test.ts`: test Anthropic factory separation.
- Modify `packages/core/src/__tests__/llm-chat-options.test.ts`: test chat defaults and override merging.
- Modify `packages/core/src/__tests__/streaming-adapter.test.ts`: test stream forwarding.
- Modify `spec/surface/configuration-api.md`: record the public contract and acceptance criteria.
- Modify `README.md`: add an Anthropic effort example.

### Karby

- Modify `apps/server/package.json` and `pnpm-lock.yaml` with `pnpm add` after the OpenHarness release exists.
- Modify `apps/server/src/ai/harness/config/model.ts`: set Anthropic effort `medium` in the shared builder.
- Modify `apps/server/src/ai/harness/testing/model-config.test.ts`: assert outgoing router request effort.
- Modify `PRD.md`: state the main/subagent effort requirement.
- Modify `spec/runtime/harness-lifecycle.md`: define the runtime behavior.
- Modify `TECH.md`: record the OpenHarness interface and implementation strategy.

### Explicitly Unchanged

- `apps/server/src/ai/coding/codex/runner.ts`
- `apps/server/src/ai/coding/claude/runner.ts`
- `apps/server/src/ai/tools/task/task.tool.ts`

## Task 1: OpenHarness Public Types and Anthropic Factory

**Files:**
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/src/middleware.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/core/src/models/anthropic.ts`
- Test: `packages/core/src/__tests__/models.test.ts`

- [ ] **Step 1: Write the failing Anthropic factory test**

Add this case inside `describe("Anthropic()")`:

```ts
it("maps effort to request provider options without leaking it into provider settings", () => {
  const config = Anthropic({
    model: "claude-opus-5",
    apiKey: "sk-ant-test",
    effort: "medium",
  });

  expect(config.providerOptions).toEqual({ apiKey: "sk-ant-test" });
  expect(config.requestProviderOptions).toEqual({
    anthropic: { effort: "medium" },
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the interface is absent**

Run:

```bash
pnpm --filter @goondan/openharness test -- packages/core/src/__tests__/models.test.ts
```

Expected: FAIL because `effort` is not accepted by `AnthropicConfig` and `requestProviderOptions` is not present.

- [ ] **Step 3: Add the minimal public types**

In `packages/types/src/config.ts`, add:

```ts
export type ProviderRequestOptions = Record<string, Record<string, JsonValue>>;

export interface ModelConfig {
  provider: string;
  model: string;
  apiKey?: string | EnvRef;
  baseUrl?: string | EnvRef;
  providerOptions?: Record<string, unknown>;
  requestProviderOptions?: ProviderRequestOptions;
}
```

In `packages/types/src/middleware.ts`, import `ProviderRequestOptions` as a type and extend the call options:

```ts
export interface LlmChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  providerOptions?: ProviderRequestOptions;
}
```

Export `ProviderRequestOptions` from the existing config export block in `packages/types/src/index.ts`.

- [ ] **Step 4: Implement typed Anthropic effort mapping**

In `packages/core/src/models/anthropic.ts`, add and use:

```ts
export type AnthropicEffort = "low" | "medium" | "high" | "max";

export type AnthropicConfig = {
  model: string;
  baseUrl?: string | EnvRef;
  effort?: AnthropicEffort;
} & EnvResolvable<AnthropicProviderSettings>;

export function Anthropic(config: AnthropicConfig): ModelConfig {
  const { model, baseUrl, effort, ...providerOptions } = config;
  const normalizedProviderOptions = {
    ...providerOptions,
    ...(providerOptions.baseURL === undefined && baseUrl !== undefined
      ? { baseURL: baseUrl }
      : {}),
  };

  return {
    provider: "anthropic",
    model,
    ...(normalizedProviderOptions.apiKey !== undefined
      ? { apiKey: normalizedProviderOptions.apiKey }
      : {}),
    ...(normalizedProviderOptions.baseURL !== undefined
      ? { baseUrl: normalizedProviderOptions.baseURL }
      : {}),
    ...(Object.keys(normalizedProviderOptions).length > 0
      ? { providerOptions: normalizedProviderOptions }
      : {}),
    ...(effort !== undefined
      ? { requestProviderOptions: { anthropic: { effort } } }
      : {}),
  };
}
```

- [ ] **Step 5: Run the focused factory tests**

Run:

```bash
pnpm --filter @goondan/openharness test -- packages/core/src/__tests__/models.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the public contract**

```bash
git add packages/types/src/config.ts packages/types/src/middleware.ts packages/types/src/index.ts packages/core/src/models/anthropic.ts packages/core/src/__tests__/models.test.ts
git commit -m "feat(models): add Anthropic effort configuration"
```

## Task 2: Forward and Merge Provider Request Options

**Files:**
- Modify: `packages/core/src/models/index.ts`
- Modify: `packages/core/src/models/ai-sdk-adapter.ts`
- Test: `packages/core/src/__tests__/llm-chat-options.test.ts`
- Test: `packages/core/src/__tests__/streaming-adapter.test.ts`

- [ ] **Step 1: Write failing non-streaming merge tests**

Add two Anthropic cases to `packages/core/src/__tests__/llm-chat-options.test.ts`:

```ts
it("Anthropic: forwards model-level request provider options", async () => {
  const client = createFn({
    provider: "anthropic",
    model: "claude-opus-5",
    requestProviderOptions: { anthropic: { effort: "medium" } },
  });

  await client.chat(mockMessages, emptyTools, signal);

  expect(capturedArgs[0]["providerOptions"]).toEqual({
    anthropic: { effort: "medium" },
  });
});

it("Anthropic: call provider options override matching defaults and preserve siblings", async () => {
  const client = createFn({
    provider: "anthropic",
    model: "claude-opus-5",
    requestProviderOptions: {
      anthropic: { effort: "medium", sendReasoning: true },
    },
  });

  await client.chat(mockMessages, emptyTools, signal, {
    providerOptions: {
      anthropic: { effort: "low" },
    },
  });

  expect(capturedArgs[0]["providerOptions"]).toEqual({
    anthropic: { effort: "low", sendReasoning: true },
  });
});
```

- [ ] **Step 2: Extend the streaming test with provider options**

In the existing `passes LlmChatOptions ... to streamText` test, pass:

```ts
{
  model: "gemini-1.5-flash",
  temperature: 0.7,
  maxTokens: 1024,
  providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
}
```

Then assert:

```ts
expect(capturedArgs!["providerOptions"]).toEqual({
  google: { thinkingConfig: { thinkingBudget: 0 } },
});
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @goondan/openharness test -- packages/core/src/__tests__/llm-chat-options.test.ts packages/core/src/__tests__/streaming-adapter.test.ts
```

Expected: FAIL because the adapter does not accept or forward provider request options.

- [ ] **Step 4: Implement provider-block merging**

In `packages/core/src/models/ai-sdk-adapter.ts`, add:

```ts
function mergeProviderOptions(
  defaults: ProviderRequestOptions | undefined,
  overrides: ProviderRequestOptions | undefined,
): ProviderRequestOptions | undefined {
  if (!defaults && !overrides) return undefined;

  const merged: ProviderRequestOptions = { ...(defaults ?? {}) };
  for (const [provider, options] of Object.entries(overrides ?? {})) {
    merged[provider] = {
      ...(defaults?.[provider] ?? {}),
      ...options,
    };
  }
  return merged;
}
```

Extend `createAiSdkClient` with `defaultRequestProviderOptions?: ProviderRequestOptions`. In both `chat` and `streamChat`, compute:

```ts
const providerOptions = mergeProviderOptions(
  defaultRequestProviderOptions,
  options?.providerOptions,
);
```

Add this property to both AI SDK calls only when defined:

```ts
...(providerOptions ? { providerOptions } : {}),
```

In `packages/core/src/models/index.ts`, pass `config.requestProviderOptions` as the fourth adapter argument.

- [ ] **Step 5: Run focused adapter tests**

Run:

```bash
pnpm --filter @goondan/openharness test -- packages/core/src/__tests__/llm-chat-options.test.ts packages/core/src/__tests__/streaming-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit runtime forwarding**

```bash
git add packages/core/src/models/index.ts packages/core/src/models/ai-sdk-adapter.ts packages/core/src/__tests__/llm-chat-options.test.ts packages/core/src/__tests__/streaming-adapter.test.ts
git commit -m "feat(core): forward provider request options"
```

## Task 3: OpenHarness Specification and Verification

**Files:**
- Modify: `spec/surface/configuration-api.md`
- Modify: `README.md`

- [ ] **Step 1: Document the interface contract**

Add `requestProviderOptions` to the `ModelConfig` interface in `spec/surface/configuration-api.md`, describe model defaults versus call overrides, and add these acceptance criteria:

```md
- Given an Anthropic model configured with `effort: "medium"`, When chat or streamChat invokes AI SDK, Then `providerOptions.anthropic.effort` is `medium`.
- Given model defaults and call-specific options for the same provider, When the call runs, Then call keys override matching defaults and unrelated default keys remain present.
```

- [ ] **Step 2: Add a README example**

Add an Anthropic model example that includes:

```ts
model: Anthropic({
  model: "claude-opus-5",
  apiKey: env("ANTHROPIC_API_KEY"),
  effort: "medium",
}),
```

- [ ] **Step 3: Run complete OpenHarness verification**

Run:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm exec biome lint --diagnostic-level=error packages/*/src test-e2e
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md spec/surface/configuration-api.md
git commit -m "docs: document provider request options"
```

## Task 4: Prepare and Publish the OpenHarness Prerelease

**Files:**
- Modify: `packages/adapters/package.json`
- Modify: `packages/base/package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/types/package.json`

- [ ] **Step 1: Bump the workspace prerelease version**

Run from the OpenHarness repository:

```bash
pnpm --filter './packages/*' exec pnpm version 1.0.0-rc.6 --no-git-tag-version
```

Expected: each publishable package reports `v1.0.0-rc.6`.

- [ ] **Step 2: Rebuild and verify package metadata**

Run:

```bash
pnpm build
pnpm typecheck
pnpm test
rg -n '"version": "1.0.0-rc.6"' packages/*/package.json
```

Expected: all checks pass and five package manifests match.

- [ ] **Step 3: Commit release metadata**

```bash
git add packages/*/package.json
git commit -m "chore(release): prepare 1.0.0-rc.6"
```

- [ ] **Step 4: Push and create the OpenHarness PR**

```bash
git push -u origin codex/model-effort-interface
gh pr create --repo goondan/openharness --base v1 --head codex/model-effort-interface --title "feat: support model effort configuration" --body "Adds generic request provider options and typed Anthropic effort configuration. Verifies chat, streaming, build, typecheck, tests, and lint."
```

Expected: a PR URL is returned. Do not publish packages until the PR is merged or the user explicitly authorizes publishing the branch build.

- [ ] **Step 5: Publish after the merge/authorization checkpoint**

After the approved commit is on the release branch, run:

```bash
pnpm -r --filter './packages/*' publish --tag next --no-git-checks
```

Expected: `@goondan/openharness`, `@goondan/openharness-types`, and `@goondan/openharness-base` version `1.0.0-rc.6` are resolvable from the registry before changing Karby.

## Task 5: Upgrade Karby and Set Harness Effort Medium

**Files:**
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/server/src/ai/harness/config/model.ts`
- Test: `apps/server/src/ai/harness/testing/model-config.test.ts`

- [ ] **Step 1: Upgrade OpenHarness packages using pnpm**

Run from the Karby repository after rc.6 is published:

```bash
pnpm --filter @karby/server add @goondan/openharness@1.0.0-rc.6 @goondan/openharness-base@1.0.0-rc.6 @goondan/openharness-types@1.0.0-rc.6
```

Expected: `apps/server/package.json` and `pnpm-lock.yaml` resolve all three packages to rc.6.

- [ ] **Step 2: Write the failing router request test**

Add to `apps/server/src/ai/harness/testing/model-config.test.ts`:

```ts
test("Harness Anthropic requests use medium effort", async () => {
  const { body } = await captureHarnessAnthropicBody(
    [{ id: "user-1", data: { role: "user", content: "Hello" } }],
    undefined,
    DEFAULT_HARNESS_MODEL,
  );

  assert.equal(body.effort, "medium");
});
```

- [ ] **Step 3: Run the focused test and verify failure**

Run:

```bash
pnpm --filter @karby/server exec tsx --test src/ai/harness/testing/model-config.test.ts
```

Expected: FAIL because the request body has no `effort`.

- [ ] **Step 4: Configure the shared Anthropic builder**

In both the `anthropic` and `amazon` branches of `buildHarnessModelConfig`, add:

```ts
effort: "medium",
```

Do not add effort to the OpenAI/Google branch.

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm --filter @karby/server exec tsx --test src/ai/harness/testing/model-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the Karby runtime change**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/ai/harness/config/model.ts apps/server/src/ai/harness/testing/model-config.test.ts
git commit -m "feat(harness): set Anthropic effort to medium"
```

## Task 6: Synchronize Karby Specifications and Verify

**Files:**
- Modify: `PRD.md`
- Modify: `spec/runtime/harness-lifecycle.md`
- Modify: `TECH.md`

- [ ] **Step 1: Record the product requirement**

Add this requirement to the Harness/model requirements in `PRD.md`:

```md
- Karby의 메인 Harness 에이전트와 Harness task 서브에이전트는 Anthropic 모델 요청에 effort `medium`을 기본 적용해야 한다. Codex/Claude 코딩 에이전트는 작업 복잡도별 기존 reasoning effort 정책을 유지해야 한다.
```

- [ ] **Step 2: Record the runtime contract**

Add this runtime contract to the Harness model-selection flow in `spec/runtime/harness-lifecycle.md`:

```md
- 공통 Harness 모델 구성이 Anthropic 또는 Amazon-routed Anthropic 모델을 선택하면 main/subagent profile 모두 요청 provider option `anthropic.effort=medium`을 전달한다. Google/OpenAI 등 비Anthropic override에는 이 옵션을 전달하지 않는다.
```

- [ ] **Step 3: Record the implementation strategy**

Add this implementation note to the Harness model section in `TECH.md`:

```md
- Anthropic Harness effort는 OpenHarness `ModelConfig.requestProviderOptions` 경계에서 관리한다. Karby는 typed `Anthropic({ effort: "medium" })` factory를 사용하며 router fetch에서 effort를 임의 주입하지 않는다. 이 설정은 main과 `karby-subagent`에 공통 적용하고 코딩 에이전트의 complexity별 effort와 분리한다.
```

- [ ] **Step 4: Run required Karby checks**

Run:

```bash
pnpm fix
pnpm check:type
pnpm --filter @karby/server exec tsx --test src/ai/harness/testing/model-config.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit synchronized specifications**

```bash
git add PRD.md TECH.md spec/runtime/harness-lifecycle.md
git commit -m "docs: specify medium Harness effort"
```

- [ ] **Step 6: Push and create the Karby PR**

```bash
git push -u origin codex/harness-medium-effort
gh pr create --repo karrot-emu/karby --base main --head codex/harness-medium-effort --title "feat(harness): configure medium Anthropic effort" --body "Upgrades OpenHarness request-provider-option support and applies Anthropic effort medium to every Karby Harness profile. Keeps coding-agent complexity mappings unchanged."
```

Expected: a PR URL is returned with the OpenHarness release dependency and verification results documented.

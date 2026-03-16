# OpenHarness v2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure barebone composable LLM agent harness where core owns only the execution loop and all behavior is controlled via Extension composition.

**Architecture:** Monorepo (pnpm workspaces) with 4 packages: `types` (pure types), `core` (execution loop + middleware + registries + ingress), `cli` (oh command), `base` (default Extensions/Tools). Core uses event-sourced conversation state, chain-of-responsibility middleware, and fire-and-forget observability events. Bottom-up implementation: types → core internals → core surface → CLI → base.

**Tech Stack:** TypeScript 5.x (ESM only), Node.js 20+, pnpm workspaces, Vitest for testing, tsup for bundling, Ajv for JSON Schema validation.

---

## File Structure

```
openharness_v2/
├── pnpm-workspace.yaml
├── package.json                    # root (devDependencies, scripts)
├── tsconfig.base.json              # shared TS config
├── vitest.workspace.ts
│
├── packages/
│   ├── types/                      # @goondan/openharness-types
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # re-exports all types
│   │       ├── extension.ts        # Extension, ExtensionApi, ExtensionInfo
│   │       ├── tool.ts             # ToolDefinition, ToolContext, ToolResult, ToolInfo
│   │       ├── conversation.ts     # ConversationState, MessageEvent, Message, ContentPart
│   │       ├── middleware.ts       # Middleware types, MiddlewareOptions, Context types
│   │       ├── ingress.ts          # Connector, InboundEnvelope, ConnectionConfig, RoutingRule, IngressApi
│   │       ├── config.ts           # HarnessConfig, AgentConfig, ModelConfig, defineHarness, env
│   │       ├── runtime.ts          # HarnessRuntime, ProcessTurnOptions, TurnResult, ControlApi
│   │       └── events.ts           # EventPayload, all event names
│   │
│   ├── core/                       # @goondan/openharness
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # public exports: createHarness, defineHarness, env, model factories
│   │       ├── create-harness.ts   # createHarness() implementation
│   │       ├── harness-runtime.ts  # HarnessRuntime class
│   │       ├── conversation-state.ts  # ConversationState impl (event sourcing)
│   │       ├── middleware-chain.ts # buildChain(), middleware sorting, execution
│   │       ├── extension-registry.ts  # Extension registration, ExtensionApi factory
│   │       ├── tool-registry.ts    # ToolRegistry (static + dynamic, JSON Schema validation)
│   │       ├── event-bus.ts        # EventBus (fire-and-forget, error-swallowing)
│   │       ├── execution/
│   │       │   ├── turn.ts         # executeTurn()
│   │       │   ├── step.ts         # executeStep()
│   │       │   └── tool-call.ts    # executeToolCall()
│   │       ├── ingress/
│   │       │   ├── pipeline.ts     # IngressPipeline (4-stage)
│   │       │   └── router.ts       # RoutingEngine (rule matching, conversationId resolution)
│   │       ├── models/
│   │       │   ├── index.ts        # re-exports
│   │       │   ├── anthropic.ts    # Anthropic() factory
│   │       │   ├── openai.ts       # OpenAI() factory
│   │       │   └── google.ts       # Google() factory
│   │       ├── env.ts              # env() helper + EnvRef
│   │       └── errors.ts           # Custom error classes
│   │
│   ├── cli/                        # @goondan/openharness-cli
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # CLI entry point
│   │       ├── commands/
│   │       │   ├── run.ts          # oh run "<text>"
│   │       │   └── repl.ts         # oh / oh repl
│   │       ├── config-loader.ts    # load harness.config.ts
│   │       └── env-loader.ts       # .env file loading
│   │
│   └── base/                       # @goondan/openharness-base
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts            # re-exports
│           ├── extensions/
│           │   ├── context-message.ts   # ContextMessage()
│           │   ├── message-window.ts    # MessageWindow()
│           │   ├── compaction-summarize.ts  # CompactionSummarize()
│           │   ├── logging.ts           # Logging()
│           │   ├── tool-search.ts       # ToolSearch()
│           │   └── required-tools-guard.ts  # RequiredToolsGuard()
│           └── tools/
│               ├── bash.ts             # Bash()
│               ├── file-system.ts      # FileSystem()
│               ├── http-fetch.ts       # HttpFetch()
│               ├── json-query.ts       # JsonQuery()
│               ├── text-transform.ts   # TextTransform()
│               └── wait.ts             # Wait()
```

---

## Chunk 1: Monorepo Scaffolding + Types Package

### Task 1: Initialize monorepo

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `vitest.workspace.ts`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "openharness",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "pnpm -r run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r run typecheck",
    "clean": "pnpm -r run clean"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "tsup": "^8.4.0"
  }
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

- [ ] **Step 4: Create vitest.workspace.ts**

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace(["packages/*"]);
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.env
```

- [ ] **Step 6: Run pnpm install**

Run: `pnpm install`
Expected: lockfile generated, devDependencies installed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: initialize monorepo with pnpm workspaces"
```

### Task 2: Types package — core types

**Files:**
- Create: `packages/types/package.json`
- Create: `packages/types/tsconfig.json`
- Create: `packages/types/src/index.ts`
- Create: `packages/types/src/conversation.ts`
- Create: `packages/types/src/middleware.ts`
- Create: `packages/types/src/tool.ts`
- Create: `packages/types/src/extension.ts`
- Create: `packages/types/src/ingress.ts`
- Create: `packages/types/src/config.ts`
- Create: `packages/types/src/runtime.ts`
- Create: `packages/types/src/events.ts`

- [ ] **Step 1: Create types package.json**

```json
{
  "name": "@goondan/openharness-types",
  "version": "2.0.0-alpha.0",
  "type": "module",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "workspace:*",
    "tsup": "workspace:*"
  }
}
```

- [ ] **Step 2: Create tsconfig.json for types**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write conversation.ts — Message & ConversationState types**

Define: `Message`, `MessageContent`, `ContentPart`, `MessageEvent` (4 variants: append/replace/remove/truncate), `ConversationState` interface (readonly events, readonly messages, restore, emit).

Per spec: `spec/core/conversation-state.md` §5.1–5.3.

- [ ] **Step 4: Write middleware.ts — Middleware types & context types**

Define: `MiddlewareLevel` (including ingress levels), `MiddlewareOptions`, `TurnMiddleware`, `StepMiddleware`, `ToolCallMiddleware`, `VerifyMiddleware`, `NormalizeMiddleware`, `RouteMiddleware`, `DispatchMiddleware`, `TurnContext`, `StepContext` (extends TurnContext), `ToolCallContext` (extends StepContext), `TurnResult`, `StepResult` (LLM response text + tool call list for that step), `StepSummary`, `ToolCallSummary`, `LlmClient`, `LlmResponse`.

Note: `ToolCallContext` (middleware context with toolName/toolArgs, extends StepContext) is distinct from `ToolContext` (handler context with conversationId/agentName/abortSignal, defined in tool.ts).

Note: `StepResult` should contain: `{ text?: string; toolCalls: Array<{ toolCallId: string; toolName: string; args: JsonObject; result?: ToolResult }>; }`.

Per spec: `spec/core/execution-loop.md` §5.1–5.4, `spec/core/extension-system.md` §5.2 (Ingress middleware levels).

- [ ] **Step 5: Write tool.ts — Tool types**

Define: `ToolDefinition`, `ToolContext`, `ToolResult` (text/json/error union), `ToolInfo`, `JsonSchema`, `JsonObject`, `JsonValue`.

Per spec: `spec/core/extension-system.md` §5.4.

- [ ] **Step 6: Write extension.ts — Extension & ExtensionApi types**

Define: `Extension`, `ExtensionApi` (pipeline, tools, on, conversation, runtime), `RuntimeInfo`, `ModelInfo`, `ExtensionInfo`, `AgentInfo`, `ConnectionInfo`.

Per spec: `spec/core/extension-system.md` §5.1–5.3.

- [ ] **Step 7: Write ingress.ts — Ingress types**

Define: `Connector`, `ConnectorContext`, `InboundEnvelope`, `InboundContentPart`, `EventSource`, `ConnectionConfig`, `RoutingRule`, `RoutingMatch`, `IngressApi` (including `listConnections()`), `IngressAcceptResult` (with `turnId` field for async tracking).

Per spec: `spec/ingress/ingress-pipeline.md` §5.1–5.5.

- [ ] **Step 8: Write config.ts — Configuration types**

Define: `HarnessConfig`, `AgentConfig` (no systemPrompt — Extension responsibility), `ModelConfig` (provider: string, model: string, apiKey: string | EnvRef, baseUrl?: string), `ProcessTurnOptions`, `EnvRef`. `defineHarness` (identity function) lives here in types.

Per spec: `spec/surface/configuration-api.md` §5.1, §5.5.

- [ ] **Step 9: Write runtime.ts — Runtime types**

Define: `HarnessRuntime`, `ControlApi`, `AbortResult`.

Per spec: `spec/surface/configuration-api.md` §5.3.

- [ ] **Step 10: Write events.ts — Event payload types**

Define: `CoreEventName` (all 12 event names), `EventPayload`, typed payload per event.

Per spec: `spec/core/execution-loop.md` §5.3, `spec/ingress/ingress-pipeline.md` §5.5.

- [ ] **Step 11: Write index.ts — re-exports**

Re-export everything from all modules.

- [ ] **Step 12: Build & typecheck**

Run: `cd packages/types && pnpm build && pnpm typecheck`
Expected: No errors.

- [ ] **Step 13: Commit**

```bash
git add packages/types
git commit -m "feat(types): add all type definitions for openharness v2"
```

---

## Chunk 2: Core — Conversation State + Event Bus + Middleware Chain

These are the three foundational internal modules that everything else builds on.

### Task 3: ConversationState implementation

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/conversation-state.ts`
- Create: `packages/core/src/__tests__/conversation-state.test.ts`

- [ ] **Step 1: Create core package.json**

```json
{
  "name": "@goondan/openharness",
  "version": "2.0.0-alpha.0",
  "type": "module",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./models": { "import": "./dist/models/index.js", "types": "./dist/models/index.d.ts" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts src/models/index.ts --format esm --dts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@goondan/openharness-types": "workspace:*",
    "ajv": "^8.17.0"
  },
  "devDependencies": {
    "typescript": "workspace:*",
    "tsup": "workspace:*",
    "vitest": "workspace:*"
  }
}
```

- [ ] **Step 2: Write failing tests for ConversationState**

Tests to cover (per spec `spec/core/conversation-state.md` §8):
1. append 3 events → messages returns 3 messages in order
2. append 3 + replace 1 → replaced message reflects change
3. append 5 + truncate(keepLast: 3) → only last 3 messages
4. remove event removes the correct message
5. invalid reference (replace non-existent ID) → throws error, events unchanged
6. restore(events) replays to correct messages
7. restore with empty array → empty state
8. restore overwrites existing state
9. same events replayed twice → identical messages (determinism)
10. emit outside Turn context → throws error

Run: `cd packages/core && pnpm test`
Expected: All 10 tests FAIL (not yet implemented).

- [ ] **Step 3: Implement ConversationState**

`packages/core/src/conversation-state.ts`:
- Class `ConversationStateImpl` implementing `ConversationState`
- Internal `_events: MessageEvent[]` array (append-only)
- `_messages: Message[]` derived via `replay()`
- `emit(event)`: validate → append to events → recompute messages
- `restore(events)`: replace events → recompute messages
- `replay()`: iterate events applying append/replace/remove/truncate
- Incremental optimization: track last applied index, only replay new events for append. Full replay for restore.
- `_turnActive` flag: emit() throws if not in Turn context.

- [ ] **Step 4: Run tests**

Run: `cd packages/core && pnpm test`
Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): implement event-sourced ConversationState"
```

### Task 4: EventBus implementation

**Files:**
- Create: `packages/core/src/event-bus.ts`
- Create: `packages/core/src/__tests__/event-bus.test.ts`

- [ ] **Step 1: Write failing tests for EventBus**

Tests:
1. Listener receives emitted event with correct payload
2. Multiple listeners all receive the same event
3. Listener that throws does NOT affect other listeners
4. Listener that throws does NOT affect the emitter (fire-and-forget)
5. Unsubscribe removes listener

Run: `cd packages/core && pnpm test -- event-bus`
Expected: All FAIL.

- [ ] **Step 2: Implement EventBus**

`packages/core/src/event-bus.ts`:
- Class `EventBus` with `on(event, listener)`, `emit(event, payload)`
- `emit` iterates listeners, wrapping each in try/catch (error → console.warn, never rethrow)
- Returns void (fire-and-forget, no awaiting listeners)

- [ ] **Step 3: Run tests**

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/event-bus.ts packages/core/src/__tests__/event-bus.test.ts
git commit -m "feat(core): implement fire-and-forget EventBus"
```

### Task 5: Middleware chain implementation

**Files:**
- Create: `packages/core/src/middleware-chain.ts`
- Create: `packages/core/src/__tests__/middleware-chain.test.ts`

- [ ] **Step 1: Write failing tests for middleware chain**

Tests:
1. Empty chain → core handler runs directly
2. Single middleware wraps core handler (before/after)
3. Multiple middlewares execute in priority order (50 → 100 → 200)
4. Same priority → declaration (registration) order
5. Middleware that doesn't call next() → core handler NOT executed
6. Middleware that throws → error propagates to caller
7. Middleware can modify context before next()
8. Middleware can modify result after next()
9. Extension isolation (NFR-003): middleware A throws → middleware B (lower priority) still functions in subsequent calls

Run: `cd packages/core && pnpm test -- middleware-chain`
Expected: All FAIL.

- [ ] **Step 2: Implement middleware chain**

`packages/core/src/middleware-chain.ts`:
- `buildChain<Ctx, Res>(middlewares: Array<{handler, priority, order}>, coreHandler: (ctx: Ctx) => Promise<Res>): (ctx: Ctx) => Promise<Res>`
- Sort by priority (asc), then by registration order (asc)
- Build chain from inside-out: start with coreHandler, wrap with last middleware first
- Each middleware receives (ctx, next) where next calls the inner function

- [ ] **Step 3: Run tests**

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/middleware-chain.ts packages/core/src/__tests__/middleware-chain.test.ts
git commit -m "feat(core): implement chain-of-responsibility middleware"
```

---

## Chunk 3: Core — Tool Registry + Extension Registry

### Task 6: Tool Registry

**Files:**
- Create: `packages/core/src/tool-registry.ts`
- Create: `packages/core/src/__tests__/tool-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
1. Register tool → list() includes it
2. Register duplicate name → throws
3. Remove tool → list() excludes it
4. Remove non-existent → throws
5. JSON Schema validation: valid args pass
6. JSON Schema validation: invalid args → returns validation error
7. Tool handler called with correct ToolContext
8. Tool handler exception → ToolResult type "error"

- [ ] **Step 2: Implement ToolRegistry**

`packages/core/src/tool-registry.ts`:
- Class `ToolRegistry` with `register(tool)`, `remove(name)`, `list()`, `get(name)`, `validate(name, args)`
- Uses Ajv for JSON Schema validation. Single Ajv instance, compile on register.
- `execute(name, args, ctx)`: validate → call handler → catch errors → return ToolResult

- [ ] **Step 3: Run tests & commit**

Expected: All PASS.

```bash
git commit -m "feat(core): implement ToolRegistry with JSON Schema validation"
```

### Task 7: Extension Registry + ExtensionApi

**Files:**
- Create: `packages/core/src/extension-registry.ts`
- Create: `packages/core/src/__tests__/extension-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
1. Register extension → extension.register(api) called with ExtensionApi
2. Duplicate extension name → throws
3. Extension.register exception → registration fails, no partial state
4. ExtensionApi.pipeline.register adds middleware to correct level
5. ExtensionApi.tools delegates to ToolRegistry
6. ExtensionApi.on delegates to EventBus
7. ExtensionApi.runtime returns correct agent info
8. Declaration order preserved across multiple extensions

- [ ] **Step 2: Implement ExtensionRegistry + ExtensionApi factory**

`packages/core/src/extension-registry.ts`:
- `registerExtensions(extensions, {toolRegistry, eventBus, middlewareRegistry, runtimeInfo, conversationStateProxy})` → calls each extension.register(api)
- `createExtensionApi(...)` builds the 5-surface ExtensionApi object:
  - `pipeline`: delegates to middleware registry
  - `tools`: delegates to tool registry
  - `on`: delegates to event bus
  - `conversation`: proxy to current Turn's ConversationState
  - `runtime`: readonly config snapshot

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): implement Extension registration and ExtensionApi"
```

---

## Chunk 4: Core — Execution Loop (Turn / Step / ToolCall)

### Task 8: ToolCall execution

**Files:**
- Create: `packages/core/src/execution/tool-call.ts`
- Create: `packages/core/src/__tests__/execution/tool-call.test.ts`

- [ ] **Step 1: Write failing tests**

Tests (per EXEC-TOOLCALL-01):
1. Valid tool call → handler invoked, result returned
2. Tool not in registry → error result returned to LLM
3. JSON Schema validation fails → error result, handler NOT called
4. ToolCall middleware wraps execution
5. Middleware blocks (no next()) → handler NOT called, middleware result used
6. Handler throws → tool.error event emitted, error result returned
7. AbortSignal passed to handler in ToolContext
8. tool.start and tool.done events emitted

- [ ] **Step 2: Implement executeToolCall()**

`packages/core/src/execution/tool-call.ts`:
- `executeToolCall(ctx: ToolCallContext, {toolRegistry, middlewareChain, eventBus})`
- Validate args → build middleware chain → execute → emit events

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): implement ToolCall execution with middleware"
```

### Task 9: Step execution

**Files:**
- Create: `packages/core/src/execution/step.ts`
- Create: `packages/core/src/__tests__/execution/step.test.ts`

- [ ] **Step 1: Write failing tests**

Tests (per EXEC-STEP-01):
1. LLM returns text only → Step completes, no tool calls
2. LLM returns tool calls → each tool executed via executeToolCall
3. Step middleware can modify conversation before next()
4. AbortSignal aborts LLM call
5. LLM API error → step error propagated
6. step.start and step.done events emitted
7. step.error event emitted on failure
8. Multiple tool calls in one step → all executed

- [ ] **Step 2: Implement executeStep()**

`packages/core/src/execution/step.ts`:
- `executeStep(ctx: StepContext, {llmClient, toolRegistry, middlewareChain, eventBus, conversationState})`
- Build messages from conversationState.messages → call LLM → parse response → **core appends LLM response to conversation** (FR-CORE-007) → execute tool calls → **core appends tool results to conversation** (FR-CORE-007)

Note: `LlmClient` and `LlmResponse` interfaces are already defined in the types package (Task 2, Step 4 — middleware.ts). For tests, use a mock LlmClient.

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): implement Step execution with LLM integration"
```

### Task 10: Turn execution

**Files:**
- Create: `packages/core/src/execution/turn.ts`
- Create: `packages/core/src/__tests__/execution/turn.test.ts`

- [ ] **Step 1: Write failing tests**

Tests (per EXEC-TURN-01):
1. Simple turn: input → 1 step → text response → TurnResult
2. Multi-step: LLM requests tools → step 2 → text → done
3. maxSteps reached → status "maxStepsReached"
4. Turn middleware wraps entire turn
5. Turn middleware blocks (no next()) → steps not executed
6. AbortSignal → status "aborted"
7. String input auto-wrapped to InboundEnvelope
8. InboundEnvelope input used directly
9. turn.start, turn.done events emitted
10. turn.error on exception
11. Inbound message auto-appended to conversation (FR-CORE-007)
12. LLM response + tool results also appended to conversation

- [ ] **Step 2: Implement executeTurn()**

`packages/core/src/execution/turn.ts`:
- `executeTurn(agentName, input, options, {agentRuntime})`
- Generate turnId, create AbortController
- Wrap string input → InboundEnvelope
- Append inbound message to conversation (FR-CORE-007). Core also appends LLM responses and tool results in executeStep — this is the core's sole write path to conversation state.
- Run Turn middleware chain
- Inside core handler: loop Steps until no tool calls or maxSteps
- Return TurnResult

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): implement Turn execution loop"
```

---

## Chunk 5: Core — Ingress Pipeline

### Task 11: Routing Engine

**Files:**
- Create: `packages/core/src/ingress/router.ts`
- Create: `packages/core/src/__tests__/ingress/router.test.ts`

- [ ] **Step 1: Write failing tests**

Tests (per INGRESS-ROUTE-01):
1. Rule matches by event name → returns agentName
2. First-match-wins: two matching rules → first applied
3. conversationId from rule.conversationId (highest priority)
4. conversationId from rule.conversationIdProperty + envelope.properties
5. conversationId with prefix
6. conversationId from envelope.conversationId (lowest priority)
7. No conversationId from any source → reject
8. No matching rule → reject
9. Target agent not registered → reject

- [ ] **Step 2: Implement RoutingEngine**

`packages/core/src/ingress/router.ts`:
- `routeEnvelope(envelope, rules, registeredAgents) → { agentName, conversationId } | { rejected, reason }`

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): implement Ingress routing engine"
```

### Task 12: Ingress Pipeline (4-stage)

**Files:**
- Create: `packages/core/src/ingress/pipeline.ts`
- Create: `packages/core/src/__tests__/ingress/pipeline.test.ts`

- [ ] **Step 1: Write failing tests**

Tests (per INGRESS-RECEIVE-01):
1. Full pipeline: verify → normalize → route → dispatch → accepted
2. verify fails → rejected, ingress.rejected event
3. verify undefined → skip verify stage
4. normalize returns single envelope → 1 dispatch
5. normalize returns array (fan-out) → N dispatches
6. normalize returns empty → empty result
7. dispatch is async (receive returns before Turn completes)
8. dispatch() skips verify/normalize
9. ingress.received / ingress.accepted / ingress.rejected events emitted
10. Connection-level middleware on verify/normalize
11. Agent-level middleware on route/dispatch
12. Scope enforcement: Connection Extension cannot register dispatch middleware → error (INGRESS-CONST-005)
13. Scope enforcement: Agent Extension cannot register verify middleware → error (INGRESS-CONST-005)
14. listConnections() returns all registered connections with correct info

- [ ] **Step 2: Implement IngressPipeline**

`packages/core/src/ingress/pipeline.ts`:
- Class `IngressPipeline` implementing `IngressApi`
- `receive({connectionName, payload})` → verify → normalize → route → dispatch
- `dispatch({connectionName, envelope})` → route → dispatch
- Each stage wrapped in middleware chain
- Dispatch fires Turn asynchronously (no await)

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): implement 4-stage Ingress pipeline"
```

---

## Chunk 6: Core — createHarness, Runtime, Model Factories

### Task 13: env() helper + errors

**Files:**
- Create: `packages/core/src/env.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/__tests__/env.test.ts`

- [ ] **Step 1: Write failing tests for env()**

Tests:
1. `env("KEY")` returns an EnvRef marker object
2. `resolveEnv(envRef)` with process.env.KEY set → returns value
3. `resolveEnv(envRef)` with missing env var → throws ConfigError
4. `resolveEnv(plainString)` → returns string as-is

- [ ] **Step 2: Implement env() + resolveEnv()**

- [ ] **Step 3: Run tests, verify PASS**

- [ ] **Step 4: Write error classes**

`HarnessError`, `ConfigError`, `ToolValidationError`, `IngressRejectedError`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(core): add env() helper and error classes"
```

### Task 14: Model factories

**Files:**
- Create: `packages/core/src/models/index.ts`
- Create: `packages/core/src/models/anthropic.ts`
- Create: `packages/core/src/models/openai.ts`
- Create: `packages/core/src/models/google.ts`
- Create: `packages/core/src/__tests__/models.test.ts`

- [ ] **Step 1: Write failing tests for model factories**

Tests:
1. `Anthropic({model, apiKey})` returns ModelConfig with provider "anthropic"
2. `OpenAI({model, apiKey})` returns ModelConfig with provider "openai"
3. `Google({model, apiKey})` returns ModelConfig with provider "google"
4. apiKey can be EnvRef (not resolved at factory time)
5. `createLlmClient(modelConfig)` creates correct adapter based on provider

- [ ] **Step 2: Implement model factories**

Each factory returns a `ModelConfig` with `provider`, `model`, `apiKey` (string|EnvRef), `baseUrl?`.
The actual LLM client creation happens in createHarness (deferred).

LlmClient adapters:
- `createAnthropicClient(config)` → wraps `@anthropic-ai/sdk`
- `createOpenAIClient(config)` → wraps `openai`
- `createGoogleClient(config)` → wraps `@google/generative-ai`

These are thin wrappers that normalize to the `LlmClient` interface.

Note: SDK dependencies are `peerDependencies` — user installs what they need.

- [ ] **Step 3: Run tests & commit**

```bash
git commit -m "feat(core): add Anthropic, OpenAI, Google model factories"
```

### Task 15: createHarness + HarnessRuntime

**Files:**
- Create: `packages/core/src/create-harness.ts`
- Create: `packages/core/src/harness-runtime.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/__tests__/create-harness.test.ts`

- [ ] **Step 1: Write failing tests**

Tests (per CONFIG-CREATE-01, CONFIG-CLOSE-01):
1. createHarness with minimal config → returns HarnessRuntime
2. env() refs resolved at createHarness time
3. Missing env var → clear error message
4. Extension registration order matches declaration order
5. Duplicate agent name → error
6. runtime.processTurn → calls executeTurn
7. runtime.close → aborts in-flight turns, rejects subsequent calls
8. runtime.ingress.receive → delegates to IngressPipeline
9. runtime.control.abortConversation → aborts correct conversation
10. defineHarness is identity function (no side effects)

- [ ] **Step 2: Implement createHarness**

Orchestrates: resolve envs → create LLM clients → create registries → register extensions → register tools → create IngressPipeline → create HarnessRuntime.

- [ ] **Step 3: Implement HarnessRuntime**

Implements: processTurn, ingress, control, close. Manages conversation state per conversationId (Map<string, ConversationState>).

- [ ] **Step 4: Write index.ts exports**

Export: `createHarness`, `defineHarness`, `env` from core package.

- [ ] **Step 5: Run full test suite**

Run: `cd packages/core && pnpm test`
Expected: All tests PASS.

- [ ] **Step 6: Typecheck**

Run: `cd packages/core && pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(core): implement createHarness and HarnessRuntime"
```

---

## Chunk 7: CLI Package

### Task 16: CLI implementation

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/config-loader.ts`
- Create: `packages/cli/src/env-loader.ts`
- Create: `packages/cli/src/commands/run.ts`
- Create: `packages/cli/src/commands/repl.ts`
- Create: `packages/cli/src/__tests__/cli.test.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@goondan/openharness-cli",
  "version": "2.0.0-alpha.0",
  "type": "module",
  "bin": { "oh": "./dist/index.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@goondan/openharness": "workspace:*",
    "dotenv": "^16.4.0"
  }
}
```

- [ ] **Step 2: Write failing tests**

Tests:
1. .env loading: process.env takes precedence over .env file
2. .env loading: .env values loaded when process.env is empty
3. Config loading: valid harness.config.ts → HarnessConfig
4. Agent auto-selection: 1 agent → selected automatically
5. Agent auto-selection: 2+ agents, no --agent → error
6. CLI exit codes: success = 0, runtime error = 1, usage error = 2

- [ ] **Step 3: Implement env-loader.ts**

- Load `.env` from workdir
- Merge with process.env (process.env takes precedence)

- [ ] **Step 4: Implement config-loader.ts**

- Dynamic import of `harness.config.ts` (uses tsx or ts-node for TS loading)
- Validate default export is HarnessConfig

- [ ] **Step 5: Implement run command**

- Parse args: `oh run "<text>" [options]`
- Load env → load config → createHarness → select agent → processTurn → print result → close

- [ ] **Step 6: Implement repl command**

- Parse args: `oh [repl] [options]`
- Load env → load config → createHarness → select agent → readline loop → processTurn per line → close

- [ ] **Step 7: Write CLI entry point (index.ts)**

- Parse subcommand (run/repl/default)
- Handle `--workdir`, `--config`, `--agent`, `--conversation`, `--max-steps`

- [ ] **Step 8: Run tests, build & commit**

```bash
git commit -m "feat(cli): implement oh CLI with run and repl commands"
```

---

## Chunk 8: Base Package — Extensions & Tools

### Task 17: Base package scaffolding + ContextMessage

**Files:**
- Create: `packages/base/package.json`
- Create: `packages/base/tsconfig.json`
- Create: `packages/base/src/index.ts`
- Create: `packages/base/src/extensions/context-message.ts`
- Create: `packages/base/src/__tests__/context-message.test.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@goondan/openharness-base",
  "version": "2.0.0-alpha.0",
  "type": "module",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "dependencies": {
    "@goondan/openharness-types": "workspace:*"
  }
}
```

Note: depends on types only (NOT core). Per spec CONFIG-CONST-004.

- [ ] **Step 2: Write failing tests for ContextMessage**

Tests:
1. With systemPrompt → system message prepended via emit(append)
2. Without systemPrompt → no system message
3. InboundEnvelope content converted to user message via emit(append)
4. Registers on "step" pipeline level

- [ ] **Step 3: Implement ContextMessage extension**

Registers Step middleware that:
- If systemPrompt config is provided, prepends system message via emit(append)
- Converts InboundEnvelope content to user message via emit(append)

- [ ] **Step 4: Run tests & commit**

```bash
git commit -m "feat(base): implement ContextMessage extension"
```

### Task 18: MessageWindow + CompactionSummarize

**Files:**
- Create: `packages/base/src/extensions/message-window.ts`
- Create: `packages/base/src/extensions/compaction-summarize.ts`
- Create: `packages/base/src/__tests__/message-window.test.ts`

- [ ] **Step 1: Write failing tests for MessageWindow**

Tests:
1. Messages within maxMessages → no truncation
2. Messages exceed maxMessages → truncate(keepLast: maxMessages)

- [ ] **Step 2: Implement MessageWindow**

Step middleware: if messages exceed maxMessages, emit truncate(keepLast: maxMessages).

- [ ] **Step 3: Write failing tests for CompactionSummarize**

Tests:
1. Messages below threshold → no compaction
2. Messages exceed threshold → older messages summarized and replaced

- [ ] **Step 4: Implement CompactionSummarize**

Step middleware: if messages exceed threshold, use LLM (via separate call) to summarize older messages, then emit replace events.

Note: CompactionSummarize needs access to an LLM client for summarization. This can be accessed via `api.runtime.agent.model` info + a helper.

- [ ] **Step 5: Run all tests & commit**

```bash
git commit -m "feat(base): implement MessageWindow and CompactionSummarize"
```

### Task 19: Logging + ToolSearch + RequiredToolsGuard

**Files:**
- Create: `packages/base/src/extensions/logging.ts`
- Create: `packages/base/src/extensions/tool-search.ts`
- Create: `packages/base/src/extensions/required-tools-guard.ts`

- [ ] **Step 1: Write failing tests for Logging, ToolSearch, RequiredToolsGuard**

Tests:
- Logging: subscribes to events, logs on turn.start/done/error
- ToolSearch: registers meta-tool, searches tool descriptions by keyword
- RequiredToolsGuard: blocks Turn if required tools missing, passes if present

- [ ] **Step 2: Implement Logging**

Uses `api.on` to subscribe to all core events and log them.

- [ ] **Step 3: Implement ToolSearch**

Dynamic tool discovery. Registers a meta-tool that searches tool descriptions.

- [ ] **Step 4: Implement RequiredToolsGuard**

Turn middleware that checks required tools exist before next().

- [ ] **Step 5: Run tests & commit**

```bash
git commit -m "feat(base): implement Logging, ToolSearch, RequiredToolsGuard"
```

### Task 20: Base Tools (Bash, FileSystem, HttpFetch, JsonQuery, TextTransform, Wait)

**Files:**
- Create: `packages/base/src/tools/bash.ts`
- Create: `packages/base/src/tools/file-system.ts`
- Create: `packages/base/src/tools/http-fetch.ts`
- Create: `packages/base/src/tools/json-query.ts`
- Create: `packages/base/src/tools/text-transform.ts`
- Create: `packages/base/src/tools/wait.ts`
- Create: `packages/base/src/__tests__/tools.test.ts`

- [ ] **Step 1: Write failing tests for all 6 tools**

Each tool needs: schema validation test, handler success test, handler error test.

- [ ] **Step 2: Implement Bash + FileSystem**

- Bash: `child_process.exec` wrapper with timeout/maxBuffer
- FileSystem: read/write/list/mkdir with allowWrite config

- [ ] **Step 3: Implement HttpFetch + JsonQuery**

- HttpFetch: native `fetch()` wrapper with method/headers/body
- JsonQuery: JSONPath-like query on JSON data

- [ ] **Step 4: Implement TextTransform + Wait**

- TextTransform: split/join/replace/transform operations
- Wait: `setTimeout` wrapper respecting AbortSignal

- [ ] **Step 5: Write index.ts re-exports**

- [ ] **Step 6: Run all tests & commit**

```bash
git commit -m "feat(base): implement 6 base tools"
```

---

## Chunk 9: Integration Tests + AC Verification

### Task 21: Integration tests for all Acceptance Criteria

**Files:**
- Create: `packages/core/src/__tests__/integration/ac-tests.test.ts`

- [ ] **Step 1: AC-1 — Minimal execution with ContextMessage**

- [ ] **Step 2: AC-2 — No Extension = empty context to LLM**

- [ ] **Step 3: AC-3 — Extension swap (MessageWindow ↔ mock)**

- [ ] **Step 4: AC-4 — Event sourcing: restore(events) → identical messages**

- [ ] **Step 5: AC-5 & AC-6 — Persistence Extension presence/absence**

- [ ] **Step 6: AC-7 — Observability isolation (throwing listener)**

- [ ] **Step 7: AC-8 — Middleware blocking ToolCall**

- [ ] **Step 8: AC-9, AC-10, AC-11 — Ingress pipeline, routing, conversationId**

- [ ] **Step 9: AC-12 — Runtime introspection**

- [ ] **Step 10: AC-13 — Abort control**

- [ ] **Step 11: AC-14 — Third-party Extension (types-only dependency)**

- [ ] **Step 12: Run full suite**

Run: `pnpm test` (root)
Expected: All tests pass.

- [ ] **Step 13: Typecheck all packages**

Run: `pnpm typecheck` (root)
Expected: No errors.

- [ ] **Step 14: Commit**

```bash
git commit -m "test: add integration tests for all 14 acceptance criteria"
```

---

## Chunk 10: Final Polish + Push

### Task 22: Documentation + build verification

**Files:**
- Modify: root `package.json` (verify scripts)

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: All 4 packages build successfully.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: Clean.

- [ ] **Step 4: Commit & push to v2**

```bash
git add -A
git commit -m "chore: finalize openharness v2 MVP"
git push origin v2
```

# execution-loop — 코어 실행 루프

## 1. 한 줄 요약

코어가 인바운드 메시지 하나를 받아 Turn → Step → ToolCall 사이클을 돌리고, 미들웨어 훅으로 Extension이 각 단계에 개입하며, 관측 이벤트로 실행 과정을 외부에 노출한다.

---

## 2. 상위 스펙 연결

- **Related Goals:** G-1 (순수한 코어), G-2 (Composable Extension), G-5 (명시적 선택)
- **Related Requirements:** FR-CORE-001~009, FR-OBS-001~004
- **Related AC:** AC-1, AC-2, AC-7, AC-8, AC-13, AC-15, AC-16

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: EXEC-TURN-01 — Turn 실행

- **Actor:** 코어 런타임
- **Trigger:** `processTurn(agentName, input: string | InboundEnvelope, options?)` 호출 또는 Ingress dispatch
- **Preconditions:**
  - 해당 agentName에 대응하는 AgentConfig가 등록되어 있다.
  - 런타임이 close되지 않은 상태다.
- **Main Flow:**
  1. Turn ID를 생성한다.
  2. `input`이 `string`이면 코어가 `InboundEnvelope`로 래핑한다. Ingress 경유 시 이미 `InboundEnvelope`이므로 그대로 사용한다.
  3. 인바운드 메시지를 대화 상태에 `append` 이벤트로 추가한다 (FR-CORE-007). 코어가 LLM 응답과 도구 결과도 동일하게 append한다. 이것이 코어가 대화 상태에 직접 쓰는 유일한 동작이다.
  4. AbortController를 생성하고, AbortSignal을 Turn 컨텍스트에 바인딩한다.
  5. Turn 미들웨어 체인을 실행한다.
  6. 체인의 최내부(코어 로직)에서 Step 루프를 시작한다.
  7. Step 루프가 종료되면 (LLM이 도구를 요청하지 않거나 maxSteps 도달), Turn 결과를 반환한다.
  8. `turn.done` 이벤트를 발행한다.
- **Alternative Flow:**
  - AbortSignal이 활성화되면 현재 진행 중인 Step/ToolCall/LLM 호출을 중단하고, Turn을 abort 상태로 종료한다. `turn.error` 이벤트 발행.
  - 미들웨어에서 예외가 발생하면 Turn을 error 상태로 종료한다. `turn.error` 이벤트 발행.
  - Turn 미들웨어가 `next()`를 호출하지 않으면 Step 루프가 실행되지 않는다. 미들웨어의 반환값이 Turn 결과가 된다.
- **Outputs:** TurnResult (텍스트 응답 + 메타데이터)
- **Side Effects:** 대화 상태(events)에 이 Turn에서 발생한 이벤트가 추가됨.
- **Failure Modes:**
  - agentName이 등록되지 않은 경우: 즉시 에러 반환 (Turn 시작 전).
  - LLM API 에러: Step 내에서 에러 처리 후 Turn error로 전파.
  - AbortSignal abort: 진행 중인 작업 중단, Turn abort 상태로 종료.

#### Flow ID: EXEC-STEP-01 — Step 실행

- **Actor:** 코어 런타임 (Turn의 내부 루프)
- **Trigger:** Turn의 Step 루프에서 호출
- **Preconditions:**
  - Turn 컨텍스트가 활성 상태다.
  - 현재 Step 번호가 maxSteps 미만이다.
- **Main Flow:**
  1. Step 미들웨어 체인을 실행한다.
  2. 체인의 최내부에서 현재 대화 상태의 messages를 LLM에 전달하여 호출한다.
     - LlmClient에 `streamChat`이 구현되어 있으면 `streamChat()`을 사용한다. 스트리밍 중 콜백을 통해 EventBus에 `step.textDelta`/`step.toolCallDelta` 이벤트를 발행한다.
     - `streamChat`이 없으면 `chat()`으로 폴백한다. 이 경우 `step.textDelta`/`step.toolCallDelta` 이벤트는 발행되지 않는다.
     - 두 경로 모두 동일한 `LlmResponse`를 반환한다.
  3. LLM 응답을 파싱한다.
  4. LLM이 도구 호출을 요청한 경우: 각 ToolCall을 실행한다 (EXEC-TOOLCALL-01).
  5. 도구 결과를 대화 상태에 추가한다.
  6. LLM이 도구를 요청하지 않은 경우: 텍스트 응답을 Turn 결과로 반환하고 Step 루프를 종료한다.
  7. `step.done` 이벤트를 발행한다.
- **Alternative Flow:**
  - Step 미들웨어에서 messages를 조작할 수 있다 (컨텍스트 주입, 압축, 윈도우 등). `next()` 호출 전에 `ctx.conversation`의 이벤트를 발생시켜 메시지 목록을 변경한다.
  - AbortSignal 활성화 시 LLM 호출을 중단한다.
  - maxSteps 도달 시 Step 루프를 강제 종료하고 현재까지의 결과로 Turn을 완료한다.
- **Outputs:** StepResult (LLM 응답 + 도구 호출 목록)
- **Failure Modes:**
  - LLM API 호출 실패: Step error로 Turn에 전파.
  - LLM 응답 파싱 실패: Step error.

#### Flow ID: EXEC-TOOLCALL-01 — ToolCall 실행

- **Actor:** 코어 런타임 (Step의 내부)
- **Trigger:** LLM이 도구 호출을 요청
- **Preconditions:**
  - 요청된 도구 이름이 Tool Registry에 등록되어 있다.
- **Main Flow:**
  1. LLM이 제공한 인자를 도구의 JSON Schema로 검증한다.
  2. ToolCall 미들웨어 체인을 실행한다.
  3. 체인의 최내부에서 도구 핸들러를 호출한다. ToolContext(conversationId, agentName, abortSignal)를 전달한다.
  4. 도구 결과를 반환한다.
  5. `tool.done` 이벤트를 발행한다.
- **Alternative Flow:**
  - JSON Schema 검증 실패: LLM에 검증 에러를 반환한다. 도구 핸들러는 호출하지 않는다.
  - 도구가 Registry에 없는 경우: LLM에 "도구를 찾을 수 없음" 에러를 반환한다.
  - ToolCall 미들웨어에서 `next()`를 호출하지 않으면 도구 실행이 차단된다. 미들웨어의 반환값이 도구 결과가 된다.
  - 도구 핸들러에서 예외 발생: `tool.error` 이벤트 발행. LLM에 에러를 반환한다 (Turn은 계속 진행).
  - AbortSignal 활성화 시 도구 핸들러에서 확인 가능. 핸들러가 중단을 존중할 책임이 있다.
- **Outputs:** ToolResult
- **Failure Modes:**
  - 도구 핸들러 예외: LLM에 에러 반환. Turn은 계속 (LLM이 다음 행동 결정).
  - 도구 핸들러 타임아웃: AbortSignal을 통한 중단 (별도 타임아웃 정책은 Extension 책임).

#### Flow ID: EXEC-ABORT-01 — Turn 중단

- **Actor:** 외부 코드 (Control API 또는 내부 로직)
- **Trigger:** `control.abortConversation()` 호출 또는 내부 abort 조건
- **Preconditions:**
  - 해당 conversationId의 Turn이 진행 중이다.
- **Main Flow:**
  1. AbortController의 `abort(reason)`을 호출한다.
  2. AbortSignal이 전파되어 현재 진행 중인 LLM 호출, ToolCall, Step, Turn이 순차적으로 중단된다.
  3. Turn을 abort 상태로 종료한다.
  4. `turn.error` 이벤트를 발행한다 (reason에 abort 정보 포함).
- **Outputs:** AbortResult (conversationId, abortedTurns, reason)
- **Failure Modes:**
  - 해당 conversationId의 Turn이 없는 경우: abortedTurns: 0을 반환한다.

---

## 4. Constraint Specification

### Constraint ID: EXEC-CONST-001 — 미들웨어 실행 순서

- **Category:** 동작 보장
- **Description:** 같은 레벨의 미들웨어는 priority 오름차순으로 실행된다. priority가 같으면 등록(선언) 순서를 따른다.
- **Scope:** 전체 (Turn/Step/ToolCall)
- **Measurement:** 순서가 보장되는 유닛 테스트
- **Verification:** priority가 다른 3개 이상의 미들웨어를 등록하고 실행 순서를 검증한다.

### Constraint ID: EXEC-CONST-002 — AbortSignal 관통

- **Category:** 동작 보장
- **Description:** 하나의 AbortSignal이 Turn → Step → ToolCall → LLM 호출까지 전체 체인을 관통한다. 모든 비동기 작업은 이 signal을 확인해야 한다.
- **Scope:** 전체
- **Measurement:** abort 후 모든 하위 작업이 중단되는 테스트
- **Verification:** Turn 실행 중 abort를 호출하고, 하위 작업이 모두 중단됨을 확인한다.

### Constraint ID: EXEC-CONST-003 — Observability 격리

- **Category:** 안정성
- **Description:** `api.on`으로 등록된 이벤트 리스너의 예외/지연은 실행 루프에 영향을 주지 않는다. 코어는 리스너를 fire-and-forget으로 호출한다.
- **Scope:** 전체 이벤트 발행
- **Measurement:** 예외를 던지는 리스너가 있어도 Turn이 정상 완료되는 테스트
- **Verification:** 고의 예외 + 무한루프 리스너를 등록하고 Turn 결과가 정상인지 확인한다.

### Constraint ID: EXEC-CONST-004 — maxSteps 보호

- **Category:** 안정성
- **Description:** Step 수가 maxSteps에 도달하면 Turn을 강제 종료한다. maxSteps 기본값은 구성에서 정의한다.
- **Scope:** EXEC-TURN-01
- **Measurement:** maxSteps 초과 시 Turn이 종료되는 테스트
- **Verification:** maxSteps: 2로 설정하고, LLM이 계속 도구를 요청하는 시나리오에서 Step이 2회 후 종료됨을 확인한다.

### Constraint ID: EXEC-CONST-005 — 코어 순수성

- **Category:** 아키텍처
- **Description:** 코어는 시스템 프롬프트, 기본 도구, fallback 메시지를 주입하지 않는다. Extension이 없으면 LLM에 빈 메시지가 전달된다.
- **Scope:** 전체
- **Measurement:** Extension 없이 실행했을 때 LLM 입력이 빈 컨텍스트인지 확인하는 테스트
- **Verification:** Extension/Tool을 선언하지 않고 Turn을 실행, LLM에 전달되는 messages가 사용자 입력만 포함됨을 확인.

### Constraint ID: EXEC-CONST-006 — TurnContext.llm 바인딩

- **Category:** 동작 보장
- **Description:** TurnContext.llm은 현재 에이전트의 모델 구성에 바인딩된 LlmClient다. StepContext와 ToolCallContext는 TurnContext를 extends하므로 llm이 자동 전파된다. Extension이 ctx.llm.chat() 또는 ctx.llm.streamChat()을 호출해도 대화 상태(conversation)에 자동 반영되지 않는다.
- **Scope:** EXEC-TURN-01, EXEC-STEP-01, EXEC-TOOLCALL-01
- **Measurement:** 미들웨어 내에서 ctx.llm.chat() 호출이 성공하고, 대화 상태에 자동 추가되지 않는 테스트
- **Verification:** Turn 미들웨어에서 ctx.llm.chat()을 호출 후 conversation.messages에 해당 호출이 포함되지 않음을 확인.

### Constraint ID: EXEC-CONST-007 — LlmChatOptions 격리

- **Category:** 동작 보장
- **Description:** LlmChatOptions로 전달된 오버라이드(model, temperature, maxTokens)는 해당 chat() 호출에만 적용된다. 에이전트의 기본 모델 구성을 영구적으로 변경하지 않는다.
- **Scope:** LlmClient.chat()
- **Measurement:** options를 전달한 호출 후, 다음 호출이 기본 구성을 사용하는 테스트
- **Verification:** chat(messages, [], [], { model: "override" }) 호출 후, 옵션 없이 chat(messages)을 호출하여 기본 모델이 사용됨을 확인.

### Constraint ID: EXEC-CONST-008 — 스트리밍 폴백 보장

- **Category:** 동작 보장
- **Description:** `streamChat`이 LlmClient에 없으면 코어는 `chat()`으로 폴백한다. 두 경로의 최종 `LlmResponse`는 동일한 형태다. 스트리밍은 관찰 관심사이므로 `TurnResult`/`StepResult`에는 변경이 없다.
- **Scope:** EXEC-STEP-01
- **Measurement:** `streamChat` 미구현 LlmClient로 Turn을 실행하여 정상 완료되는 테스트
- **Verification:** `chat()`만 구현한 커스텀 LlmClient로 Turn을 실행, `step.textDelta` 이벤트 미발행 + Turn 정상 완료를 확인.

### Constraint ID: EXEC-CONST-009 — 스트리밍 이벤트 범위

- **Category:** 동작 보장
- **Description:** `step.textDelta`와 `step.toolCallDelta` 이벤트는 `step.start`와 `step.done` 사이에서만 발행된다. 이벤트 리스너 예외는 EXEC-CONST-003과 동일하게 실행 루프에 영향을 주지 않는다.
- **Scope:** EXEC-STEP-01
- **Measurement:** 스트리밍 이벤트가 step 범위 내에서만 발행되고, 리스너 예외가 스트림을 중단시키지 않는 테스트
- **Verification:** step.textDelta 리스너에서 예외를 던져도 스트림이 계속되고 Turn이 정상 완료됨을 확인.

---

## 5. Interface Specification

### 5.1 미들웨어 등록 계약

```ts
type MiddlewareLevel = "turn" | "step" | "toolCall";

interface MiddlewareOptions {
  priority?: number; // 낮을수록 먼저 실행. 기본값: 100.
}

// Turn 미들웨어
type TurnMiddleware = (ctx: TurnContext, next: () => Promise<TurnResult>) => Promise<TurnResult>;

// Step 미들웨어
type StepMiddleware = (ctx: StepContext, next: () => Promise<StepResult>) => Promise<StepResult>;

// ToolCall 미들웨어
type ToolCallMiddleware = (ctx: ToolCallContext, next: () => Promise<ToolResult>) => Promise<ToolResult>;

// 등록
api.pipeline.register("turn", handler: TurnMiddleware, options?: MiddlewareOptions): void;
api.pipeline.register("step", handler: StepMiddleware, options?: MiddlewareOptions): void;
api.pipeline.register("toolCall", handler: ToolCallMiddleware, options?: MiddlewareOptions): void;
```

### 5.2 컨텍스트 계약

```ts
interface TurnContext {
  turnId: string;
  agentName: string;
  conversationId: string;
  conversation: ConversationState;  // 현재 Turn에 바인딩된 프록시. emit()은 Turn 실행 중(미들웨어 내부)에서만 호출 가능.
  abortSignal: AbortSignal;
  input: InboundEnvelope;           // processTurn(string)이면 코어가 래핑한 InboundEnvelope.
  llm: LlmClient;                   // 현재 에이전트의 모델 구성에 바인딩된 LLM 클라이언트. Extension이 런타임에 LLM 호출 시 사용. (FR-CORE-008)
}

interface StepContext extends TurnContext {
  stepNumber: number;
}

interface ToolCallContext extends StepContext {
  toolName: string;
  toolArgs: JsonObject;
}
```

### 5.3 LlmClient 계약

```ts
interface LlmStreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolCallDelta?: (toolCallId: string, toolName: string, argsDelta: string) => void;
}

interface LlmClient {
  /**
   * LLM에 채팅 요청을 보낸다.
   * @param messages - 대화 메시지 배열
   * @param tools - 사용 가능한 도구 정의 배열 (선택)
   * @param systemMessages - 시스템 메시지 배열 (선택)
   * @param options - 호출별 오버라이드 옵션 (선택, FR-CORE-009)
   */
  chat(
    messages: Message[],
    tools?: ToolDefinition[],
    systemMessages?: SystemMessage[],
    options?: LlmChatOptions,
  ): Promise<LlmResponse>;

  /**
   * LLM에 스트리밍 채팅 요청을 보낸다. (선택적 — FR-CORE-010)
   * chat()과 동일한 Promise<LlmResponse>를 반환하되,
   * 스트리밍 중 callbacks를 호출하여 텍스트/도구호출 델타를 실시간으로 전달한다.
   * 미구현 시 코어가 chat()으로 폴백한다.
   */
  streamChat?(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    callbacks: LlmStreamCallbacks,
    options?: LlmChatOptions,
  ): Promise<LlmResponse>;
}

interface LlmChatOptions {
  model?: string;        // 호출별 모델 오버라이드. 미지정 시 에이전트 기본 모델 사용.
  temperature?: number;  // 호출별 temperature 오버라이드.
  maxTokens?: number;    // 호출별 최대 토큰 수 오버라이드.
}
```

- TurnContext.llm은 코어가 createHarness 시 에이전트의 모델 구성(provider + model)으로 바인딩한 LlmClient 인스턴스다.
- StepContext, ToolCallContext는 TurnContext를 extends하므로 llm이 자동 전파된다.
- LlmChatOptions의 각 필드는 선택적이며, 미지정 필드는 에이전트의 기본 구성을 사용한다.
- Extension이 `ctx.llm.chat()`을 호출해도 대화 상태(conversation)에는 자동 반영되지 않는다. Extension이 필요에 따라 `conversation.emit()`으로 직접 기록해야 한다.
- `streamChat`은 선택적(optional) 메서드다. ai-sdk 어댑터는 항상 구현하지만, 커스텀 LlmClient는 `chat()`만 구현해도 된다. 스트리밍은 관찰(observation) 관심사이므로 TurnResult/StepResult에는 영향을 주지 않는다.

### 5.4 이벤트 구독 계약

```ts
api.on(event: string, listener: (payload: EventPayload) => void): void;
```

코어가 발행하는 이벤트 목록:

| 이벤트 | payload 핵심 필드 |
|--------|------------------|
| `turn.start` | turnId, agentName, conversationId |
| `turn.done` | turnId, result |
| `turn.error` | turnId, error |
| `step.start` | turnId, stepNumber |
| `step.textDelta` | turnId, agentName, conversationId, stepNumber, delta |
| `step.toolCallDelta` | turnId, agentName, conversationId, stepNumber, toolCallId, toolName, argsDelta |
| `step.done` | turnId, stepNumber, result |
| `step.error` | turnId, stepNumber, error |
| `tool.start` | turnId, stepNumber, toolName, toolArgs |
| `tool.done` | turnId, stepNumber, toolName, toolResult |
| `tool.error` | turnId, stepNumber, toolName, error |

### 5.5 Turn 결과 계약

```ts
interface TurnResult {
  turnId: string;
  agentName: string;
  conversationId: string;
  status: "completed" | "aborted" | "error" | "maxStepsReached";
  text?: string;        // LLM의 최종 텍스트 응답
  steps: StepSummary[];  // 각 Step의 요약
  error?: Error;         // status가 error일 때
}

interface StepSummary {
  stepNumber: number;
  toolCalls: ToolCallSummary[];
}

interface ToolCallSummary {
  toolName: string;
  args: JsonObject;
  result?: ToolResult;
  error?: Error;
}
```

---

## 6. Realization Specification

- **Module Boundaries:** 실행 루프는 코어 패키지(`@goondan/openharness`)의 단일 모듈에 위치한다. Turn/Step/ToolCall 각각이 미들웨어 체인을 실행하는 함수로 분리된다.
- **Data Ownership:** TurnContext는 코어가 생성하고 소유한다. 미들웨어는 컨텍스트를 읽고 수정할 수 있지만, 새 컨텍스트를 생성하지 않는다.
- **Concurrency Strategy:** 한 Turn 내에서 LLM이 여러 ToolCall을 요청하면, ToolCall 간 실행 순서는 구현에 따라 직렬 또는 병렬일 수 있다. AbortSignal은 모든 ToolCall에 공유된다.
- **Failure Handling:**
  - 미들웨어 예외: 해당 레벨의 에러로 상위 레벨에 전파.
  - 이벤트 리스너 예외: 삼키고 로깅 (fire-and-forget).
  - LLM API 예외: Step error로 Turn에 전파. Turn 미들웨어가 재시도 등을 구현할 수 있다.
  - Tool 핸들러 예외: LLM에 에러 반환. Turn은 계속.
- **Observability Plan:** 모든 이벤트 발행은 동기적으로 리스너를 호출하되, 리스너의 완료를 기다리지 않는다 (fire-and-forget). 리스너 예외는 catch하여 내부 경고 로그로 남긴다.

---

## 7. Dependency Map

- **Depends On:** `@goondan/openharness-types` (타입 정의)
- **Blocks:** extension-system.md (ExtensionApi의 pipeline 표면), conversation-state.md (Turn 실행 중 conversation 접근)
- **Parallelizable With:** ingress-pipeline.md (Ingress는 실행 루프의 진입점이지만 루프 자체와 독립적으로 구현 가능)

---

## 8. Acceptance Criteria

- **Given** model만 선언하고 Extension/Tool을 선언하지 않은 상태에서, **When** `processTurn("assistant", "hello")`를 실행하면, **Then** LLM에 시스템 프롬프트 없이 사용자 입력만 전달되고 텍스트 응답을 반환한다. (AC-2)
- **Given** Turn 미들웨어, Step 미들웨어, ToolCall 미들웨어가 각각 등록된 상태에서, **When** Turn을 실행하면, **Then** Turn → Step → ToolCall 순서로 미들웨어가 실행된다.
- **Given** ToolCall 미들웨어에서 특정 도구의 `next()`를 호출하지 않는 상태에서, **When** LLM이 해당 도구를 호출하면, **Then** 도구 핸들러가 실행되지 않고 미들웨어의 반환값이 도구 결과가 된다. (AC-8)
- **Given** `api.on("turn.done", () => { throw new Error() })`가 등록된 상태에서, **When** Turn을 실행하면, **Then** Turn은 정상 완료된다. (AC-7)
- **Given** maxSteps: 2로 설정된 상태에서, **When** LLM이 3회 연속 도구를 요청하면, **Then** 2회 Step 후 Turn이 `maxStepsReached` 상태로 종료된다.
- **Given** Turn 실행 중에, **When** `control.abortConversation()`을 호출하면, **Then** AbortSignal이 전파되어 현재 작업이 중단되고 Turn이 `aborted` 상태로 종료된다. (AC-13)
- **Given** priority 50, 100, 200의 Step 미들웨어가 등록된 상태에서, **When** Step을 실행하면, **Then** 50 → 100 → 200 순서로 실행된다.
- **Given** Turn 미들웨어를 등록한 Extension이 있는 상태에서, **When** 미들웨어 내에서 `ctx.llm.chat(messages)`를 호출하면, **Then** 현재 에이전트의 모델 구성으로 LLM 호출이 실행되고 응답이 반환된다. (AC-15)
- **Given** Extension이 `ctx.llm.chat(messages, [], [], { model: "other-model", temperature: 0 })`를 호출하는 상태에서, **When** 해당 호출이 실행되면, **Then** 지정된 옵션만 오버라이드되고 에이전트의 기본 구성은 변경되지 않는다. (AC-16)
- **Given** `streamChat()`을 구현한 LlmClient가 바인딩된 에이전트에서 `api.on("step.textDelta")`가 등록된 상태에서, **When** Turn을 실행하면, **Then** `step.textDelta` 이벤트가 `step.start`와 `step.done` 사이에 여러 번 발행되고, 각 delta를 이어 붙이면 최종 텍스트 응답과 동일하다. (AC-17)
- **Given** `streamChat()`이 없는 커스텀 LlmClient가 바인딩된 에이전트에서, **When** Step이 LLM을 호출하면, **Then** `chat()`으로 폴백하여 Turn이 정상 완료되고, `step.textDelta` 이벤트는 발행되지 않는다. (AC-18)
- **Given** `streamChat()`을 구현한 LlmClient가 바인딩된 에이전트에서 스트리밍 중인 상태에서, **When** `control.abortConversation()`을 호출하면, **Then** AbortSignal이 전파되어 스트림이 중단되고 Turn이 `aborted` 상태로 종료된다. (AC-19)

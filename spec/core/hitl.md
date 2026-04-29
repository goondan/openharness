# hitl - Human-in-the-loop durable tool approval

## 1. 한 줄 요약

OpenHarness는 HITL이 필요한 ToolCall을 durable pending 상태로 전환하고, 프로세스 재시작/크래시/장기간 대기 이후에도 human result를 제출하면 동일한 도구 실행을 재개할 수 있게 한다.

## 2. 상위 스펙 연결

- Related Goals: `G-1`, `G-4`, `G-5`, `G-6`, `G-7`
- Related Requirements: `FR-HITL-001` ~ `FR-HITL-015`, `NFR-HITL-001` ~ `NFR-HITL-007`
- Related AC: `AC-07` ~ `AC-12`

## 3. Desired State

OpenHarness는 사람이 승인하거나 값을 보완해야 하는 ToolCall을 durable HITL request로 보류한다. 보류된 request는 runtime process 수명과 독립적으로 저장되고, human result가 제출되면 같은 ToolCall snapshot을 기준으로 승인/거절/args 변경을 적용해 안전하게 재개된다.

### 3.1 Core Properties

- HITL이 필요한 ToolCall은 tool handler 실행 전에 pending request로 durable 저장된다.
- pending request는 `requestId`, ToolCall snapshot, response schema, conversation event snapshot, 상태 전이 정보를 포함한다.
- runtime은 pending request 조회, human result 제출, resume/cancel control API를 제공한다.
- human result는 approval, rejection, free text, JSON form payload를 표현할 수 있다.
- resume은 lease와 idempotency key를 사용해 같은 request의 중복 실행을 방지한다.
- runtime startup은 pending/resolved/resuming request를 복구하고 필요한 resume 작업을 재예약한다.

### 3.2 Success Criteria

- HITL이 필요한 ToolCall은 tool handler 실행 전에 반드시 pending 상태로 durable 저장된다.
- runtime이 종료되거나 크래시된 뒤 새 runtime이 생성되어도 pending HITL request를 조회하고 resolve/reject 할 수 있다.
- 승인 결과가 `Y/N`, 자유 텍스트, JSON form 중 어떤 형태여도 정책에 따라 도구 실행 여부와 최종 args를 결정할 수 있다.
- 재개된 ToolCall은 중복 실행되지 않으며, 모든 lifecycle은 이벤트로 관찰 가능해야 한다.

## 4. Spec Stability Classification

| 영역 | 분류 | 이유 |
| --- | --- | --- |
| HITL 상태 머신 | Stable | 복구와 중복 실행 방지의 핵심 계약 |
| `HitlStore` 인터페이스 | Stable | 외부 persistence adapter가 의존하는 계약 |
| runtime control API | Stable | UI/transport/CLI가 사용하는 공개 표면 |
| form schema 표현 | Flexible | 사용성에 따라 UI metadata가 확장될 수 있음 |
| 내장 store 구현체 | Planned | 코어는 계약만 소유하고 저장소 구현은 adapter로 분리 |
| CLI UX | Candidate | core 계약 검증 뒤 별도 표면으로 확장 |

## 5. Glossary

| 용어 | 정의 |
| --- | --- |
| HITL | Human In The Loop. 도구 실행 전 사람의 판단 또는 입력을 요구하는 흐름 |
| HITL Request | 특정 ToolCall 실행을 보류하고 사람에게 결정을 요청하는 durable record |
| HITL Result | 사람이 제출한 승인/거절/텍스트/form 데이터 |
| Pending ToolCall | 아직 실제 tool handler를 호출하지 않았고 HITL 결과를 기다리는 ToolCall |
| Resume | durable HITL result를 사용해 보류된 ToolCall을 계속 실행하는 행위 |
| Lease | 여러 프로세스가 같은 pending request를 동시에 처리하지 못하게 잡는 시간 제한 lock |
| Idempotency Key | 같은 ToolCall/Result 재시도에서 중복 side effect를 막기 위한 안정적 키 |

## 6. Requirements

### 6.1 Functional Requirements

| ID | Level | 요구사항 |
| --- | --- | --- |
| FR-HITL-001 | Committed | ToolDefinition은 선택적으로 HITL 정책을 선언할 수 있어야 한다. |
| FR-HITL-002 | Committed | HITL 정책이 적용된 ToolCall은 tool handler 실행 전에 `HitlRequest`를 생성하고 `HitlStore`에 저장해야 한다. |
| FR-HITL-003 | Committed | HITL request 저장이 성공하기 전에는 해당 tool handler를 호출하면 안 된다. |
| FR-HITL-004 | Committed | runtime은 pending HITL request를 조회하는 공개 API를 제공해야 한다. |
| FR-HITL-005 | Committed | runtime은 human result를 제출하는 공개 API를 제공해야 한다. |
| FR-HITL-006 | Committed | human result가 approve이면 저장된 ToolCall을 재개하고, reject이면 tool handler를 호출하지 않고 거절 결과를 conversation에 기록해야 한다. |
| FR-HITL-007 | Committed | human result는 `boolean`, `text`, `json` form payload를 지원해야 한다. |
| FR-HITL-008 | Committed | HITL resume은 프로세스 재시작 이후에도 가능해야 한다. |
| FR-HITL-009 | Committed | HITL resume은 같은 request에 대해 at-most-once tool handler execution을 보장해야 한다. |
| FR-HITL-010 | Committed | HITL request/result/resume lifecycle은 runtime event로 발행되어야 한다. |
| FR-HITL-011 | Committed | HITL로 보류된 Turn은 `waitingForHuman` 상태로 관찰 가능해야 한다. |
| FR-HITL-012 | Committed | conversation event stream 복원 후에도 HITL request와 연결된 assistant tool-call 및 tool-result 메시지 정합성이 유지되어야 한다. |
| FR-HITL-013 | Planned | TTL 만료, 자동 reject, reminder 같은 운영 정책을 extension으로 붙일 수 있어야 한다. |
| FR-HITL-014 | Candidate | CLI는 pending request 목록 조회와 approve/reject/submit 명령을 제공할 수 있다. |
| FR-HITL-015 | Committed | `HitlRequest`는 기본적으로 resume에 필요한 conversation event snapshot을 포함해야 한다. |

### 6.2 Non-functional Requirements

| ID | Level | 요구사항 | 검증 방향 |
| --- | --- | --- | --- |
| NFR-HITL-001 | Committed | Durability: `hitl.requested` 이벤트 발행 전 `HitlStore.create()`가 성공해야 한다. | crash recovery test |
| NFR-HITL-002 | Committed | Idempotency: 동일 `requestId`에 result를 반복 제출해도 tool handler는 최대 1회만 실행된다. | concurrency test |
| NFR-HITL-003 | Committed | Recoverability: runtime 재생성 후 `listPendingHitl()`로 기존 pending request가 보여야 한다. | integration test |
| NFR-HITL-004 | Committed | Observability: 모든 상태 전이는 event payload에 `requestId`, `turnId`, `toolCallId`, `conversationId`를 포함한다. | unit test |
| NFR-HITL-005 | Committed | Security: HITL result 제출은 request identity와 agent/conversation scope 검증을 통과해야 한다. | negative test |
| NFR-HITL-006 | Committed | Compatibility: HITL 미사용 도구의 실행 루프와 결과 구조는 기존 동작을 유지한다. | regression test |
| NFR-HITL-007 | Planned | Retention: 완료/거절/만료된 request는 store별 retention 정책으로 정리 가능해야 한다. | adapter test |

## 7. Behavior Specification

### 7.1 Flow: HITL request 생성

**ID:** `HITL-REQUEST-01`

- Actor: Core execution loop
- Trigger: `executeToolCall()`이 HITL 정책이 적용된 ToolCall을 만나거나 `toolCall` middleware가 `ctx.hitl.request()`를 호출한다.
- Preconditions:
  - ToolCall은 `turnId`, `agentName`, `conversationId`, `stepNumber`, `toolCallId`, `toolName`, `toolArgs`를 가진다.
  - runtime에 `HitlStore`가 구성되어 있다.
  - 해당 `requestId`가 아직 active/pending 상태로 존재하지 않는다.
- Main Flow:
  1. core는 deterministic `requestId`를 계산한다.
  2. core는 ToolCall snapshot, request prompt, expected response schema, current conversation event snapshot을 포함한 `HitlRequest`를 만든다.
  3. core는 `HitlStore.create(request)`를 호출한다.
  4. 저장 성공 후 `hitl.requested` 이벤트를 발행한다.
  5. 현재 Turn은 `waitingForHuman` 상태로 settle한다.
- Outputs:
  - `TurnResult.status = "waitingForHuman"`
  - `pendingHitlRequestIds`에 생성된 request id 포함
- Side Effects:
  - tool handler는 호출되지 않는다.
  - assistant tool-call 메시지는 conversation에 남아야 한다.
  - tool-result 메시지는 아직 append하지 않는다.
- Failure Modes:
  - store write 실패: `tool.error`와 `turn.error`를 발행하고 Turn은 `error`로 종료한다.
  - 동일 request가 이미 pending: 기존 request를 재사용하고 중복 create를 하지 않는다.

### 7.2 Flow: pending HITL 조회

**ID:** `HITL-LIST-01`

- Actor: Host application, UI, connector, CLI
- Trigger: `runtime.control.listPendingHitl(filter?)`
- Main Flow:
  1. runtime은 filter를 검증한다.
  2. runtime은 `HitlStore.listPending(filter)`를 호출한다.
  3. runtime은 request snapshot 배열을 반환한다.
- Outputs:
  - pending `HitlRequestView[]`
- Failure Modes:
  - store unavailable: typed error를 던지고 runtime lifecycle은 유지한다.

### 7.3 Flow: human result 제출

**ID:** `HITL-SUBMIT-01`

- Actor: Host application, UI, connector, CLI
- Trigger: `runtime.control.submitHitlResult(input)`
- Preconditions:
  - `requestId`가 존재한다.
  - request 상태가 `pending` 또는 retry 가능한 `resuming`이다.
- Main Flow:
  1. runtime은 request를 조회한다.
  2. scope guard가 `agentName`, `conversationId`, optional secret/token을 검증한다.
  3. runtime은 result payload를 request의 expected response schema로 검증한다.
  4. runtime은 `HitlStore.resolve(requestId, result, idempotencyKey)`를 호출한다.
  5. 저장 성공 후 `hitl.resolved` 이벤트를 발행한다.
  6. runtime은 resume worker를 schedule하거나 즉시 resume을 시도한다.
- Alternative Flow:
  - reject result이면 `HitlStore.reject()`를 호출하고 `hitl.rejected` 이벤트를 발행한다.
  - 이미 resolved/rejected이면 기존 final state를 반환하고 새로운 side effect를 만들지 않는다.
- Outputs:
  - `SubmitHitlResult` with `status: "accepted" | "duplicate" | "notFound" | "invalid"`.
- Failure Modes:
  - schema 검증 실패: request 상태를 바꾸지 않고 `invalid` 반환 또는 예외.
  - lease 획득 실패: result 저장은 유지하고 resume은 다른 worker가 처리한다.

### 7.4 Flow: ToolCall resume 실행

**ID:** `HITL-RESUME-01`

- Actor: Runtime resume worker
- Trigger:
  - `submitHitlResult()` 직후
  - runtime startup recovery
  - background retry tick
- Preconditions:
  - request 상태가 `resolved`이고 tool execution이 아직 완료되지 않았다.
  - worker가 lease를 획득했다.
- Main Flow:
  1. runtime은 request의 `agentName`과 `conversationId`에 맞는 conversation state를 준비한다.
  2. 저장된 conversation events를 복원하거나 현재 state가 같은 cursor를 포함하는지 검증한다.
  3. HITL result를 policy mapper에 적용해 최종 action을 계산한다.
     - approve: 원래 args 또는 수정된 args로 tool handler 실행
     - reject: tool handler 생략
     - replace: form/text 값으로 args 갱신 후 tool handler 실행
  4. approve/replace이면 core는 tool 존재 여부와 JSON Schema를 다시 검증한다.
  5. core는 `hitl.resuming` 이벤트를 발행한다.
  6. core는 tool handler를 실행하고 결과를 얻는다.
  7. core는 tool-result message를 conversation에 append한다.
  8. core는 `HitlStore.complete(requestId, toolResult)`를 호출한다.
  9. core는 `hitl.completed`와 `tool.done` 이벤트를 발행한다.
  10. runtime은 이어지는 Step loop를 새 continuation turn으로 실행해 최종 assistant 응답을 만들 수 있다.
- Alternative Flow:
  - reject이면 `ToolResult { type: "error", error: "Human rejected tool call" }` 또는 정책이 지정한 result를 append하고 `hitl.completed`로 종료한다.
  - continuation이 disabled이면 tool result append까지만 수행하고 resume result를 반환한다.
- Failure Modes:
  - tool handler 실패: `HitlStore.fail(requestId, error, retryable)` 저장 후 `hitl.failed`와 `tool.error` 발행.
  - process crash during handler: lease 만료 후 recovery가 request 상태를 보고 재시도한다. 단, 외부 side effect 도구는 idempotency key를 사용해야 한다.
  - conversation restore 실패: request를 `failed(nonRetryable)`로 전환하지 않고 `blocked`로 표시해 운영자가 복구할 수 있게 한다.

### 7.5 Flow: runtime startup recovery

**ID:** `HITL-RECOVER-01`

- Actor: Runtime startup
- Trigger: `createHarness()`가 durable HITL이 활성화된 runtime을 생성한다.
- Main Flow:
  1. runtime은 configured `HitlStore`에서 `pending`, `resolved`, `resuming` 상태 request를 조회한다.
  2. stale lease가 있는 request는 store의 lease policy에 따라 release 가능 여부를 판단한다.
  3. `pending` request는 그대로 노출한다.
  4. `resolved` request는 resume queue에 넣는다.
  5. `resuming` request 중 lease가 만료된 것은 resume queue에 다시 넣는다.
- Outputs:
  - recovery summary event `hitl.recovery` 발행
- Failure Modes:
  - store unavailable: runtime 생성은 config 정책에 따라 실패하거나 degraded mode로 시작한다.

## 8. State Model

### 8.1 HitlRequest 상태

`requested`는 `HitlStore.create()` 호출 전 transient 상태이며 persistent `HitlRequestStatus` 값이 아니다.

```text
requested -> pending -> resolved -> resuming -> completed
                    |          |          |
                    |          |          -> failed(retryable) -> resolved
                    |          |          -> failed(nonRetryable)
                    -> rejected -> completed
                    -> expired -> completed
                    -> canceled -> completed
```

### 8.2 상태 전이 규칙

| From | To | Trigger | 조건 |
| --- | --- | --- | --- |
| `requested` | `pending` | `HitlStore.create()` success | request durable 저장 완료 |
| `pending` | `resolved` | `submitHitlResult(approve/text/json)` | schema/scope 검증 통과 |
| `pending` | `rejected` | `submitHitlResult(reject)` | scope 검증 통과 |
| `resolved` | `resuming` | resume worker lease acquired | execution not completed |
| `resuming` | `completed` | tool result append + store complete | atomic completion 성공 |
| `resuming` | `failed(retryable)` | retryable tool/runtime failure | retry policy 허용 |
| `resuming` | `failed(nonRetryable)` | validation/config fatal failure | 재시도 불가 |
| `pending` | `expired` | TTL policy | result 미제출 |
| `pending` | `canceled` | abort/cancel API | 운영자 또는 host 요청 |

## 9. Constraint Specification

### HITL-CONST-001 - durable-before-observable

- `hitl.requested` 이벤트는 `HitlStore.create()` 성공 후에만 발행한다.
- 이벤트를 본 외부 UI가 request를 조회할 수 없는 상태를 만들면 안 된다.

### HITL-CONST-002 - handler-before-human 금지

- HITL 대상 ToolCall은 approve/replace result 없이 tool handler를 호출할 수 없다.
- middleware가 임의로 우회하려면 tool의 HITL 정책이 `optional`이어야 한다.

### HITL-CONST-003 - at-most-once completion

- `HitlStore.complete()`는 compare-and-set 또는 transaction으로 구현되어야 한다.
- 같은 request가 동시에 resume되어도 conversation에는 tool-result message가 최대 1개만 append되어야 한다.

### HITL-CONST-004 - deterministic request identity

- 기본 `requestId`는 `turnId + stepNumber + toolCallId`로 안정적으로 계산한다.
- host가 custom `requestId`를 제공하면 같은 ToolCall 재시도에서 같은 값을 재사용해야 한다.

### HITL-CONST-005 - tool args mutation은 명시적이다

- HITL result가 args를 바꾸려면 policy mapper가 최종 args를 반환해야 한다.
- 최종 args는 tool JSON Schema 검증을 다시 통과해야 한다.

### HITL-CONST-006 - core는 저장소 구현을 내장하지 않는다

- core는 `HitlStore` 인터페이스와 in-memory test implementation만 제공할 수 있다.
- 파일/SQLite/Postgres/Redis 등 durable backend는 adapter 또는 host application 책임이다.

### HITL-CONST-007 - processTurn promise 장기 보존 금지

- 장기간 HITL 대기에서 `processTurn()` Promise를 무기한 유지하는 것을 기본 동작으로 삼지 않는다.
- ToolCall이 pending으로 전환되면 Turn은 `waitingForHuman`으로 settle하고, resume은 별도 control API가 수행한다.

## 10. Interface Specification

### 10.1 ToolDefinition 확장

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  hitl?: HitlPolicy;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}

type HitlPolicy =
  | { mode: "never" }
  | {
      mode: "required" | "conditional";
      when?: HitlCondition;
      prompt?: string | ((ctx: ToolCallContext) => string);
      response:
        | { type: "approval" }
        | { type: "text"; schema?: JsonSchema }
        | { type: "form"; schema: JsonSchema };
      mapResult?: HitlResultMapper;
      ttlMs?: number;
      onTimeout?: "reject" | "expire";
    };
```

### 10.2 Runtime control API

```ts
interface ControlApi {
  abortConversation(input: AbortConversationInput): Promise<AbortResult>;
  listPendingHitl(filter?: HitlRequestFilter): Promise<HitlRequestView[]>;
  getHitlRequest(requestId: string): Promise<HitlRequestView | null>;
  submitHitlResult(input: SubmitHitlResultInput): Promise<SubmitHitlResult>;
  resumeHitl(requestId: string): Promise<ResumeHitlResult>;
  cancelHitl(input: CancelHitlInput): Promise<CancelHitlResult>;
}
```

### 10.3 HitlStore contract

```ts
interface HitlStore {
  create(request: HitlRequestRecord): Promise<CreateHitlRequestResult>;
  get(requestId: string): Promise<HitlRequestRecord | null>;
  listPending(filter?: HitlRequestFilter): Promise<HitlRequestRecord[]>;
  resolve(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord>;
  reject(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord>;
  acquireLease(requestId: string, ownerId: string, ttlMs: number): Promise<HitlLeaseResult>;
  complete(requestId: string, completion: HitlCompletion): Promise<HitlRequestRecord>;
  fail(requestId: string, failure: HitlFailure): Promise<HitlRequestRecord>;
  releaseLease(requestId: string, ownerId: string): Promise<void>;
}
```

### 10.4 Core data types

```ts
type HitlRequestStatus =
  | "pending"
  | "resolved"
  | "rejected"
  | "resuming"
  | "completed"
  | "failed"
  | "expired"
  | "canceled"
  | "blocked";

interface HitlRequestRecord {
  requestId: string;
  status: HitlRequestStatus;
  agentName: string;
  conversationId: string;
  turnId: string;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
  originalArgs: JsonObject;
  finalArgs?: JsonObject;
  prompt?: string;
  responseSchema: HitlResponseSchema;
  conversationEvents: MessageEvent[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  result?: HitlHumanResult;
  completion?: HitlCompletion;
  lease?: {
    ownerId: string;
    expiresAt: string;
  };
  metadata?: Record<string, JsonValue>;
}

type HitlHumanResult =
  | { decision: "approve"; value?: boolean | string | JsonObject; submittedBy?: string; submittedAt: string }
  | { decision: "reject"; reason?: string; submittedBy?: string; submittedAt: string };
```

### 10.5 StepResult / TurnResult 확장

```ts
interface StepResult {
  pendingHitlRequestIds?: string[];
}

interface TurnResult {
  status: "completed" | "aborted" | "error" | "maxStepsReached" | "waitingForHuman";
  pendingHitlRequestIds?: string[];
}
```

### 10.6 Event payloads

```ts
type HitlEventPayload =
  | { type: "hitl.requested"; request: HitlRequestView }
  | { type: "hitl.resolved"; requestId: string; turnId: string; toolCallId: string }
  | { type: "hitl.rejected"; requestId: string; turnId: string; toolCallId: string; reason?: string }
  | { type: "hitl.resuming"; requestId: string; turnId: string; toolCallId: string }
  | { type: "hitl.completed"; requestId: string; turnId: string; toolCallId: string; result: ToolResult }
  | { type: "hitl.failed"; requestId: string; turnId: string; toolCallId: string; retryable: boolean; error: Error }
  | { type: "hitl.recovery"; recovered: number; pending: number; queuedForResume: number };
```

## 11. Realization Specification

### 11.1 Module Boundaries

- `packages/types/src/hitl.ts`
  - HITL public types, store interface, event payload types.
- `packages/core/src/hitl/store.ts`
  - store helper, in-memory test store, lease utilities.
- `packages/core/src/hitl/runtime.ts`
  - list/get/submit/resume/cancel control API implementation.
- `packages/core/src/execution/tool-call.ts`
  - HITL policy check, request create, `waitingForHuman` short-circuit.
- `packages/core/src/execution/step.ts`
  - pending HITL result를 StepResult에 반영하고 tool-result append 타이밍 조정.
- `packages/core/src/harness-runtime.ts`
  - `HitlStore` 주입, startup recovery, resume worker lifecycle.

### 11.2 Data Ownership

- `ConversationState`는 LLM-visible message history를 소유한다.
- `HitlStore`는 pending/resolved/completed HITL request lifecycle을 소유한다.
- Tool handler side effect의 외부 idempotency는 해당 tool 또는 host application이 소유한다.

### 11.3 Concurrency Strategy

- result 제출은 idempotency key 기반으로 중복 제출을 같은 final state로 수렴시킨다.
- resume worker는 `acquireLease()` 성공 후에만 tool handler를 호출한다.
- lease 만료 전 같은 request에 대한 두 번째 worker는 실행하지 않는다.
- `complete()`는 request status와 completion marker를 transaction으로 갱신해야 한다.

### 11.4 Failure Handling

- request create 실패는 tool 실행 실패로 취급한다.
- result 저장 성공 후 resume 실패는 request를 잃지 않고 `failed(retryable)` 또는 `blocked`로 남긴다.
- runtime close는 진행 중 resume lease를 가능한 한 release하되, 실패해도 lease TTL로 복구 가능해야 한다.
- tool handler가 abort signal을 받으면 request는 retryable failure로 남긴다.

### 11.5 Conversation Continuation

- 기본 정책은 pending 전환 시 현재 Turn을 `waitingForHuman`으로 종료한다.
- resume 시 runtime은 request에 저장된 conversation events를 복원하고 tool-result message를 append한다.
- tool-result append 뒤 `continueAfterHitl`이 true이면 동일 conversation에서 LLM Step loop를 재개해 최종 assistant 응답을 생성한다.
- continuation Turn은 원래 `turnId`를 재사용하지 않고 `continuationOfTurnId` metadata를 가진 새 `turnId`를 사용한다.

### 11.6 Migration / Rollback

- HITL이 비활성화된 config에서는 기존 타입/실행 동작이 유지된다.
- `ToolDefinition.hitl`은 optional field이므로 기존 tool은 변경 없이 컴파일되어야 한다.
- `TurnResult.status` union 확장은 downstream exhaustiveness check에 영향을 주므로 migration note가 필요하다.

## 12. Dependency Map

- Depends On:
  - `execution-loop`
  - `conversation-state`
  - `extension-system`
- Blocks:
  - 승인 UI, Slack/Email approval connector, durable queue integration
- Parallelizable With:
  - CLI HITL UX
  - durable store adapter 구현
  - notification/reminder extension

## 13. Acceptance Criteria

- Given HITL required tool이 등록되어 있고 LLM이 해당 도구를 호출하면, When Step이 ToolCall에 도달하면, Then tool handler는 호출되지 않고 `HitlStore`에 pending request가 저장되며 Turn은 `waitingForHuman`으로 종료된다.
- Given pending HITL request가 저장되어 있으면, When runtime을 종료하고 새 runtime을 생성한 뒤 `listPendingHitl()`을 호출하면, Then 같은 `requestId`가 조회된다.
- Given pending request에 approve result를 제출하면, When `resumeHitl()`이 실행되면, Then 저장된 ToolCall의 tool handler가 1회 호출되고 tool-result message가 conversation에 append된다.
- Given 같은 approve result를 같은 `requestId`로 두 번 제출하면, When 두 resume worker가 동시에 실행되어도, Then tool handler는 최대 1회 호출되고 두 호출자는 같은 final completion을 관찰한다.
- Given pending request에 reject result를 제출하면, When resume이 실행되면, Then tool handler는 호출되지 않고 rejection ToolResult가 conversation에 append된다.
- Given form result가 tool args를 변경하도록 mapping되어 있으면, When resume이 실행되면, Then 최종 args는 JSON Schema 검증을 다시 통과한 뒤 tool handler에 전달된다.
- Given form result가 schema에 맞지 않으면, When `submitHitlResult()`를 호출하면, Then request 상태는 pending으로 유지되고 validation error가 반환된다.
- Given process가 `resolved -> resuming` 중 crash되면, When lease TTL이 지난 뒤 새 runtime recovery가 실행되면, Then request는 다시 resume 대상이 된다.
- Given tool handler가 retryable error를 던지면, When resume이 실패하면, Then request는 `failed(retryable)`로 저장되고 `hitl.failed` 이벤트가 발행된다.
- Given HITL 기능을 사용하지 않는 tool이면, When 기존 tool call flow를 실행하면, Then 기존 `completed/error/maxStepsReached` 동작과 이벤트 순서는 유지된다.

## 14. Open Questions

- `continueAfterHitl` 기본값을 true로 둘지, host가 명시적으로 resume continuation을 호출하게 할지 결정이 필요하다.
- 별도 conversation persistence store 참조 방식은 snapshot 비용이 문제가 될 때 도입할 차기 최적화로 남긴다.
- HITL result 제출 권한 검증은 core가 token 필드만 제공하고 host가 검증할지, core에 pluggable authorizer를 둘지 결정이 필요하다.
- 외부 side effect 도구의 exactly-once 보장은 일반적으로 불가능하므로, tool-level idempotency contract를 얼마나 강제할지 결정이 필요하다.

## 15. Verification Plan

- Unit:
  - HITL policy evaluation
  - deterministic request id
  - result schema validation
  - state transition validation
  - duplicate submit idempotency
- Integration:
  - `processTurn()` -> `waitingForHuman` -> runtime recreate -> `submitHitlResult()` -> `resumeHitl()`
  - concurrent resume race with fake durable store
  - crash simulation by constructing a `resolved/resuming` record before runtime startup
  - rejected request does not call tool handler
  - form result mutates args and revalidates schema
- Regression:
  - existing execution-loop tests pass when no tool has HITL policy
  - existing ingress steering behavior remains unchanged
  - `pnpm -r run typecheck`

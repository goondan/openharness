# hitl - Human Gate and durable human task resume

## 1. 한 줄 요약 (Outcome Statement)

OpenHarness는 사람이 승인하거나 입력해야 하는 ToolCall을 durable Human Task로 전환하고, Human Gate를 conversation blocker로 등록해 입력 유실 없이 안전하게 resume한다.

---

## 2. 상위 스펙 연결 (Traceability)

- Related Goals: `G-1`, `G-4`, `G-5`, `G-7`, `G-8`, `G-9`
- Related Requirements: `FR-HG-001` ~ `FR-HG-017`, `FR-DIR-001` ~ `FR-DIR-006`, `FR-SCHED-003`, `FR-ACTIVE-002`, `NFR-HG-001` ~ `NFR-HG-007`
- Related AC: `AC-07` ~ `AC-12`, `AC-HG-001` ~ `AC-HG-008`, `AC-DIR-005`, `AC-DIR-006`

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: HG-CREATE-01

- Actor: core execution loop, toolCall middleware
- Trigger: `executeToolCall()`이 human gate policy가 적용된 ToolCall을 만난다.
- Preconditions:
  - runtime에 `HumanGateStore`가 구성되어 있다.
  - ToolCall은 `turnId`, `agentName`, `conversationId`, `stepNumber`, `toolCallId`, `toolName`, `toolArgs`를 가진다.
  - 해당 ToolCall에 대해 active human gate가 아직 없다.
- Main Flow:
  1. core는 deterministic `humanGateId`와 required `humanTaskId` 목록을 계산한다.
  2. core는 ToolCall snapshot, prompt, expected result schema, conversation cursor/snapshot을 포함한 human gate record를 만든다.
  3. core는 `HumanGateStore.createGate()`를 호출해 gate와 task를 atomically 저장한다.
  4. `HumanGateStore.createGate()`는 gate/task 저장과 conversation blocker `humanGate` 등록을 같은 atomic boundary에서 완료한다.
  5. core는 `humanGate.created`와 `humanTask.created` 이벤트를 발행한다.
  6. 현재 Turn은 `waitingForHuman` 상태로 settle한다.
- Outputs:
  - `TurnResult.status = "waitingForHuman"`
  - pending human task view
- Side Effects:
  - tool handler는 호출되지 않는다.
  - same conversation inbound item은 durable inbound queue에서 `blockedBy=humanGate`로 남는다.
- Failure Modes:
  - store write 실패: tool handler를 호출하지 않고 Turn을 error로 종료한다.
  - duplicate create: 기존 active gate/task를 반환하고 새 task를 만들지 않는다.

#### Flow ID: HG-LIST-01

- Actor: host application, approval UI, CLI
- Trigger: `runtime.control.listHumanTasks(filter?)`
- Main Flow:
  1. runtime은 filter scope를 검증한다.
  2. runtime은 `HumanGateStore.listTasks()`를 호출한다.
  3. pending/resolved/rejected/canceled/expired task view를 반환한다.
- Outputs:
  - `HumanTaskView[]`
- Failure Modes:
  - store unavailable: typed error를 던지고 runtime lifecycle은 유지한다.

#### Flow ID: HG-SUBMIT-01

- Actor: host application, approval UI, connector, CLI
- Trigger: `runtime.control.submitHumanResult(input)`
- Preconditions:
  - `humanTaskId`가 존재한다.
  - task 상태가 `waitingForHuman`이거나 duplicate submit으로 수렴 가능한 terminal state다.
- Main Flow:
  1. runtime은 task/gate를 조회한다.
  2. scope guard가 `agentName`, `conversationId`, optional token/secret을 검증한다.
  3. runtime은 result payload를 task response schema로 검증한다.
  4. runtime은 idempotency key와 함께 `HumanGateStore.submitResult()`를 호출한다.
  5. 저장 성공 후 `humanTask.resolved` 또는 `humanTask.rejected` 이벤트를 발행한다.
  6. 모든 required task가 resolved/rejected되면 gate를 `ready`로 전환한다.
  7. runtime은 resume worker를 schedule하거나 즉시 resume을 시도한다.
- Alternative Flow:
  - duplicate submit은 기존 result와 gate status를 반환한다.
  - rejection은 handler 호출 없이 rejection tool result를 만들 수 있는 gate result로 저장된다.
- Outputs:
  - submit accepted/duplicate/invalid/notFound result
- Failure Modes:
  - schema/scope 실패: durable state를 바꾸지 않는다.
  - resume lease 실패: result는 저장하고 다른 worker가 resume할 수 있게 둔다.

#### Flow ID: HG-RESUME-01

- Actor: runtime resume worker
- Trigger: human gate ready, runtime startup recovery, explicit `resumeHumanGate(id)`
- Preconditions:
  - gate 상태가 `ready` 또는 retryable `failed`다.
  - resume worker가 gate lease를 획득했다.
- Main Flow:
  1. runtime은 gate를 `resuming`으로 전환한다.
  2. conversation state를 gate의 conversation cursor/snapshot 기준으로 준비한다.
  3. human result를 policy mapper에 적용해 action을 계산한다.
     - approval: 원래 args 또는 보정 args로 tool handler 실행
     - rejection: tool handler 호출 없이 rejection tool result 생성
     - form/text input: mapped args를 JSON Schema로 재검증한 뒤 tool handler 실행
  4. tool result를 conversation에 append한다.
  5. Human Gate blocker를 유지한 상태로 durable inbound queue에서 같은 conversation의 `blockedBy=humanGate` item을 sequence order로 drain한다.
  6. drained inbound item을 user message로 append하고 consumed 처리한다.
  7. blocked item consume이 완료된 뒤 blocker를 해제한다.
  8. gate를 `completed`로 전환하고 lifecycle event를 발행한다.
  9. continuation Turn 실행은 phase 1에서는 optional이며, durable conversation execution과 함께 Planned 범위에서 강화한다.
- Outputs:
  - `HumanGateResumeResult`
  - continuation `TurnResult` if continuation is enabled
- Failure Modes:
  - process crash before side-effect boundary: `resuming` lease expiry 후 다른 worker가 같은 gate를 재획득할 수 있다.
  - process crash after side-effect boundary: gate를 `blocked` 또는 retry policy가 지정한 상태로 남겨 operator가 확인한다.
  - tool handler 실패: `failed(retryable|nonRetryable)`로 전환하고 event를 발행한다.

#### Flow ID: HG-CANCEL-01

- Actor: operator, host application, TTL policy extension
- Trigger: `runtime.control.cancelHumanGate(id)` 또는 expiry policy
- Preconditions:
  - gate가 terminal 상태가 아니다.
- Main Flow:
  1. runtime은 gate/task scope를 검증한다.
  2. store는 gate를 `canceled` 또는 `expired`로 전환한다.
  3. operator cancel 기본 정책은 blocker를 해제하고 blocked inbound items를 sequence order로 `pending`에 되돌린다.
  4. expiry/TTL cancel 기본 정책은 blocked inbound items를 `deadLetter`로 전환한다.
  5. operator가 explicit dead-letter 또는 operatorHold를 지정하면 그 정책이 기본 정책보다 우선한다.
- Outputs:
  - cancel/expire result and lifecycle event
- Failure Modes:
  - resume과 cancel race는 store transition compare-and-set 결과가 canonical이다.

---

## 4. Constraint Specification

### Constraint ID: HG-CONST-001

- Category: Durability
- Description: handler 실행 전 human gate와 required human task가 durable store에 저장되어야 한다.
- Scope: `HG-CREATE-01`
- Measurement: store create 실패 시 handler 호출 count가 0이다.
- Verification: unit/integration test
- Related Behavior: `HG-CREATE-01`

### Constraint ID: HG-CONST-002

- Category: Blocker semantics
- Description: Human Gate는 durable inbound queue를 소유하지 않고 conversation blocker로만 동작한다. blocker lifecycle의 canonical owner는 `HumanGateStore`다.
- Scope: `HG-CREATE-01`, `HG-RESUME-01`
- Measurement: human gate 중 inbound input은 `HumanGateStore` queue가 아니라 `DurableInboundStore` item으로 저장된다.
- Verification: runtime integration test
- Related Behavior: `DIR-SCHED-BLOCK-01`, `HG-RESUME-01`

### Constraint ID: HG-CONST-003

- Category: Idempotency
- Description: duplicate human result submit과 duplicate resume은 중복 task result, 중복 handler execution, 중복 tool-result message를 만들지 않는다.
- Scope: `HG-SUBMIT-01`, `HG-RESUME-01`
- Measurement: same idempotency key and gate lease converge to one result.
- Verification: concurrency test
- Related Behavior: `HG-SUBMIT-01`, `HG-RESUME-01`

### Constraint ID: HG-CONST-004

- Category: Security
- Description: human result 제출은 request identity와 agent/conversation scope 검증을 통과해야 한다.
- Scope: `HG-SUBMIT-01`, `HG-CANCEL-01`
- Measurement: mismatched agent/conversation submit is rejected without state mutation.
- Verification: negative test
- Related Behavior: `HG-SUBMIT-01`

---

## 5. Interface Specification

### 5.1 API Contract

```ts
type HumanGateStatus =
  | "preparing"
  | "waitingForHuman"
  | "ready"
  | "resuming"
  | "completed"
  | "blocked"
  | "canceled"
  | "expired"
  | "failed";

type HumanTaskStatus =
  | "waitingForHuman"
  | "resolved"
  | "rejected"
  | "canceled"
  | "expired";

type HumanResult =
  | { type: "approval"; approved: true; argsPatch?: JsonObject }
  | { type: "rejection"; reason?: string }
  | { type: "text"; text: string }
  | { type: "form"; data: JsonObject };

interface HumanGateStore {
  createGate(input: CreateHumanGateInput): Promise<CreateHumanGateResult>;
  listTasks(filter: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  acquireGateForResume(input: AcquireHumanGateInput): Promise<HumanGateRecord | null>;
  markGateCompleted(input: CompleteHumanGateInput): Promise<HumanGateRecord>;
  markGateFailed(input: FailHumanGateInput): Promise<HumanGateRecord>;
  cancelGate(input: CancelHumanGateInput): Promise<HumanGateRecord>;
  listRecoverableGates(filter?: HumanGateRecoveryFilter): Promise<HumanGateRecord[]>;
}
```

### 5.2 Runtime Surface

- `runtime.control.listHumanTasks(filter?)`
- `runtime.control.submitHumanResult(input)`
- `runtime.control.resumeHumanGate(id)`
- `runtime.control.cancelHumanGate(id)`
- `runtime.control.listInboundItems(filter?)` for blocked input visibility

### 5.3 Event Contract

| Event | Required correlation fields |
| --- | --- |
| `humanGate.created` | `humanGateId`, `agentName`, `conversationId`, `turnId`, `toolCallId` |
| `humanTask.created` | `humanGateId`, `humanTaskId`, `taskType`, `agentName`, `conversationId` |
| `humanTask.resolved` | `humanTaskId`, `humanGateId`, `idempotencyKey` |
| `humanTask.rejected` | `humanTaskId`, `humanGateId`, `idempotencyKey` |
| `humanGate.ready` | `humanGateId`, `taskIds` |
| `humanGate.resuming` | `humanGateId`, `leaseOwner`, `turnId` |
| `humanGate.completed` | `humanGateId`, `turnId`, `blockedInboundItemIds` |
| `humanGate.failed` | `humanGateId`, `retryable`, `reason` |
| `humanGate.canceled` | `humanGateId`, `reason` |

---

## 6. Realization Specification

- Module Boundaries:
  - `packages/types`: Human Gate policy, task/result/store/control/event types.
  - `packages/core/src/hitl`: store implementation, policy evaluation, resume worker.
  - `packages/core/src/execution/tool-call.ts`: handler-before-human guard and gate creation hook.
  - `packages/core/src/inbound`: blocker lookup and blocked item drain.
- Data Ownership:
  - `HumanGateStore` owns gate/task/result lifecycle.
  - `HumanGateStore` owns the canonical conversation blocker lifecycle for Human Gate.
  - `DurableInboundStore` owns inbound items queued while gate blocks conversation and stores only blocker references.
  - conversation state owns appended tool-result/user messages.
- State Model:
  - gate: `preparing -> waitingForHuman -> ready -> resuming -> completed`
  - gate alternatives: `waitingForHuman -> canceled|expired`, `ready|resuming -> failed|blocked`
  - task: `waitingForHuman -> resolved|rejected|canceled|expired`
- Concurrency Strategy:
  - create/submit/resume/cancel use idempotency key and compare-and-set transitions.
  - resume owns a lease; only the lease holder may execute handler or append tool result.
  - a gate in `resuming` with an expired resume lease is recoverable and may be acquired by another worker.
- Failure Handling:
  - before side-effect boundary, retry is automatic after lease expiry.
  - canceling a Human Gate releases its conversation blocker and returns blocked inbound items to scheduler ownership; expiring a gate dead-letters those items by default.
  - after side-effect boundary, retry requires idempotent tool result commit or operator intervention.
- Deployment Location:
  - core provides in-memory/reference store and contracts.
  - external approval UI, reminders, escalation, TTL policy are extension/host responsibilities.
- Observability Plan:
  - gate/task lifecycle events plus inbound blocker events expose full status.
  - pending tasks and blocked inbound items are queryable.
- Migration / Rollback:
  - legacy `HitlRequest` naming may be kept as compatibility alias only.
  - public Desired State uses Human Gate/Human Task terminology.

---

## 7. Dependency Map

- Depends On: `inbound/durable-inbound`, `core/execution-loop`, `core/conversation-state`
- Blocks: external approval UI/CLI, production durable human task adapters
- Parallelizable With: inbound store implementation, event typing, control API views

---

## 8. Acceptance Criteria

- Given required human gate policy를 가진 tool이 있다, When LLM이 해당 tool을 요청한다, Then durable human task creation이 성공하기 전에는 tool handler가 호출되지 않는다.
- Given human task store creation이 실패한다, When tool call이 평가된다, Then Turn은 error가 되고 human task event와 handler side effect는 관찰되지 않는다.
- Given conversation이 Human Gate에서 waiting 상태다, When 새 ingress/direct input이 들어온다, Then input은 HITL 전용 queue가 아니라 durable inbound queue에 append되고 `blockedBy=humanGate`로 표시된다.
- Given pending human task에 같은 idempotency key의 duplicate submit request가 들어온다, When 두 submit이 완료된다, Then durable result는 하나만 존재하고 두 caller는 같은 final result를 관찰한다.
- Given human task가 rejected 상태다, When resume이 실행된다, Then 원래 tool handler는 호출되지 않고 rejection tool result가 append된다.
- Given human task가 form args와 함께 approved 상태다, When resume이 실행된다, Then mapped args는 handler 실행 전에 tool JSON Schema 검증을 통과한다.
- Given ready gate와 blocked inbound item 2개가 있다, When resume이 완료된다, Then tool result가 먼저 append되고 blocked inbound items가 sequence order로 append된다.
- Given ready gate와 blocked inbound item 2개가 있다, When resume이 blocked item을 drain한다, Then tool result append, blocked item append, item consume이 모두 완료될 때까지 Human Gate blocker는 active 상태로 유지된다.
- Given 두 resume worker가 같은 ready gate를 처리하려 한다, When 둘 다 lease 획득을 시도한다, Then 하나만 handler를 실행하고 다른 하나는 existing completion 또는 lease conflict로 수렴한다.

# hitl - Human Approval and durable human task resume

## 1. 한 줄 요약 (Outcome Statement)

OpenHarness는 사람이 승인하거나 입력해야 하는 ToolCall을 `humanApproval` policy로 선언하고, durable approval record와 Human Task를 통해 입력 유실 없이 안전하게 resume한다.

---

## 2. 상위 스펙 연결 (Traceability)

- Related Goals: `G-1`, `G-4`, `G-5`, `G-7`, `G-8`, `G-9`
- Related Requirements: `FR-HA-001` ~ `FR-HA-017`, `FR-DIR-001` ~ `FR-DIR-006`, `FR-SCHED-003`, `FR-ACTIVE-002`, `NFR-HA-001` ~ `NFR-HA-007`
- Related AC: `AC-07` ~ `AC-12`, `AC-HA-001` ~ `AC-HA-008`, `AC-DIR-005`, `AC-DIR-006`

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: HA-CREATE-01

- Actor: core execution loop, toolCall middleware
- Trigger: `executeToolCall()`이 `humanApproval` policy가 적용된 ToolCall을 만난다.
- Preconditions:
  - runtime에 `HumanApprovalStore`가 구성되어 있다.
  - ToolCall은 `turnId`, `agentName`, `conversationId`, `stepNumber`, `toolCallId`, `toolName`, `toolArgs`를 가진다.
  - 해당 ToolCall에 대해 active approval record가 아직 없다.
- Main Flow:
  1. core는 deterministic `humanApprovalId`와 required `humanTaskId` 목록을 계산한다.
  2. core는 ToolCall snapshot, prompt, expected result schema, conversation cursor/snapshot을 포함한 approval record를 만든다.
  3. core는 `HumanApprovalStore.createApproval()`를 호출해 approval와 task를 atomically 저장한다.
  4. `HumanApprovalStore.createApproval()`는 approval/task 저장과 conversation blocker `humanApproval` 등록을 같은 atomic boundary에서 완료한다.
  5. core는 `humanApproval.created`와 `humanTask.created` 이벤트를 발행한다.
  6. 현재 Turn은 `waitingForHuman` 상태로 settle한다.
- Outputs:
  - `TurnResult.status = "waitingForHuman"`
  - pending human task view
- Side Effects:
  - tool handler는 호출되지 않는다.
  - same conversation inbound item은 durable inbound queue에서 `blockedBy=humanApproval`로 남는다.
- Failure Modes:
  - store write 실패: tool handler를 호출하지 않고 Turn을 error로 종료한다.
  - duplicate create: 기존 active approval/task를 반환하고 새 task를 만들지 않는다.

#### Flow ID: HA-LIST-01

- Actor: host application, approval UI, CLI
- Trigger: `runtime.control.listHumanTasks(filter?)`
- Main Flow:
  1. runtime은 filter scope를 검증한다.
  2. runtime은 `HumanApprovalStore.listTasks()`를 호출한다.
  3. runtime은 store payload를 public `HumanTaskView` shape으로 정규화한다.
  4. pending/resolved/rejected/canceled/expired task view를 반환한다.
- Outputs:
  - `HumanTaskView[]`; task 종류는 public `type`, result idempotency key는 public `idempotencyKey` field로 노출한다.
- Failure Modes:
  - store unavailable: typed error를 던지고 runtime lifecycle은 유지한다.

#### Flow ID: HA-SUBMIT-01

- Actor: host application, approval UI, connector, CLI
- Trigger: `runtime.control.submitHumanResult(input)`
- Preconditions:
  - `humanTaskId`가 존재한다.
  - task 상태가 `waitingForHuman`이거나 duplicate submit으로 수렴 가능한 terminal state다.
- Main Flow:
  1. runtime은 task/approval을 조회한다.
  2. scope guard가 `agentName`, `conversationId`, optional token/secret을 검증한다.
  3. runtime은 result payload를 task response schema로 검증한다.
  4. runtime은 idempotency key와 함께 `HumanApprovalStore.submitResult()`를 호출한다.
  5. 저장 성공 후 duplicate가 아니면 `humanTask.resolved` 또는 `humanTask.rejected` 이벤트를 발행한다.
  6. 모든 required task가 resolved/rejected되면 approval을 `ready`로 전환한다.
  7. runtime은 resume worker를 schedule하거나 즉시 resume을 시도한다.
- Alternative Flow:
  - duplicate submit은 lifecycle event를 재발행하지 않고 `{ accepted: true, duplicate: true, task, approval }`을 반환한다.
  - missing/invalid submit은 `SubmitHumanResult` payload로 누출하지 않고 typed error를 던진다.
  - rejection은 handler 호출 없이 rejection tool result를 만들 수 있는 approval result로 저장된다.
- Outputs:
  - `SubmitHumanResult`: `{ accepted: true, duplicate: boolean, task: HumanTaskView, approval: HumanApprovalRecord }`
- Failure Modes:
  - schema/scope 실패: durable state를 바꾸지 않는다.
  - resume lease 실패: result는 저장하고 다른 worker가 resume할 수 있게 둔다.

#### Flow ID: HA-RESUME-01

- Actor: runtime resume worker
- Trigger: human approval ready, runtime startup recovery, explicit `resumeHumanApproval(id)`
- Preconditions:
  - approval 상태가 `ready` 또는 retryable `failed`다.
  - resume worker가 approval lease를 획득했다.
- Main Flow:
  1. runtime은 approval을 `resuming`으로 전환한다.
  2. conversation state를 approval의 conversation cursor/snapshot 기준으로 준비한다.
  3. human result를 policy mapper에 적용해 action을 계산한다.
     - approval: 원래 args 또는 보정 args로 tool handler 실행
     - rejection: tool handler 호출 없이 rejection tool result 생성
     - form/text input: mapped args를 JSON Schema로 재검증한 뒤 tool handler 실행
  4. handler 실행이 필요한 action이면 runtime은 `markApprovalHandlerStarted()`를 durable하게 기록한 뒤 normal ToolCall execution path로 tool middleware와 handler를 호출한다.
  5. tool result를 conversation에 append한다.
  6. Human Approval blocker를 유지한 상태로 durable inbound queue에서 같은 conversation의 `blockedBy=humanApproval` item을 sequence order로 drain한다.
  7. drained inbound item을 user message로 append하고 consumed 처리한다.
  8. blocked item consume이 완료된 뒤 blocker를 해제한다.
  9. runtime은 획득한 resume `leaseOwner`로 approval을 `completed`로 전환하고 lifecycle event를 발행한다.
  10. blocker 해제 후 runtime은 tool result와 blocked inbound user messages가 반영된 conversation에서 continuation Turn을 실행한다.
- Outputs:
  - `HumanApprovalResumeResult`
  - continuation `TurnResult`
- Failure Modes:
  - process crash before `markApprovalHandlerStarted()`: `resuming` lease expiry 후 다른 worker가 같은 approval을 재획득할 수 있다.
  - process crash after `markApprovalHandlerStarted()`: runtime은 자동 재획득/handler 재실행을 하지 않고 operator 확인 대상으로 남긴다.
  - tool handler 실패: runtime은 획득한 resume `leaseOwner`로 `failed(retryable|nonRetryable)` 전환을 기록하고 event를 발행한다.

#### Flow ID: HA-CANCEL-01

- Actor: operator, host application, TTL policy extension
- Trigger: `runtime.control.cancelHumanApproval(id)` 또는 expiry policy
- Preconditions:
  - approval이 terminal 상태가 아니다.
- Main Flow:
  1. runtime은 approval/task scope를 검증한다.
  2. store는 approval을 `canceled` 또는 `expired`로 전환한다.
  3. operator cancel 기본 정책은 blocker를 해제하고 blocked inbound items를 sequence order로 `pending`에 되돌린다.
  4. expiry/TTL cancel 기본 정책은 blocked inbound items를 `deadLetter`로 전환한다.
  5. operator가 explicit dead-letter 또는 operatorHold를 지정하면 그 정책이 기본 정책보다 우선한다.
- Outputs:
  - cancel/expire result and lifecycle event
- Failure Modes:
  - resume과 cancel race는 store transition compare-and-set 결과가 canonical이다.

---

## 4. Constraint Specification

### Constraint ID: HA-CONST-001

- Category: Durability
- Description: handler 실행 전 approval record와 required human task가 durable store에 저장되어야 한다.
- Scope: `HA-CREATE-01`
- Measurement: store create 실패 시 handler 호출 count가 0이다.
- Verification: unit/integration test
- Related Behavior: `HA-CREATE-01`

### Constraint ID: HA-CONST-002

- Category: Blocker semantics
- Description: Human Approval은 durable inbound queue를 소유하지 않고 conversation blocker로만 동작한다. blocker lifecycle의 canonical owner는 `HumanApprovalStore`이며, Human Approval 사용 시 `DurableInboundStore` 구성이 필수다.
- Scope: `HA-CREATE-01`, `HA-RESUME-01`
- Measurement: human approval 중 inbound input은 `HumanApprovalStore` queue가 아니라 `DurableInboundStore` item으로 저장된다.
- Verification: runtime integration test
- Related Behavior: `DIR-SCHED-BLOCK-01`, `HA-RESUME-01`

### Constraint ID: HA-CONST-003

- Category: Idempotency
- Description: duplicate human result submit과 duplicate resume은 중복 task result, 중복 handler execution, 중복 tool-result message를 만들지 않는다.
- Scope: `HA-SUBMIT-01`, `HA-RESUME-01`
- Measurement: same idempotency key and approval lease converge to one result.
- Verification: concurrency test
- Related Behavior: `HA-SUBMIT-01`, `HA-RESUME-01`

### Constraint ID: HA-CONST-004

- Category: Security
- Description: human result 제출은 request identity와 agent/conversation scope 검증을 통과해야 한다.
- Scope: `HA-SUBMIT-01`, `HA-CANCEL-01`
- Measurement: mismatched agent/conversation submit is rejected without state mutation.
- Verification: negative test
- Related Behavior: `HA-SUBMIT-01`

---

## 5. Interface Specification

### 5.1 API Contract

```ts
type HumanApprovalStatus =
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

interface HumanApprovalStore {
  createApproval(input: CreateHumanApprovalInput): Promise<CreateHumanApprovalResult>;
  listTasks(filter: HumanTaskFilter): Promise<HumanTaskView[]>;
  submitResult(input: SubmitHumanResultInput): Promise<SubmitHumanResult>;
  acquireApprovalForResume(input: AcquireHumanApprovalInput): Promise<HumanApprovalRecord | null>;
  markApprovalHandlerStarted(input: MarkHumanApprovalHandlerStartedInput): Promise<HumanApprovalRecord>;
  markApprovalCompleted(input: CompleteHumanApprovalInput): Promise<HumanApprovalRecord>;
  markApprovalFailed(input: FailHumanApprovalInput): Promise<HumanApprovalRecord>;
  cancelApproval(input: CancelHumanApprovalInput): Promise<HumanApprovalRecord>;
  listRecoverableApprovals(filter?: HumanApprovalRecoveryFilter): Promise<HumanApprovalRecord[]>;
}
```

### 5.2 Runtime Surface

- `runtime.control.listHumanTasks(filter?)`
- `runtime.control.submitHumanResult(input)`
- `runtime.control.resumeHumanApproval(id)`
- `runtime.control.cancelHumanApproval(id)`
- `runtime.control.listInboundItems(filter?)` for blocked input visibility

### 5.3 Event Contract

| Event | Required correlation fields |
| --- | --- |
| `humanApproval.created` | `humanApprovalId`, `agentName`, `conversationId`, `turnId`, `toolCallId` |
| `humanTask.created` | `humanApprovalId`, `humanTaskId`, `taskType`, `agentName`, `conversationId` |
| `humanTask.resolved` | `humanTaskId`, `humanApprovalId`, `idempotencyKey` |
| `humanTask.rejected` | `humanTaskId`, `humanApprovalId`, `idempotencyKey` |
| `humanApproval.ready` | `humanApprovalId`, `taskIds` |
| `humanApproval.resuming` | `humanApprovalId`, `leaseOwner`, `turnId` |
| `humanApproval.completed` | `humanApprovalId`, `turnId`, `blockedInboundItemIds` |
| `humanApproval.failed` | `humanApprovalId`, `retryable`, `reason` |
| `humanApproval.canceled` | `humanApprovalId`, `reason` |

---

## 6. Realization Specification

- Module Boundaries:
  - `packages/types`: `humanApproval` policy, task/result/store/control/event types.
  - `packages/core/src/hitl`: store implementation, policy evaluation, resume worker.
  - `packages/core/src/execution/tool-call.ts`: handler-before-human guard and approval creation hook.
  - `packages/core/src/inbound`: blocker lookup and blocked item drain.
- Data Ownership:
  - `HumanApprovalStore` owns approval/task/result lifecycle.
  - `HumanApprovalStore` owns the canonical conversation blocker lifecycle for Human Approval.
  - `DurableInboundStore` owns inbound items queued while approval blocks conversation and stores only blocker references.
  - conversation state owns appended tool-result/user messages.
- State Model:
  - approval: `preparing -> waitingForHuman -> ready -> resuming -> completed`
  - approval alternatives: `waitingForHuman -> canceled|expired`, `ready|resuming -> failed|blocked`
  - task: `waitingForHuman -> resolved|rejected|canceled|expired`
- Concurrency Strategy:
  - create/submit/resume/cancel use idempotency key and compare-and-set transitions.
  - resume owns a lease; only the lease holder may execute handler or append tool result.
  - an approval in `resuming` with an expired resume lease is recoverable only if `handlerStartedAt` has not been recorded.
  - once `handlerStartedAt` is recorded, automatic reacquire must not re-run the handler; operator/idempotent adapter intervention is required.
- Failure Handling:
  - before side-effect boundary, retry is automatic after lease expiry.
  - canceling a Human Approval releases its conversation blocker and returns blocked inbound items to scheduler ownership; expiring an approval dead-letters those items by default.
  - after side-effect boundary, retry requires idempotent tool result commit or operator intervention.
- Deployment Location:
  - core provides in-memory/reference store and contracts.
  - external approval UI, reminders, escalation, TTL policy are extension/host responsibilities.
- Observability Plan:
  - approval/task lifecycle events plus inbound blocker events expose full status.
  - pending tasks and blocked inbound items are queryable.
- Migration / Rollback:
  - legacy `HitlRequest` naming may be kept as compatibility alias only.
  - public ToolDefinition/HarnessConfig Desired State uses `humanApproval` naming; durable store/control/event internals may keep Human Approval identifiers as compatibility aliases.

---

## 7. Dependency Map

- Depends On: `inbound/durable-inbound`, `core/execution-loop`, `core/conversation-state`
- Blocks: external approval UI/CLI, production durable human task adapters
- Parallelizable With: inbound store implementation, event typing, control API views

---

## 8. Acceptance Criteria

- Given required `humanApproval` policy를 가진 tool이 있다, When LLM이 해당 tool을 요청한다, Then durable human task creation이 성공하기 전에는 tool handler가 호출되지 않는다.
- Given `humanApproval.store`가 설정되었지만 `durableInbound.store`가 없다, When runtime 생성이 실행된다, Then runtime은 fail-fast 한다.
- Given human task store creation이 실패한다, When tool call이 평가된다, Then Turn은 error가 되고 human task event와 handler side effect는 관찰되지 않는다.
- Given conversation이 Human Approval에서 waiting 상태다, When 새 ingress/direct input이 들어온다, Then input은 HITL 전용 queue가 아니라 durable inbound queue에 append되고 `blockedBy=humanApproval`로 표시된다.
- Given active Turn으로 delivered 된 durable inbound item이 consume 되기 전에 같은 Turn이 Human Approval로 pause된다, When Turn이 `waitingForHuman`으로 반환된다, Then delivered item은 같은 Human Approval blocker로 `blocked` 상태가 된다.
- Given pending human task에 같은 idempotency key의 duplicate submit request가 들어온다, When 두 submit이 완료된다, Then durable result는 하나만 존재하고 두 caller는 같은 final result를 관찰한다.
- Given human task가 rejected 상태다, When resume이 실행된다, Then 원래 tool handler는 호출되지 않고 rejection tool result가 append된다.
- Given human task가 form args와 함께 approved 상태다, When resume이 실행된다, Then mapped args는 handler 실행 전에 tool JSON Schema 검증을 통과한다.
- Given ready approval와 blocked inbound item 2개가 있다, When resume이 완료된다, Then tool result가 먼저 append되고 blocked inbound items가 sequence order로 append된 뒤 continuation Turn이 실행된다.
- Given ready approval와 blocked inbound item 2개가 있다, When resume이 blocked item을 drain한다, Then tool result append, blocked item append, item consume이 모두 완료될 때까지 Human Approval blocker는 active 상태로 유지된다.
- Given approval이 `failed`, `canceled`, 또는 `expired` terminal 상태다, When `resumeHumanApproval(id)`가 호출된다, Then runtime은 `blocked`가 아니라 `failed` resume result를 반환한다.
- Given 두 resume worker가 같은 ready approval을 처리하려 한다, When 둘 다 lease 획득을 시도한다, Then 하나만 handler를 실행하고 다른 하나는 existing completion 또는 lease conflict로 수렴한다.

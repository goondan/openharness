# durable-inbound - Durable ingress, direct input, and conversation scheduling

## 1. 한 줄 요약 (Outcome Statement)

OpenHarness runtime은 외부 ingress와 direct input을 처리 전 durable inbound log에 먼저 기록하고, conversation 상태에 따라 새 Turn 시작, active Turn delivery, blocker 대기, retry/recovery를 같은 계약으로 처리한다.

---

## 2. 상위 스펙 연결 (Traceability)

- Related Goals: `G-1`, `G-3`, `G-5`, `G-8`, `G-9`
- Related Requirements: `FR-INGRESS-010`, `FR-INGRESS-011`, `FR-INGRESS-012`, `FR-INGRESS-013`, `FR-DIR-001`, `FR-DIR-002`, `FR-DIR-003`, `FR-DIR-004`, `FR-DIR-005`, `FR-DIR-006`, `FR-SCHED-001`, `FR-SCHED-002`, `FR-SCHED-003`, `FR-ACTIVE-001`, `FR-ACTIVE-002`, `FR-DIRECT-001`, `FR-DIRECT-002`, `FR-OBS-001`, `FR-HA-004`, `FR-HA-005`, `FR-HA-010`, `NFR-DIR-001` ~ `NFR-DIR-009`
- Related AC: `AC-04`, `AC-04b`, `AC-04c`, `AC-DIR-001` ~ `AC-DIR-010`

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: DIR-RECEIVE-01

- Actor: connector host, connection extension, runtime ingress API
- Trigger: `runtime.ingress.receive({ connectionName, payload, receivedAt? })`
- Preconditions:
  - `connectionName`이 등록되어 있다.
  - connector verify/normalize가 raw payload를 `InboundEnvelope` 하나 이상으로 변환할 수 있다.
  - durable inbound mode이면 runtime에 `DurableInboundStore`가 구성되어 있다.
- Main Flow:
  1. runtime은 `ingress.received` 이벤트를 발행한다.
  2. connection ingress middleware, connector verify, connector normalize를 순서대로 실행한다.
  3. 각 envelope에 대해 route rule과 route middleware를 적용해 `agentName`, `conversationId`, `eventName`을 결정한다.
  4. durable inbound mode이면 accepted 결과를 반환하기 전에 `DurableInboundStore.append()`를 호출한다.
  5. append가 새 item을 만들면 scheduler를 실행한다.
  6. append가 duplicate이면 새 item을 만들지 않고 기존 item identity와 현재 disposition을 반환한다.
  7. runtime은 scheduler decision을 `IngressAcceptResult`와 `ingress.accepted` 이벤트로 노출한다.
- Alternative Flow:
  - durable inbound mode가 꺼져 있으면 기존 in-memory fire-and-forget dispatch semantics를 유지한다.
  - normalize fan-out은 envelope별로 독립 append/schedule한다.
- Outputs:
  - durable mode: `inboundItemId`, canonical `disposition`, optional `turnId`, optional `blocker`가 포함된 accepted result
  - non-durable mode: 기존 `started`/`steered` accepted result
- Side Effects:
  - accepted 된 durable item은 `consumed` 또는 `deadLetter`가 될 때까지 조회/재처리 가능하다.
- Failure Modes:
  - verify/normalize/route 실패: durable append 없이 `ingress.rejected`를 발행한다.
  - append 실패: accepted result와 `ingress.accepted`를 만들지 않고 오류를 반환/throw 한다.

#### Flow ID: DIR-DIRECT-01

- Actor: programmatic caller
- Trigger: durable mode의 `runtime.processTurn(agentName, input, options?)`
- Preconditions:
  - `agentName`이 등록되어 있다.
  - caller가 `conversationId`를 제공했거나 runtime이 새 conversation id를 생성할 수 있다.
- Main Flow:
  1. runtime은 string input을 programmatic `InboundEnvelope`로 정규화한다.
  2. runtime은 direct source metadata와 idempotency key를 계산한다.
  3. runtime은 `DurableInboundStore.append()`를 먼저 호출한다.
  4. scheduler decision이 `started` 또는 `delivered`이면 caller는 관련 Turn의 terminal result를 await할 수 있다.
  5. scheduler decision이 `blocked`이면 caller는 accepted blocked result를 받으며 Turn 완료를 기다리지 않는다.
- Outputs:
  - `processTurn()`은 기존 `TurnResult` 호환성을 유지한다.
  - `started`와 active `delivered` 경로는 관련 Turn의 terminal `TurnResult`로 수렴한다.
  - blocker 경로는 `TurnResult.status="waitingForHuman"`으로 수렴하고 inbound item은 control API에서 조회한다.
  - fire-and-forget direct enqueue와 accepted handle 중심 API는 별도 Planned API가 소유한다.
- Failure Modes:
  - append 실패 시 input은 accepted 된 것으로 관찰되면 안 된다.
  - duplicate direct retry는 기존 inbound item과 연결된다.

#### Flow ID: DIR-SCHED-START-01

- Actor: conversation scheduler
- Trigger: 새 pending inbound item append, background worker tick, recovery
- Preconditions:
  - 같은 `(agentName, conversationId)`에 active Turn이 없다.
  - conversation blocker가 없다.
  - 가장 이른 pending item lease 획득이 성공했다.
- Main Flow:
  1. scheduler는 sequence order상 가장 이른 pending item을 lease 한다.
  2. runtime은 item envelope로 새 Turn을 시작하고 `turnId`를 item에 기록한다.
  3. Turn 시작 시 inbound item을 user message로 append한다.
  4. conversation append commit reference와 inbound item consume reference를 연결한다.
  5. commit 성공 후 item을 `consumed`로 표시한다.
- Outputs:
  - disposition `started`, `turnId`, `inboundItemId`
- Failure Modes:
  - lease conflict: losing worker는 no-op/conflict result로 수렴한다.
  - append 후 Turn 시작 전 crash: item은 lease 만료 뒤 다시 pending/retryable이 된다.

#### Flow ID: DIR-SCHED-ACTIVE-01

- Actor: conversation scheduler, active Turn
- Trigger: active Turn이 있는 conversation에 pending item이 생긴다.
- Preconditions:
  - active Turn이 steer 가능한 상태다.
  - human approval/operator hold blocker가 없다.
- Main Flow:
  1. scheduler는 pending item을 active Turn delivery 대상으로 mark 한다.
  2. in-memory steering inbox는 active Turn wake-up/cache로만 사용한다.
  3. active Turn은 Step 경계에서 durable inbound queue를 sequence order로 drain 한다.
  4. drained item을 user message로 append한다.
  5. append commit reference를 사용해 item을 `consumed`로 표시한다.
- Outputs:
  - canonical disposition `delivered`
  - migration compatibility가 필요하면 `steered`를 alias로 함께 노출할 수 있다.
- Failure Modes:
  - notification 이후 delivery 전 crash: durable item 기준으로 recovery한다.
  - delivery 후 consume 전 crash: commit reference로 중복 user message append를 막는다.

#### Flow ID: DIR-SCHED-BLOCK-01

- Actor: conversation scheduler
- Trigger: blocker가 있는 conversation에 pending item이 생긴다.
- Preconditions:
  - conversation에 `humanApproval` 또는 `operatorHold` blocker가 있다.
- Main Flow:
  1. scheduler는 새 Turn을 시작하지 않는다.
  2. scheduler는 inbound item을 `blocked`로 표시하고 `blockedBy` metadata를 저장한다.
  3. Human Approval blocker인 경우 blocker 유지 상태에서 `HA-RESUME-01`이 tool result append 후 blocked item을 sequence order로 consume한다.
  4. operator hold blocker인 경우 blocker 해제 후 blocked item은 sequence order에 따라 pending 대상으로 전환된다.
- Outputs:
  - disposition `blocked`, blocker metadata, `inboundItemId`
- Failure Modes:
  - blocker 등록과 scheduler race가 발생하면 store transaction/lease 결과가 canonical decision이 된다.

#### Flow ID: DIR-RECOVER-01

- Actor: runtime startup, background worker, host recovery job
- Trigger: runtime 생성, lease expiry tick, explicit retry
- Preconditions:
  - durable inbound store가 pending/leased/blocked/failed/deadLetter item을 조회할 수 있다.
- Main Flow:
  1. runtime은 expired lease를 release 또는 retryable failed 상태로 전환한다.
  2. pending item을 conversation별 sequence order로 scheduler에 넘긴다.
  3. blocker가 이미 해제된 blocked item은 pending으로 되돌린다.
  4. retry 한도를 넘은 item은 `deadLetter`로 전환한다.
- Outputs:
  - recovery summary event와 queue depth/dead-letter metrics
- Failure Modes:
  - store unavailable이면 durable mode runtime 생성 정책에 따라 fail-fast 또는 degraded read-only로 시작한다.

---

## 4. Constraint Specification

### Constraint ID: DIR-CONST-001

- Category: Durability
- Description: durable mode에서 accepted result와 `ingress.accepted` 이벤트는 inbound append 성공 이후에만 발생한다.
- Scope: `DIR-RECEIVE-01`, `DIR-DIRECT-01`
- Measurement: append 실패 injection 시 accepted result/event가 없어야 한다.
- Verification: unit/integration crash injection test
- Related Behavior: `DIR-RECEIVE-01`, `DIR-DIRECT-01`

### Constraint ID: DIR-CONST-002

- Category: Ordering
- Description: 같은 `(agentName, conversationId)`의 inbound item은 deterministic sequence order로 delivery된다.
- Scope: 전체 durable inbound flow
- Measurement: 동시 append 시 sequence가 유일하고 delivery order가 sequence를 따른다.
- Verification: store contract test, scheduler concurrency test
- Related Behavior: `DIR-SCHED-START-01`, `DIR-SCHED-ACTIVE-01`

### Constraint ID: DIR-CONST-003

- Category: Idempotency
- Description: duplicate append, duplicate scheduler run, duplicate consume은 중복 inbound item 또는 중복 user message를 만들지 않는다.
- Scope: 전체 durable inbound flow
- Measurement: 같은 idempotency key와 commit reference가 같은 결과로 수렴한다.
- Verification: duplicate connector retry, consume idempotency test
- Related Behavior: `DIR-RECEIVE-01`, `DIR-SCHED-START-01`, `DIR-SCHED-ACTIVE-01`

### Constraint ID: DIR-CONST-004

- Category: Compatibility
- Description: durable mode는 명시적 opt-in이어야 하며, durable store가 없는 기본 runtime은 기존 in-memory ingress/processTurn 동작을 유지한다.
- Scope: public runtime creation
- Measurement: 기존 regression test가 config 변경 없이 통과한다.
- Verification: existing integration tests
- Related Behavior: `DIR-RECEIVE-01`, `DIR-DIRECT-01`

---

## 5. Interface Specification

### 5.1 API Contract

```ts
type InboundItemStatus =
  | "pending"
  | "leased"
  | "delivered"
  | "blocked"
  | "consumed"
  | "failed"
  | "deadLetter";

type IngressDisposition =
  | "started"
  | "delivered"
  | "blocked"
  | "duplicate"
  | "steered";

interface DurableInboundItem {
  id: string;
  agentName: string;
  conversationId: string;
  sequence: number;
  envelope: InboundEnvelope;
  source: {
    kind: "ingress" | "direct";
    connectionName?: string;
    externalId?: string;
    receivedAt: string;
  };
  idempotencyKey: string;
  status: InboundItemStatus;
  turnId?: string;
  blockedBy?: ConversationBlockerRef;
  commitRef?: string;
  lease?: LeaseInfo;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

interface DurableInboundStore {
  append(input: AppendInboundInput): Promise<AppendInboundResult>;
  acquireNext(input: AcquireInboundInput): Promise<DurableInboundItem | null>;
  markDelivered(input: MarkInboundDeliveredInput): Promise<DurableInboundItem>;
  markBlocked(input: MarkInboundBlockedInput): Promise<DurableInboundItem>;
  markConsumed(input: MarkInboundConsumedInput): Promise<DurableInboundItem>;
  releaseExpiredLeases(now: string): Promise<number>;
  listInboundItems(filter: InboundItemFilter): Promise<DurableInboundItem[]>;
  retryInboundItem(id: string): Promise<DurableInboundItem>;
  deadLetterInboundItem(input: DeadLetterInboundInput): Promise<DurableInboundItem>;
}
```

### 5.2 Runtime Surface

- `runtime.ingress.receive()` and `runtime.ingress.dispatch()` return accepted handles with `inboundItemId` in durable mode.
- `runtime.processTurn()` durable mode preserves the existing `TurnResult` contract while using append-first processing internally.
- `runtime.control.listInboundItems(filter)` exposes pending/blocked/failed/deadLetter item views.
- `runtime.control.retryInboundItem(id)`, `deadLetterInboundItem(id)`, `releaseInboundItem(id)` provide operator control.

### 5.3 Event Contract

| Event | Required correlation fields |
| --- | --- |
| `inbound.appended` | `inboundItemId`, `agentName`, `conversationId`, `sequence`, `idempotencyKey` |
| `inbound.duplicate` | `inboundItemId`, `agentName`, `conversationId`, `idempotencyKey`, current `status` |
| `inbound.leased` | `inboundItemId`, `leaseOwner`, `leaseExpiresAt` |
| `inbound.delivered` | `inboundItemId`, `turnId`, `sequence` |
| `inbound.blocked` | `inboundItemId`, `blockedBy` |
| `inbound.consumed` | `inboundItemId`, `turnId`, `commitRef` |
| `inbound.failed` | `inboundItemId`, `attempt`, `retryable`, `reason` |
| `inbound.deadLettered` | `inboundItemId`, `reason` |

---

## 6. Realization Specification

- Module Boundaries:
  - `packages/types`: durable inbound item/store/control/event types.
  - `packages/core/src/inbound`: in-memory store, scheduler, dispatch helpers, store contract tests.
  - `packages/core/src/ingress`: receive/dispatch append-first integration.
  - `packages/core/src/execution`: active Turn durable drain integration.
- Data Ownership:
  - `DurableInboundStore` owns inbound item state, idempotency, sequence, leases, and blocker references.
  - `HumanApprovalStore` or operator hold store is the canonical owner of blocker lifecycle.
  - conversation state owns message/event append. inbound item stores only commit references, not the canonical conversation log.
- Commit Reference:
  - runtime generates a deterministic commit reference before appending a user message from an inbound item: `inbound:<inboundItemId>:user-message`.
  - the user message metadata must include `__inboundItemId` and `__inboundCommitRef`.
  - conversation append logic must treat the same commit reference as idempotent. If the commit reference already exists, append is skipped and the existing message is reused.
  - `DurableInboundStore.markConsumed()` stores the same commit reference. If recovery sees an existing commit reference before `consumed`, it marks the item consumed with that reference instead of appending another message.
- State Model:
  - `pending -> leased -> delivered -> consumed`
  - `pending -> delivered -> blocked` when an active Turn pauses for a Human Approval before consuming steered durable input
  - `pending -> blocked -> consumed` for Human Approval resume drain
  - `pending -> blocked -> pending` for operator hold release
  - `leased -> pending`
  - `leased -> failed -> pending|deadLetter`
  - `blocked -> deadLetter`
  - `delivered` is not a lease state and must not be automatically released to `pending` by lease expiry. Recovery must use an explicit operator/recovery decision after determining the active Turn cannot consume it.
  - explicit `retryInboundItem()`/`releaseInboundItem()` may move `delivered -> pending` after the active Turn is known to be gone or unable to consume the item.
  - duplicate direct input must report from the existing item state: `blocked` maps to `waitingForHuman`, `consumed` maps to a cached final Turn result only when one exists, and non-terminal/failed/uncached consumed states must not be coerced to successful completion.
- Concurrency Strategy:
  - store methods are compare-and-set/transactional at item and conversation sequence boundaries.
  - scheduler may run opportunistically in request path and/or background worker, but store lease decides ownership.
- Failure Handling:
  - at-least-once delivery is the durable execution guarantee for phase 1.
  - LLM provider call resume and external tool side-effect exactly-once are outside this spec.
- Deployment Location:
  - core provides contracts and in-memory/reference implementation.
  - production persistence adapters are host/plugin responsibilities.
- Observability Plan:
  - all state transitions emit events.
  - queue depth, blocked count, retry count, dead-letter count are queryable through control API.
- Migration / Rollback:
  - durable mode is opt-in.
  - existing `steered` disposition is accepted as migration alias for canonical `delivered`.
  - if Human Approval blockers are used, durable inbound storage is required to preserve blocked envelopes and direct inputs; non-durable runtime creation must fail explicitly instead of accepting untracked Human Approval blockers.

---

## 7. Dependency Map

- Depends On: `core/conversation-state`, `core/execution-loop`, `ingress/ingress-pipeline`
- Blocks: `core/hitl` human approval blocker integration, production durable adapters
- Parallelizable With: event type expansion, in-memory store contract tests, control API typing

---

## 8. Acceptance Criteria

- Given durable inbound store가 설정되어 있다, When `ingress.receive()`가 envelope를 accept한다, Then append 성공 전에는 accepted result와 `ingress.accepted` 이벤트가 발생하지 않는다.
- Given durable inbound store가 설정되어 있다, When `ingress.dispatch()`가 envelope를 accept한다, Then append 성공 전에는 accepted result와 `ingress.accepted` 이벤트가 발생하지 않는다.
- Given durable inbound store append가 실패한다, When `receive()` 또는 durable `processTurn()`이 호출된다, Then caller는 accepted handle을 받지 않고 store 실패를 관찰한다.
- Given 같은 external id/idempotency key payload 두 개가 동시에 들어온다, When durable append가 실행된다, Then store에는 inbound item이 하나만 생성되고 두 번째 호출은 기존 item identity를 반환한다.
- Given connector가 stable external id를 제공하지 않는다, When 같은 conversation에 동일한 normalized event가 다른 `receivedAt`으로 재전달된다, Then runtime은 `receivedAt`를 fallback idempotency key에 포함하지 않고 duplicate로 처리한다.
- Given connector가 stable external id를 제공하지 않는다, When 같은 conversation에 content/properties가 다른 normalized event가 들어온다, Then runtime은 각 event를 서로 다른 fallback idempotency key로 append한다.
- Given connector가 blank external id를 제공한다, When 같은 conversation에 서로 다른 content/properties event가 들어온다, Then blank id는 missing id로 취급되어 fallback idempotency key가 사용된다.
- Given connector가 stable external id를 제공하지 않는다, When semantically identical properties/content가 object key order만 다르게 재전달된다, Then fallback idempotency key는 stable serialization으로 duplicate 처리한다.
- Given conversation에 active Turn이 있다, When 같은 conversation으로 inbound item이 append된다, Then item은 durable store에 남고 active Turn은 Step 경계에서 그 item을 user message로 반영한다.
- Given conversation에 active Turn이 있다, When 같은 conversation으로 inbound item을 deliver한다, Then runtime은 `markDelivered()` 성공 이후에만 active Turn memory steering inbox에 notify한다.
- Given active Turn delivery가 `markDelivered()` 이후 consume 전에 crash된다, When operator/recovery가 `retryInboundItem()` 또는 `releaseInboundItem()`을 호출한다, Then item은 `pending`으로 돌아가 다시 처리 가능하다.
- Given durable direct input이 active Turn에 delivered 된 뒤 consumed 된다, When 같은 idempotency key로 duplicate direct call이 들어온다, Then runtime은 cached active Turn result를 반환하고 consumed item을 aborted/error로 보고하지 않는다.
- Given conversation이 human approval로 blocked 상태다, When 같은 conversation으로 inbound event가 들어온다, Then 새 Turn은 시작되지 않고 item은 `blockedBy=humanApproval` metadata와 함께 `blocked`가 된다.
- Given human approval이 해제되고 blocked item 2개가 있다, When scheduler/resume이 실행된다, Then blocked item은 sequence order로 append되고 consumed 된다.
- Given human approval blocker가 completed 전환으로 해제되는 경계다, When 같은 conversation으로 inbound event가 들어온다, Then scheduler는 새 Turn을 시작하지 않고 준비된 continuation Turn으로 item을 deliver한다.
- Given delivered 후 Human Approval로 blocked 된 inbound item이 operator cancel로 pending release 된다, When release가 완료된다, Then stale `turnId`/`commitRef` delivery metadata는 제거된다.
- Given 두 worker가 같은 conversation pending item을 동시에 schedule한다, When 둘 다 lease를 시도한다, Then 하나만 lease를 얻고 다른 worker는 no-op/conflict result로 수렴한다.
- Given inbound item이 conversation에 이미 append되었지만 consume marking 전 crash가 발생했다, When recovery가 같은 item을 다시 처리한다, Then 같은 inbound item id의 user message가 중복 append되지 않는다.
- Given durable inbound mode가 꺼져 있다, When 기존 ingress/processTurn 테스트가 실행된다, Then 기존 started/steered 동작이 유지된다.
- Given inbound item이 `delivered` 상태다, When lease expiry recovery가 실행된다, Then item은 자동으로 `pending`이 되지 않는다.
- Given durable direct input이 duplicate이고 기존 item이 `delivered` 또는 `failed` 상태다, When `processTurn()`이 호출된다, Then runtime은 성공 완료로 보고하지 않는다.
- Given durable inbound mode가 꺼져 있고 conversation이 human approval로 blocked 상태다, When ingress event가 들어온다, Then runtime은 envelope를 drop하지 않고 명시적 오류를 반환한다.
- Given active Turn으로 delivered 된 item이 consume 되기 전에 Human Approval이 생성된다, When Turn이 waiting 상태로 전환된다, Then delivered item은 `blockedBy=humanApproval`로 재분류되어 resume drain 대상이 된다.
- Given active Turn이 no-tool-call step으로 완료되려는 순간 새 inbound item이 steered 된다, When completion boundary가 실행된다, Then item은 같은 Turn의 다음 step에서 consumed 되거나 durable retry 가능한 상태로 돌아가며 `delivered`에 stranded 되지 않는다.
- Given human approval이 operator cancel로 해제되고 blocked inbound item이 pending으로 release 된다, When cancel API가 반환된다, Then runtime은 release된 item을 scheduler에 다시 전달해 pending 상태로 방치하지 않는다.
- Given operator control 또는 Human Approval expiry가 inbound item을 dead-letter로 전환한다, When state transition이 완료된다, Then runtime은 `inbound.deadLettered` event를 `inboundItemId`와 `reason`으로 발행한다.

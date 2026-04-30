# hitl - Human-in-the-loop durable tool barrier

## 1. Outcome Statement

OpenHarness는 사람이 승인하거나 값을 보완해야 하는 tool call을 durable conversation barrier로 멈추고, human result와 barrier 중 들어온 input을 잃지 않은 채 재시작/크래시/장기 대기 이후에도 같은 batch를 기준으로 안전하게 이어간다.

## 2. Design Premises

이 스펙은 원하는 최종 계약을 정의한다. `HitlStore`와 runtime은 아래 전제를 동시에 만족해야 한다.

1. **Store is the durability boundary.** Runtime 선행 체크가 맞게 호출해주기를 기대하면 안 된다. `HitlStore` 메서드 하나하나가 atomic하고, idempotency와 conflict guard를 스스로 강제해야 한다.
2. **Batch is one LLM step barrier.** 한 step에서 HITL tool call이 하나라도 있으면 그 step의 tool call 전체가 하나의 `HitlBatch`에 속한다.
3. **HITL only stops HITL handlers.** 같은 step의 non-HITL peer tool call은 실행되고, 그 result는 batch에 durable하게 기록되어야 한다.
4. **Human submit is immediately durable.** submit 성공 응답 전에 human result는 store에 저장되어 있어야 한다. 마지막 peer submit이면 batch `ready` 전환도 같은 atomic operation에 포함된다.
5. **Accepted input under a HITL barrier must be durable.** HITL barrier 중 같은 conversation input을 accepted/started/steered로 반환하려면 durable queue에 저장되어 있어야 한다.
6. **Side effects are not replayed automatically.** tool handler 또는 continuation side effect boundary를 지난 뒤에는 startup recovery나 explicit resume이 해당 side effect를 자동 재실행하지 않는다.
7. **Lifecycle status and derived capabilities are separate.** `queueable`, `conversationBarrier`, `pendingVisible`, `autoResumable`, `recoverable`은 같은 조건으로 계산하면 안 된다.

## 3. Desired State

LLM이 한 step에서 여러 tool call을 반환했을 때, 그중 하나라도 HITL이 필요하면 runtime은 다음 상태로 수렴한다.

- HITL 대상 tool call은 handler 실행 전에 `HitlRequest`로 저장되고 `pending`으로 노출된다.
- HITL이 필요하지 않은 peer tool call은 실행되고, tool result는 `HitlBatch.toolResults`에 저장된다.
- 모든 non-HITL peer result가 저장된 뒤에만 batch는 `waitingForHuman`으로 노출된다.
- 같은 batch의 모든 HITL request가 submit되기 전에는 다음 LLM step이 실행되지 않는다.
- `waitingForHuman`, `ready`, 아직 queue가 닫히지 않은 `resuming` batch는 같은 conversation input을 durable queued steer로 받을 수 있다.
- queueable하지 않지만 conversation barrier인 상태에서는 같은 conversation input을 memory-only active turn steering이나 새 turn으로 받아들이지 않는다.
- 모든 request가 submit되면 batch는 `ready`가 되고, resume은 저장된 peer results, human results, queued steer를 사용해 continuation을 실행한다.
- continuation은 일반 turn과 같은 middleware/policy/tracing 의미를 가져야 한다. 단, resume 자체를 새 사용자 입력으로 append하지 않는다.

## 4. Scope Boundary

### 4.1 Committed Guarantees

- `batchId`, `requestId`, `queuedInputId`는 opaque generated ID다. `turnId`, `stepNumber`, `toolCallId`에서 파생하지 않는다. 권장 형식은 UUIDv4 또는 그에 준하는 충돌 가능성이 무시할 수 있는 식별자다.
- `waitingForHuman`으로 관찰되는 batch는 batch, request, non-HITL peer result가 durable store에 저장된 상태다.
- 같은 request에 대한 duplicate submit은 batch status와 무관하게 기존 request state를 반환하거나 conflict로 거절하며, 중복 mutation을 만들지 않는다.
- 같은 `(agentName, conversationId)`에 conversation barrier batch가 있으면 새 batch 생성은 store level에서 conflict가 되어야 한다.
- queueable 여부는 steer queue 수용만 결정한다. queue가 닫혔다고 conversation barrier가 사라지면 안 된다.
- direct `processTurn()`과 ingress dispatch 모두 HITL barrier를 같은 규칙으로 처리한다.
- runtime 재시작 후 `waitingForHuman`, `ready`, side-effect boundary 이전의 retryable resume 상태는 조회 또는 재개 가능해야 한다.
- `preparing` recovery는 durable records만 보고 수렴해야 하며 tool handler를 호출하면 안 된다.
- `commitBatchAppend()` 이후 continuation이 시작됐거나 시작될 수 있으면 automatic resume retry 대상에서 제외된다.

### 4.2 Explicit Non-goals

- OpenHarness core는 외부 tool handler side effect의 exactly-once 실행을 보장하지 않는다.
- handler가 시작된 뒤 프로세스가 죽은 경우 core는 해당 handler를 자동 재실행하지 않는다.
- continuation turn이 시작된 뒤 프로세스가 죽은 경우 core는 해당 continuation을 자동 재실행하지 않는다.
- `HitlStore` 메서드 내부 partial write를 runtime이 복구하지 않는다. store adapter는 각 메서드를 atomic하게 구현해야 한다.
- in-memory `HitlStore`는 프로세스 크래시 후 durability를 보장하지 않는다.
- 여러 runtime/process가 같은 durable store를 공유하는 환경의 완전한 분산 fencing은 durable adapter 책임이다. Core 계약은 adapter가 제공해야 할 atomic/lease semantics를 정의한다.
- TTL, reminder, escalation, approval UI, CLI UX는 core durable HITL 계약 밖의 확장 영역이다.

## 5. Glossary

| Term | Definition |
| --- | --- |
| HITL | Human In The Loop. 도구 실행 전 사람의 승인, 거절, 텍스트, form 입력을 요구하는 흐름 |
| HitlBatch | 한 LLM step의 tool call 전체를 묶는 durable barrier |
| HitlRequest | batch 안의 HITL 대상 tool call 하나에 대한 approval/input record |
| Human Result | 사람이 제출한 approve/reject/text/form payload |
| Queued Steer | queueable HITL barrier 중 같은 conversation으로 들어와 **durable HITL queue**에 저장된 입력. 아래 Active-turn Steer와 별개 개념 |
| Active-turn Steer | 진행 중인 turn의 in-flight context로 input을 흘려 넣는 메커니즘. durable HITL queue 밖에 존재하며, `continuing` batch에 active continuation turn이 살아 있을 때만 §8.4 step 8 예외로 허용된다 |
| Resume | `ready` batch, pre-side-effect-boundary `resuming` batch, 또는 `failed(retryable)` batch를 복원해 tool results와 queued steer를 append하고 continuation을 실행하는 행위 |
| Conversation Barrier | 같은 `(agentName, conversationId)`에서 **새 turn** 또는 **새 HITL batch** 생성을 막는 batch. 기존 active turn으로의 active-turn steering은 차단하지 않는다 |
| Queueable | 같은 conversation input을 durable queued steer로 받을 수 있는 상태 |
| Atomic Store Method | 성공하면 관련 상태가 모두 반영되고, 실패하면 호출 전 상태로 남는 `HitlStore` 메서드 |
| Side-effect Boundary | tool handler 또는 continuation처럼 automatic replay가 안전하지 않은 외부 효과가 시작되는 경계 |
| `failed(retryable)` / `failed(nonRetryable)` | derived 표기. 실제 enum 값은 단일 `failed`이며, 분기는 `HitlFailure.retryable: boolean` 별도 필드로 표현한다 (§9.4 참조) |

## 6. Requirements

### 6.1 Functional Requirements

| ID | Level | Requirement |
| --- | --- | --- |
| FR-HITL-001 | Committed | `ToolDefinition`은 선택적으로 HITL policy를 선언할 수 있어야 한다. |
| FR-HITL-002 | Committed | HITL 대상 tool call은 handler 실행 전에 `HitlRequest`로 durable 저장되어야 한다. |
| FR-HITL-003 | Committed | 한 step의 여러 HITL tool call은 하나의 batch 안에 여러 request로 저장되어야 한다. |
| FR-HITL-004 | Committed | 같은 step의 non-HITL peer tool call은 실행되고 그 결과가 batch record에 저장되어야 한다. |
| FR-HITL-005 | Committed | batch의 모든 HITL request가 submit되기 전에는 continuation이 실행되면 안 된다. |
| FR-HITL-006 | Committed | pending batch/request 조회 API를 제공해야 한다. |
| FR-HITL-007 | Committed | human result submit API를 제공해야 한다. |
| FR-HITL-008 | Committed | approve/text/form result는 handler 실행에 필요한 final args를 만들 수 있어야 한다. 기본 매핑은 result payload를 final args에 반영하고, `HitlPolicy.mapResult`가 정의되면 그 결과로 override된다. |
| FR-HITL-009 | Committed | reject result는 handler 호출 없이 rejection tool result로 완료되어야 한다. |
| FR-HITL-010 | Committed | queueable HITL barrier 중 ingress/direct input은 durable queue에 저장되어야 한다. |
| FR-HITL-011 | Committed | resume은 tool-result messages를 append한 뒤 queued steer를 append하고 그 다음 continuation을 실행해야 한다. |
| FR-HITL-012 | Committed | runtime 재시작 후 pending/ready/retryable pre-side-effect batch를 조회 또는 재개할 수 있어야 한다. |
| FR-HITL-013 | Committed | HITL lifecycle은 runtime event로 관찰 가능해야 한다. |
| FR-HITL-014 | Committed | queueable하지 않은 conversation barrier에서는 같은 conversation input을 accepted/started로 반환하거나 durable HITL queued steer로 받아들이면 안 된다. (`continuing` batch에 active continuation turn이 살아 있는 동안의 active-turn steering은 §8.4 step 8 예외로 허용된다.) |
| FR-HITL-015 | Committed | side-effect boundary 이후 실패/크래시는 automatic retry가 아니라 blocked 또는 terminal failure로 수렴해야 한다. |
| FR-HITL-016 | Committed | continuation은 일반 turn과 동일한 turn/step middleware 의미를 가져야 한다. |
| FR-HITL-017 | Planned | TTL, reminder, cancel policy는 extension으로 추가 가능해야 한다. |

### 6.2 Non-functional Requirements

| ID | Level | Requirement |
| --- | --- | --- |
| NFR-HITL-001 | Committed | Durable-before-observable: pending event와 waiting result는 durable store write 이후에만 발행된다. |
| NFR-HITL-002 | Committed | Submit idempotency: duplicate submit은 중복 mutation을 만들지 않고 기존 request state로 수렴한다. |
| NFR-HITL-003 | Committed | Open-batch uniqueness: conversation barrier uniqueness는 store adapter가 atomic하게 보장한다. |
| NFR-HITL-004 | Committed | Predicate separation: `queueable`, `conversationBarrier`, `autoResumable`은 독립 predicate로 정의되고 테스트된다. |
| NFR-HITL-005 | Committed | Ordering: batch tool results와 queued steer는 deterministic order로 continuation에 반영된다. |
| NFR-HITL-006 | Committed | Compatibility: HITL 미사용 tool flow는 기존 동작을 유지한다. |
| NFR-HITL-007 | Committed | Scope safety: submit은 request identity와 optional `agentName`/`conversationId` guard를 검증한다. |
| NFR-HITL-008 | Committed | No automatic side-effect replay: handler/continuation side effect가 시작된 뒤에는 startup recovery나 explicit resume이 자동 재실행하지 않는다. |

## 7. State And Capability Model

### 7.1 HitlBatch Lifecycle

`failed(retryable)` / `failed(nonRetryable)`는 derived 표기다. 실제 `HitlBatchStatus` enum 값은 단일 `failed`이며, retryable 분기는 `HitlFailure.retryable: boolean` 필드로 결정된다.

```text
preparing
  -> waitingForHuman
  -> ready
  -> resuming
  -> continuing
  -> completed

preparing -> canceled | failed(nonRetryable) | blocked
waitingForHuman -> canceled | expired
ready -> failed(retryable) | canceled
resuming -> failed(retryable) | failed(nonRetryable) | blocked
continuing -> completed | blocked | failed(nonRetryable) | canceled
failed(retryable) -> resuming | blocked | canceled
blocked -> canceled
```

| Status | Meaning |
| --- | --- |
| `preparing` | batch/request는 생성됐지만 pending으로 노출할 안정 지점은 아직 아님 |
| `waitingForHuman` | pending request가 UI/API에 노출되고 submit 가능함 |
| `ready` | 모든 request가 submit되어 resume 가능함 |
| `resuming` | final tool result set 생성, queued steer drain, append commit이 진행 중임 |
| `continuing` | append commit이 완료되어 continuation side-effect boundary를 넘었거나 넘을 수 있음 |
| `completed` | continuation이 successful terminal state로 settle됨 |
| `failed(retryable)` | side-effect boundary 이전 transient failure로 automatic resume 가능함 |
| `failed(nonRetryable)` | safe-closed failure. 자동 재시도하지 않으며 conversation barrier가 아님 |
| `blocked` | side-effect boundary 이후 또는 conversation을 안전하게 이어갈 수 없는 상태. operator action 전까지 barrier임 |
| `canceled`/`expired` | 운영 정책으로 닫힌 terminal 상태 |

### 7.2 Derived Capability Matrix

이 표가 상태 해석의 canonical contract다. 구현 helper는 이 표를 그대로 반영해야 한다.

| Batch state | Conversation barrier | Queueable steer | Pending visible | Auto resumable | Startup recovery behavior |
| --- | --- | --- | --- | --- | --- |
| `preparing` | Yes | No | No | No | durable peer records만 보고 `waitingForHuman`, `canceled`, `failed(nonRetryable)`, `blocked` 중 하나로 수렴 |
| `waitingForHuman` | Yes | Yes | Yes | No | pending으로 노출하고 submit/queue를 받음 |
| `ready` | Yes | Yes | No | Yes | resume schedule 가능. queue close는 `resuming` 진입 시점에 일어난다 |
| `resuming` before queue close | Yes | Yes | No | Lease 만료 후 Yes | 같은 resume를 재시도 가능 |
| `resuming` after queue close | Yes | No | No | Lease 만료 후 Yes, if before side-effect boundary | queued/draining steer를 보존하고 같은 drain set으로 재시도 |
| `failed(retryable)` | Yes | No | No | Yes | side-effect boundary 이전 실패로 간주하고 resume 가능 |
| `continuing` | Yes | No | No | No | 자동 resume하지 않음. active continuation turn이 살아있으면 일반 active-turn steering만 허용(durable HITL queued steer 아님). active turn이 없으면 input은 rejected/error |
| `blocked` | Yes | No | No | No | operator recovery/cancel 대상 |
| `failed(nonRetryable)` | No | No | No | No | terminal failure로 조회 가능하지만 새 turn/batch를 막지 않음 |
| `completed`/`canceled`/`expired` | No | No | No | No | terminal |

Rules:

- `steerQueueClosedAt` 또는 equivalent metadata는 **queueable**만 닫는다. conversation barrier 여부를 바꾸면 안 된다.
- `getOpenBatchByConversation()`처럼 steer queue lookup에 쓰는 API는 queueable batch만 반환할 수 있다.
- `createBatch()` conflict guard는 queueable lookup이 아니라 conversation barrier predicate를 사용해야 한다.
- `listPending*()`은 `waitingForHuman`과 `pending` request만 반환한다.
- `listRecoverable*()` 또는 recovery scan은 pending-visible 상태뿐 아니라 `preparing`, `ready`, `resuming`, `failed(retryable)`, `continuing`, `blocked`을 관찰할 수 있어야 한다. 단, 관찰과 automatic resume은 다르다.
- side-effect boundary 이후 자동 재실행이 안전하지 않은 실패는 `failed(retryable)`로 남으면 안 된다. `blocked` 또는 `failed(nonRetryable)`로 수렴해야 한다. conversation을 안전하게 이어갈 수 없으면 `blocked`를 사용한다.
- Conversation barrier는 **새 turn 생성**과 **새 HITL batch 생성**을 차단한다. 기존 active turn에 대한 active-turn steering은 conversation barrier와 별개 메커니즘이며, §8.4 step 8 예외 외에는 사용되지 않는다.

### 7.3 HitlRequest Lifecycle

`failed(retryable)` / `failed(nonRetryable)` 표기 규약은 §7.1과 동일하다. enum 값은 단일 `failed`, 분기는 `HitlFailure.retryable`.

```text
pending -> resolved -> completed
pending -> rejected -> completed
pending -> canceled | expired
resolved/rejected -> failed(retryable) | failed(nonRetryable) | blocked | canceled
```

| Status | Meaning |
| --- | --- |
| `pending` | human result 대기 |
| `resolved` | approve/text/form result 저장됨 |
| `rejected` | reject result 저장됨 |
| `completed` | batch resume에서 final tool result가 반영됨 |
| `failed(retryable)` | side-effect boundary 전 request completion retry 가능 |
| `failed(nonRetryable)` | 자동 재시도하지 않는 request failure |
| `blocked` | handler side effect 이후 자동 재시도 불가 |

Request result mutation rules:

- `pending` request만 새 human result를 받을 수 있다.
- 이미 `resolved`, `rejected`, `completed`, `failed`, `blocked`, `canceled`, `expired`인 request에 같은 submit이 재시도되면 store는 batch status보다 먼저 duplicate 여부를 판단한다.
- 같은 idempotency key가 같은 request에 이미 적용된 경우 기존 request를 반환한다.
- 같은 request에 이미 human result가 있고 payload가 동일하면 기존 request를 반환한다.
- 같은 request에 서로 다른 human result를 제출하면 conflict/invalid/error로 거절하고 기존 result를 바꾸지 않는다.
- 같은 idempotency key가 다른 request에 사용되면 conflict/invalid/error로 거절한다.

## 8. Behavior Specification

### 8.1 Flow: HITL batch creation

**ID:** `HITL-BATCH-01`

**Trigger:** LLM step response가 하나 이상의 tool call을 포함한다.

**Main Flow:**

1. Runtime은 step의 모든 tool call에 대해 HITL policy를 평가한다.
2. HITL 대상 tool call이 없으면 기존 tool execution flow를 그대로 사용한다.
3. HITL 대상 tool call이 하나 이상 있으면 runtime은 opaque `batchId`와 request별 opaque `requestId`를 생성한다.
4. Runtime은 `HitlStore.createBatch()`로 batch와 request들을 atomic하게 저장한다.
5. `createBatch()`는 같은 conversation에 conversation barrier batch가 있으면 `conflict`를 반환한다.
6. Runtime은 같은 step의 non-HITL peer tool call을 실행하고 result를 `recordBatchToolResult()`로 저장한다.
7. 모든 non-HITL peer result가 저장되면 runtime은 `markBatchWaitingForHuman()`으로 batch를 `waitingForHuman`에 수렴시킨다.
8. Durable store가 `waitingForHuman`을 반환한 뒤에만 `hitl.batch.requested`, `hitl.requested`, turn `waitingForHuman` 결과를 관찰 가능하게 한다.

**Failure Handling:**

- `createBatch()` 실패 시 어떤 peer tool handler도 호출하지 않는다.
- non-HITL peer handler 시작 전 실패는 batch를 safe-closed failure로 닫을 수 있다.
- non-HITL peer handler 시작 후 result 저장 전 실패/크래시는 자동 handler 재실행 대상이 아니다.
- `preparing` recovery는 execution marker와 recorded result만 보고 수렴한다.
- `preparing`은 conversation barrier이지만 queueable이 아니므로 같은 conversation input을 accepted/steered/started로 반환하지 않는다.

### 8.2 Flow: pending HITL query

**ID:** `HITL-LIST-01`

**Trigger:** host/UI/connector가 pending HITL을 조회한다.

**Main Flow:**

1. Runtime은 filter를 검증한다.
2. Runtime은 `waitingForHuman` batch와 `pending` request를 store에서 조회한다.
3. Runtime은 request별 prompt, response schema, current status, batch identity를 반환한다.

**Guarantee:**

- `preparing`, `ready`, `resuming`, `continuing`, `blocked`, `failed` batch는 pending approval list에 섞이지 않는다.
- operator/debug API는 별도로 non-pending batch를 조회할 수 있지만, pending submit UI는 `waitingForHuman`만 submit 대상으로 취급한다.

### 8.3 Flow: human result submit

**ID:** `HITL-SUBMIT-01`

**Trigger:** `submitHitlResult(input)`

**Main Flow:**

1. Runtime은 request를 조회하고 optional `agentName`/`conversationId` guard를 검증한다.
2. Runtime은 새 `pending` request에 대해서만 result payload를 response schema에 맞게 검증한다.
3. Runtime은 result 종류에 따라 `HitlStore.resolveRequest()` 또는 `HitlStore.rejectRequest()`를 호출한다.
4. Store는 duplicate submit을 batch status check보다 먼저 처리한다.
5. Store는 request result 저장, duplicate/idempotency key 기록, 남은 pending peer 계산, 마지막 peer인 경우 batch `ready` 전환을 하나의 atomic operation으로 처리한다.
6. Runtime은 저장 결과에 따라 `hitl.resolved`, `hitl.rejected`, `hitl.batch.ready` 이벤트를 발행한다.
7. Batch가 `ready`이면 runtime은 resume task를 schedule할 수 있다.

**Failure Handling:**

- validation/scope 실패는 durable state를 바꾸지 않는다.
- store write 실패는 durable state를 바꾸지 않은 것으로 간주한다.
- `request resolved/rejected but batch not ready` 같은 partial state는 정상 runtime contract가 아니라 `HitlStore` atomicity 위반이다.
- 마지막 peer submit 이후 batch가 `ready`, `resuming`, `continuing`, `completed`, `blocked`, `failed`가 되었더라도 같은 submit retry는 기존 request state로 수렴해야 한다.

### 8.4 Flow: pending HITL 중 steer/ingress

**ID:** `HITL-STEER-01`

**Trigger:** HITL conversation barrier가 있는 conversation으로 input이 들어온다.

**Main Flow:**

1. Runtime/ingress는 먼저 해당 conversation의 queueable batch를 조회한다.
2. Queueable batch가 있으면 새 turn을 시작하지 않고 `enqueueSteer()`로 input을 durable queue에 저장한다.
3. 저장 성공 후에만 `queuedForHitl` 또는 equivalent queued result를 반환한다.
4. Queueable batch가 없지만 conversation barrier가 있으면 input을 rejected/error로 반환한다.
5. Barrier가 없으면 기존 dispatch 또는 active-turn steering 규칙을 사용한다.
6. Active turn으로 steering된 input이 같은 step에서 새 HITL batch 때문에 아직 append되지 못한 경우, turn이 `waitingForHuman`으로 settle하기 전에 해당 input은 batch queued steer로 durable flush되어야 한다.
7. Flush가 실패하면 해당 input을 accepted/steered로 성공 처리하면 안 된다.
8. `continuing` batch에 active continuation turn이 살아 있으면 runtime은 기존 active-turn steering을 사용할 수 있다. 이것은 durable HITL queued steer가 아니다.
9. `continuing` batch에 active continuation turn이 없으면 input을 rejected/error로 반환한다.

**Guarantee:**

- HITL barrier가 있는 conversation에서 새 LLM step이 몰래 시작되면 안 된다.
- Queue 저장 실패가 normal steer 또는 new turn fallback으로 바뀌면 안 된다.
- `preparing`, `blocked`, `failed(retryable)`, queue-closed `resuming`은 conversation barrier이지만 queueable은 아니다.
- `steerQueueClosedAt`은 queueable을 닫을 뿐 open-batch conflict를 풀지 않는다.

### 8.5 Flow: HITL batch resume

**ID:** `HITL-RESUME-01`

**Trigger:** 마지막 submit 직후 schedule, explicit `resumeHitlBatch(batchId)`, 또는 startup recovery.

**Preconditions:**

- batch status가 `ready`, pre-side-effect `resuming`, 또는 `failed(retryable)`이다.
- 모든 HITL request가 `resolved` 또는 `rejected`다.
- non-HITL peer tool result가 batch record에 저장되어 있다.
- batch lease를 획득했다.

**Main Flow:**

1. Runtime/store는 batch를 `resuming`으로 전환하고 lease guard를 획득한다.
2. Runtime은 `toolCallIndex` 순서로 final tool result set을 만든다.
3. Non-HITL peer tool call은 저장된 result를 사용한다.
4. Rejected HITL request는 handler를 호출하지 않고 rejection tool result를 만든다.
5. Approved/text/form HITL request는 final args를 만든 뒤 handler를 실행한다.
6. Handler 실행 전에 `startRequestExecution()` 또는 equivalent side-effect marker를 durable하게 기록한다.
7. Handler 결과 저장과 request completion은 `completeRequestWithToolResult()` 하나로 atomic하게 처리한다.
8. 모든 result가 준비되면 runtime은 queued steer drain set을 확정한다. 이 시점이 §7.2의 'queue close' 시점이며, 이후 들어오는 input은 더 이상 같은 batch의 queued steer로 받아들여지지 않는다.
9. Runtime은 tool-result messages를 append하고, queued steer messages를 그 뒤에 append한다.
10. Runtime은 `commitBatchAppend()`로 appended result IDs, queued steer IDs, continuation turn ID를 atomic commit한다.
11. `commitBatchAppend()` 성공 직후 batch는 `continuing`으로 전환되고 automatic resume retry 대상에서 제외된다.
12. Runtime은 continuation을 실행한다. Continuation은 일반 turn middleware 의미를 유지하되 resume 자체를 새 user input으로 append하지 않는다.
13. Continuation이 successful terminal state로 settle되면 `completeBatch()`를 호출한다.
14. Continuation이 error/abort이거나 `completeBatch()`가 실패하면 batch는 `blocked` 또는 non-retryable failure로 수렴한다. continuation은 자동 재실행하지 않는다. 수렴을 처리하는 `failBatch()`/`completeBatch()` 호출 자체가 실패하면 batch는 일시적으로 `continuing` 상태로 stuck될 수 있다. 이 경우 startup recovery는 `continuing` batch를 자동 resume하지 않지만, durable continuation outcome marker(success/abort/error)를 보고 같은 분류로 close 시도를 재수행할 수 있다.

**Failure Handling:**

- rejected request처럼 handler side effect가 시작되지 않은 경로의 transient persistence failure는 automatic retry 가능하다.
- validation/config/mapResult 실패가 handler 시작 전이면 safe-closed non-retryable failure로 닫을 수 있다.
- handler side effect marker가 기록된 뒤에는 handler를 automatic retry로 다시 호출하지 않는다.
- handler가 result를 반환했지만 `completeRequestWithToolResult()`가 실패한 경우도 handler side effect가 시작된 것으로 간주한다. 자동 handler 재실행 대상이 아니다.
- `commitBatchAppend()` 실패 시 accepted queued steer는 삭제되거나 drained로 숨겨지면 안 된다. retry 시 같은 queued/draining steer set을 다시 반영할 수 있어야 한다.
- `commitBatchAppend()` 이후 실패는 continuation side-effect boundary 이후 실패로 취급한다.

### 8.6 Flow: startup recovery

**ID:** `HITL-RECOVER-01`

**Trigger:** durable HITL store가 configured된 runtime 생성.

**Main Flow:**

1. Runtime은 recoverable/observable batch를 조회한다.
2. `waitingForHuman` batch는 pending query와 queueable steer 대상으로 노출한다.
3. `ready` batch는 resume task로 schedule할 수 있다.
4. `resuming` 또는 `failed(retryable)` batch는 side-effect boundary 이전이라는 durable evidence가 있을 때만 resume task로 schedule할 수 있다.
5. `preparing` batch는 어떤 tool handler도 자동 실행하지 않고 durable records만으로 수렴시킨다.
6. `preparing` batch에 필요한 non-HITL peer results가 모두 있으면 `waitingForHuman`으로 수렴시킬 수 있다.
7. `preparing` batch에 execution marker가 있지만 result가 없으면 `blocked` 또는 safe-closed non-retryable failure로 수렴한다.
8. `preparing` batch에 execution marker/result가 없으면 unexposed incomplete batch로 cancel할 수 있다.
9. `continuing` batch는 자동 resume하지 않는다.
10. `blocked` batch는 자동 resume하지 않고 conversation barrier로 남긴다.

**Guarantee:**

- startup recovery는 pending human result와 queued/draining steer를 잃지 않는다.
- startup recovery는 external handler 또는 continuation을 자동 재실행하지 않는다.
- startup recovery는 recorded non-HITL peer result를 버리고 같은 side effect를 다시 유도하면 안 된다.
- queue-closed retryable batch도 conversation barrier로 남아야 한다.

## 9. Interface Specification

### 9.1 ToolDefinition extension

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  hitl?: HitlPolicy;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}
```

### 9.2 Runtime control API

```ts
interface ControlApi {
  listPendingHitl(filter?: HitlRequestFilter): Promise<HitlRequestView[]>;
  listPendingHitlBatches(filter?: HitlBatchFilter): Promise<HitlBatchView[]>;
  getHitlBatch(batchId: string): Promise<HitlBatchView | null>;
  getHitlRequest(requestId: string): Promise<HitlRequestView | null>;
  submitHitlResult(input: SubmitHitlResultInput): Promise<SubmitHitlResult>;
  resumeHitlBatch(batchId: string): Promise<ResumeHitlResult>;
  resumeHitl(requestId: string): Promise<ResumeHitlResult>;
  cancelHitlBatch(input: CancelHitlBatchInput): Promise<CancelHitlResult>;
  cancelHitl(input: CancelHitlInput): Promise<CancelHitlResult>;
}
```

`resumeHitlBatch(batchId)`가 canonical resume API다. 이 API는 idempotent해야 한다. 다른 owner가 batch lease를 보유 중이거나 batch가 이미 `continuing`/`completed`/`canceled`/`expired`/`failed(nonRetryable)`/`blocked` 같은 terminal 또는 post-side-effect 상태이면, 호출은 mutation 없이 현재 상태를 `ResumeHitlResult`로 반환한다. `resumeHitl(requestId)`는 request의 owning batch를 찾는 helper다. owning batch가 resume 가능한 상태가 아니면 `resumeHitlBatch`와 동일한 idempotent semantics를 따른다.

### 9.3 Human result

```ts
interface SubmitHitlResultInput {
  requestId: string;
  result: HitlHumanResult;
  idempotencyKey?: string;
  agentName?: string;
  conversationId?: string;
}

type HitlHumanResult =
  | { kind: "approve"; value?: boolean | string | JsonObject; submittedBy?: string; submittedAt?: string; comment?: string }
  | { kind: "reject"; reason?: string; submittedBy?: string; submittedAt?: string; comment?: string }
  | { kind: "text"; value: string; submittedBy?: string; submittedAt?: string; comment?: string }
  | { kind: "form"; value: JsonObject; submittedBy?: string; submittedAt?: string; comment?: string };

type HitlResponseSchema =
  | { type: "approval" }
  | { type: "text"; schema?: JsonSchema; minLength?: number; maxLength?: number }
  | { type: "form"; schema: JsonSchema };
```

> **Backward-compat input shape.** 정식 input shape는 위의 `kind` 형태 (`{ kind: "approve" | "reject" | "text" | "form", ... }`) 다. 구현체는 backward-compat을 위해 `{ decision: "approve" | "reject", value? | reason?, ... }` legacy shape를 동일 의미로 받아들일 수 있다 (runtime이 내부에서 `kind` 형태로 정규화한다). 새 host/connector/UI는 `kind` 형태만 사용해야 하며, 두 shape를 동시에 보내거나 섞어 쓰면 안 된다.

### 9.4 HitlStore contract

`HitlStore`는 runtime이 의존하는 durability boundary다. 아래 메서드 하나하나는 atomic해야 한다.

```ts
interface HitlStore {
  createBatch(input: {
    batch: HitlBatchRecord;
    requests: HitlRequestRecord[];
  }): Promise<CreateHitlBatchResult>;

  getBatch(batchId: string): Promise<HitlBatchRecord | null>;
  getRequest(requestId: string): Promise<HitlRequestRecord | null>;
  listPendingBatches(filter?: HitlBatchFilter): Promise<HitlBatchRecord[]>;
  listPendingRequests(filter?: HitlRequestFilter): Promise<HitlRequestRecord[]>;
  listBatchRequests(batchId: string): Promise<HitlRequestRecord[]>;
  listBatchToolResults(batchId: string): Promise<HitlBatchToolResult[]>;
  listRecoverableBatches(filter?: HitlBatchFilter): Promise<HitlBatchRecord[]>;
  getOpenBatchByConversation(agentName: string, conversationId: string): Promise<HitlBatchRecord | null>;

  startBatchToolExecution(batchId: string, marker: HitlBatchToolExecutionMarker): Promise<HitlBatchRecord>;
  recordBatchToolResult(batchId: string, result: HitlBatchToolResult): Promise<HitlBatchRecord>;
  markBatchWaitingForHuman(batchId: string): Promise<HitlBatchRecord>;

  resolveRequest(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord>;
  rejectRequest(requestId: string, result: HitlHumanResult, idempotencyKey?: string): Promise<HitlRequestRecord>;

  enqueueSteer(batchId: string, input: HitlQueuedSteerInput): Promise<HitlQueuedSteer>;
  drainQueuedSteers(batchId: string, guard: HitlLeaseGuard): Promise<HitlQueuedSteer[]>;
  listQueuedSteers(batchId: string): Promise<HitlQueuedSteer[]>;

  acquireBatchLease(batchId: string, ownerId: string, ttlMs: number): Promise<HitlBatchLeaseResult>;
  startRequestExecution(requestId: string, guard: HitlLeaseGuard, startedAt: string): Promise<HitlRequestRecord>;
  completeRequestWithToolResult(input: {
    batchId: string;
    requestId: string;
    toolResult: HitlBatchToolResult;
    completion: HitlCompletion;
    guard: HitlLeaseGuard;
  }): Promise<{ batch: HitlBatchRecord; request: HitlRequestRecord }>;
  completeRequest(requestId: string, completion: HitlCompletion, guard: HitlLeaseGuard): Promise<HitlRequestRecord>;
  failRequest(requestId: string, failure: HitlFailure, guard: HitlLeaseGuard): Promise<HitlRequestRecord>;
  commitBatchAppend(batchId: string, appendCommit: HitlBatchAppendCommit, guard: HitlLeaseGuard): Promise<HitlBatchRecord>;
  completeBatch(batchId: string, completion: HitlBatchCompletion, guard: HitlLeaseGuard): Promise<HitlBatchRecord>;
  failBatch(batchId: string, failure: HitlFailure, guard?: HitlLeaseGuard): Promise<HitlBatchRecord>;
  cancelBatch(batchId: string, reason?: string): Promise<HitlBatchRecord>;
  releaseBatchLease(batchId: string, guard: HitlLeaseGuard): Promise<void>;
}
```

Required store semantics:

- `createBatch()`는 같은 `(agentName, conversationId)`에 conversation barrier batch가 있으면 `conflict`를 반환해야 한다.
- `getOpenBatchByConversation()`은 queueable steer 대상만 반환한다. 이름이 open이어도 create conflict predicate와 같으면 안 된다.
- `preparing` batch는 create conflict 대상이지만 queueable lookup 결과에는 포함하지 않는다.
- queue-closed `resuming` 또는 `failed(retryable)` batch는 queueable이 아니어도 create conflict 대상이다.
- `markBatchWaitingForHuman()`은 batch/request와 필요한 non-HITL peer results가 저장된 경우에만 성공한다.
- `resolveRequest()`/`rejectRequest()`는 duplicate submit 처리, request result 저장, batch ready 전환을 같은 atomic operation으로 처리한다.
- `resolveRequest()`/`rejectRequest()`는 request가 이미 submitted/completed/failed/blocked인 경우 batch status보다 먼저 idempotency/duplicate 여부를 판단한다.
- `completeRequestWithToolResult()`는 HITL handler result 저장과 request completion을 같은 atomic operation으로 처리한다.
- `commitBatchAppend()`는 appended tool-result IDs, queued steer IDs, continuation turn ID를 함께 commit한다.
- `commitBatchAppend()` 실패 전까지 queued/draining steer는 retry 가능한 상태로 남아야 한다.
- `commitBatchAppend()` 성공 후 batch는 automatic resume retry 대상이 아니다.
- `completeBatch()`는 continuation이 successful terminal state일 때만 허용한다.

#### 9.4.1 Supporting types

`HitlStore`와 Runtime control API에 등장하는 보조 타입은 아래 형태를 갖는다. adapter 구현자는 이 형태를 만족해야 하며, 추가 metadata 필드는 자유롭게 보유할 수 있다.

**Lease & guard**

```ts
interface HitlLease {
  ownerId: string;
  token: string;            // fencing token, monotonic per (batchId, owner)
  expiresAt: string;
}

interface HitlLeaseGuard {
  ownerId: string;
  token: string;            // matches HitlLease.token
}

type HitlBatchLeaseResult =
  | { status: "acquired"; guard: HitlLeaseGuard; batch: HitlBatchRecord }
  | { status: "busy"; batch: HitlBatchRecord | null };
```

`token`은 `acquireBatchLease()`가 발급하고 모든 mutation 메서드에 `HitlLeaseGuard`로 전달된다. store는 stale guard 거부에 이 token을 fencing token으로 사용해야 한다.

**Tool call/result records**

```ts
interface HitlBatchToolCallSnapshot {
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  toolArgs: JsonObject;
  requiresHitl: boolean;
  requestId?: string;       // present iff requiresHitl
}

interface HitlBatchToolExecutionMarker {
  batchId?: string;
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  requestId?: string;       // present iff this marker belongs to a HITL request
  startedAt: string;
}

interface HitlBatchToolResult {
  batchId: string;
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  result: ToolResult;
  finalArgs?: JsonObject;
  recordedAt: string;
}
```

`HitlBatchToolExecutionMarker`/`HitlBatchToolResult`는 startup recovery에서 `preparing` 수렴 분기를 결정한다 (§8.6 step 6~8 참조).

**Append commit & completion**

```ts
interface HitlBatchAppendCommit {
  committedAt: string;
  toolResultEventIds: string[];
  queuedSteerEventIds: string[];
  queuedSteerIds: string[];
  continuationTurnId: string;
  conversationEvents?: MessageEvent[];
}

interface HitlCompletion {
  toolResult: ToolResult;
  finalArgs?: JsonObject;
  completedAt: string;
}

interface HitlBatchCompletion {
  completedAt: string;
  continuationTurnId: string;
  continuationStatus: "completed" | "maxStepsReached" | "waitingForHuman";
}
```

`HitlBatchCompletion.continuationStatus`는 continuation이 도달한 자연 종착점이다. `waitingForHuman`은 continuation 안에서 새 HITL barrier가 생긴 경우(체인된 HITL)를 가리킨다.

**Failure**

```ts
interface HitlFailure {
  error: string;
  retryable: boolean;       // §7.1의 failed(retryable)/failed(nonRetryable) 분기를 결정
  failedAt: string;
}
```

**Queued steer**

```ts
interface HitlQueuedSteerInput {
  source: "ingress" | "dispatch";   // "dispatch" = direct processTurn() 입력
  envelope: InboundEnvelope;
  receivedAt: string;
  metadata?: Record<string, JsonValue>;
}

interface HitlQueuedSteer extends HitlQueuedSteerInput {
  queuedInputId: string;
  batchId: string;
  status: "queued" | "draining" | "drained" | "canceled";
}
```

**Filters & views**

```ts
interface HitlBatchFilter {
  agentName?: string;
  conversationId?: string;
  status?: HitlBatchStatus | HitlBatchStatus[];
}

interface HitlRequestFilter {
  agentName?: string;
  conversationId?: string;
  batchId?: string;
  status?: HitlRequestStatus | HitlRequestStatus[];
}

type HitlRequestView = HitlRequestRecord & {
  hasConversationSnapshot?: boolean;
};

interface HitlBatchView extends HitlBatchRecord {
  requests: HitlRequestView[];
  queuedSteerCount: number;
}
```

**Result envelopes for control API**

```ts
type CreateHitlBatchResult =
  | { status: "created"; batch: HitlBatchRecord; requests: HitlRequestRecord[] }
  | { status: "conflict"; openBatch: HitlBatchRecord };

type HitlSubmitResume =
  | { status: "waitingForPeers"; batchId: string; pendingRequestIds: string[] }
  | { status: "scheduled"; batchId: string; requestIds: string[] }
  | { status: "error"; batchId?: string; requestId: string; error: string };

type SubmitHitlResult =
  | { status: "accepted"; request: HitlRequestView; resume: HitlSubmitResume }
  | { status: "duplicate"; request: HitlRequestView; resume?: HitlSubmitResume }
  | { status: "notFound"; requestId: string }
  | { status: "invalid"; requestId: string; error: string }
  | { status: "error"; requestId: string; request?: HitlRequestView; error: string };

type ResumeHitlResult =
  | { status: "completed"; batch: HitlBatchView; result?: ToolResult }
  | { status: "scheduled"; batchId: string }
  | { status: "alreadyCompleted"; batch: HitlBatchView }
  | { status: "notReady"; batch: HitlBatchView; pendingRequestIds: string[] }
  | { status: "notFound"; batchId?: string; requestId?: string }
  | { status: "leaseConflict"; batch: HitlBatchView | null }
  | { status: "failed"; batch: HitlBatchView; error: string }
  | { status: "error"; batchId?: string; requestId?: string; batch?: HitlBatchView; error: string };

interface CancelHitlBatchInput { batchId: string; reason?: string }
interface CancelHitlInput      { requestId: string; reason?: string }

type CancelHitlResult =
  | { status: "canceled"; batch: HitlBatchView }
  | { status: "notFound"; batchId?: string; requestId?: string }
  | { status: "notCancelable"; batch: HitlBatchView }
  | { status: "error"; batchId?: string; requestId?: string; batch?: HitlBatchView; error: string };
```

`ResumeHitlResult.leaseConflict`/`alreadyCompleted`가 §9.2의 idempotent contract를 받쳐주는 정식 status다. 두 번째 resume 호출은 mutation 없이 이 둘 중 하나(또는 `notReady`)로 수렴한다.

### 9.5 Core data types

```ts
type HitlBatchStatus =
  | "preparing"
  | "waitingForHuman"
  | "ready"
  | "resuming"
  | "continuing"
  | "completed"
  | "failed"
  | "blocked"
  | "expired"
  | "canceled";

type HitlRequestStatus =
  | "pending"
  | "resolved"
  | "rejected"
  | "completed"
  | "failed"
  | "blocked"
  | "expired"
  | "canceled";

interface HitlBatchRecord {
  batchId: string;
  status: HitlBatchStatus;
  agentName: string;
  conversationId: string;
  turnId: string;
  stepNumber: number;
  toolCalls: HitlBatchToolCallSnapshot[];
  toolResults: HitlBatchToolResult[];
  toolExecutions: HitlBatchToolExecutionMarker[];
  conversationEvents: MessageEvent[];
  createdAt: string;
  updatedAt: string;
  lease?: HitlLease;
  appendCommit?: HitlBatchAppendCommit;
  completion?: HitlBatchCompletion;
  failure?: HitlFailure;
  metadata?: Record<string, JsonValue>;
}

interface HitlRequestRecord {
  requestId: string;
  batchId: string;
  status: HitlRequestStatus;
  agentName: string;
  conversationId: string;
  turnId: string;
  stepNumber: number;
  toolCallId: string;
  toolCallIndex: number;
  toolName: string;
  originalArgs: JsonObject;
  finalArgs?: JsonObject;
  prompt?: string;
  responseSchema: HitlResponseSchema;
  conversationEvents?: MessageEvent[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  result?: HitlHumanResult;
  completion?: HitlCompletion;
  failure?: HitlFailure;
  lease?: HitlLease;
  metadata?: Record<string, JsonValue>;
}

interface HitlQueuedSteer extends HitlQueuedSteerInput {
  queuedInputId: string;
  batchId: string;
  status: "queued" | "draining" | "drained" | "canceled";
}
```

## 10. Runtime Responsibility

- Core execution owns HITL policy evaluation, batch creation, non-HITL peer result recording, and `waitingForHuman` turn settlement.
- Runtime control owns pending query, submit, resume, startup recovery, and direct `processTurn()` barrier handling.
- Ingress owns routing input into `queuedForHitl` instead of starting a new turn when a queueable HITL batch exists, and rejecting input when a barrier is not queueable.
- Store adapter owns atomicity, durability, idempotent submit, conversation barrier uniqueness, queued steer retention, resume append commit, and side-effect boundary markers.
- Tool or host application owns external side effect idempotency.

## 11. Acceptance Criteria

- Given one HITL tool call, When the step is processed, Then the handler is not called, batch/request are stored, and the turn returns `waitingForHuman`.
- Given one normal tool call and two HITL tool calls in the same step, When the step is processed, Then the normal tool call executes and its result is stored, both HITL calls become pending requests with the same `batchId`, and no next LLM step runs.
- Given only one of two peer HITL requests has been submitted, When submit succeeds, Then the human result is durable and resume is not scheduled.
- Given the final peer HITL request is submitted, When submit succeeds, Then the request result and batch `ready` transition happen atomically and resume is scheduled.
- Given the same request submit is retried after batch moved to `ready`, `resuming`, `continuing`, `completed`, `blocked`, or `failed`, When the submit is duplicate, Then the existing request state is returned and no mutation occurs.
- Given the same idempotency key is reused for another request, When submit is attempted, Then it is rejected and no mutation occurs.
- Given queueable HITL exists for a conversation, When ingress or direct `processTurn()` targets the same conversation, Then it is stored as queued steer and no new turn starts.
- Given a HITL batch is `preparing`, When ingress or direct `processTurn()` targets the same conversation, Then the input is rejected/error and is not appended, steered, or accepted.
- Given a queue-closed `resuming` batch or `failed(retryable)` batch exists, When a new batch is created for the same conversation, Then `createBatch()` returns conflict.
- Given a queue-closed `resuming` batch exists, When ingress targets the same conversation, Then it is rejected/error rather than queued.
- Given a HITL batch is `continuing` and no active continuation turn exists, When ingress or direct `processTurn()` targets the same conversation before completion, Then the input is rejected/error.
- Given a HITL batch is `continuing` and an active continuation turn exists, When ingress targets the same conversation, Then it may use normal active-turn steering and must not be stored as HITL queued steer.
- Given active-turn steering arrives before a step settles into HITL, When the step returns `waitingForHuman`, Then the steered input is durably queued before success is observed.
- Given queued steer exists, When resume appends tool results, Then queued steer is appended after tool results and before continuation.
- Given queued steer was accepted, When resume append commit fails, Then queued/draining steer remains recoverable for retry and the batch remains a conversation barrier.
- Given approved HITL handler returns a result, When the result is stored, Then tool result and request completion are stored atomically.
- Given handler execution has started and the process crashes, When startup recovery runs, Then core does not automatically rerun that handler.
- Given commit append has succeeded and continuation starts, When continuation fails or the process crashes before batch completion, Then recovery does not automatically rerun continuation.
- Given continuation returns error or aborted, When resume records the outcome, Then the batch is not marked `completed`.
- Given continuation executes after resume, When turn middleware is registered, Then continuation observes the same turn middleware semantics as normal turn without adding a synthetic user message.
- Given a `preparing` batch has recorded non-HITL result for every non-HITL peer, When startup recovery runs, Then it can expose the batch as `waitingForHuman` without rerunning peer handlers.
- Given a `preparing` batch has a non-HITL execution marker without result, When startup recovery runs, Then it becomes blocked or safe-closed non-retryable and no handler is rerun.
- Given runtime restarts with a `waitingForHuman` batch in durable store, When pending HITL is listed, Then the pending request is returned.
- Given runtime restarts with a `ready` batch in durable store, When recovery runs, Then resume can be scheduled.
- Given HITL is not configured for any tool, When normal execution runs, Then existing execution behavior is unchanged.

## 12. Verification Plan

### Unit

- opaque `batchId`, `requestId`, `queuedInputId` generation
- HITL policy evaluation
- response schema validation
- duplicate/idempotent submit across `waitingForHuman`, `ready`, `resuming`, `continuing`, `completed`, `blocked`, `failed`
- conflicting duplicate submit does not mutate stored result
- batch ready transition when final peer is submitted
- `completeRequestWithToolResult()` atomic result+completion behavior
- conversation barrier conflict predicate independent of queueable predicate
- queueable predicate closes on queue-close metadata without clearing conversation barrier
- queued/draining steer ordering and retention until commit
- middleware parity for HITL continuation

### Integration

- `processTurn()` -> `waitingForHuman` -> `submitHitlResult()` -> resume -> completed
- one step with normal tool call plus multiple HITL tool calls
- first peer submit returns waiting-for-peers behavior
- final peer submit schedules resume
- pending HITL ingress/direct input returns queued result and no new LLM step starts
- ingress/direct input during `preparing` is rejected/error and is not memory-only steered
- active-turn steer is flushed into the HITL queue when the same step stops for HITL
- queue-closed `resuming` rejects new input but still blocks new batch creation
- `failed(retryable)` blocks new batch creation and can resume if before side-effect boundary
- ingress/direct input during `continuing` is rejected/error when there is no active continuation turn
- ingress during an active continuation can steer into that continuation without using HITL queued steer
- queued steer drains after tool-result flush and before continuation
- resume append commit failure keeps queued/draining steer recoverable
- handler-start crash leaves batch/request blocked or failed without automatic handler rerun
- continuation error/abort does not complete the batch
- continuation start followed by crash/recovery does not auto-rerun continuation
- `completeBatch()` persistence failure after continuation does not trigger automatic continuation replay
- `preparing` recovery exposes fully prepared batches and blocks marker-without-result batches without rerunning tools
- runtime recreate lists `waitingForHuman` batch from durable store
- runtime recreate schedules `ready` batch from durable store
- HITL-disabled tools keep existing regression tests passing

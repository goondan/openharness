# 2026-04-29 HITL durable resume implementation plan

## 1. 목표

`spec/core/hitl.md`의 Desired State를 구현한다. HITL required ToolCall은 tool handler 실행 전에 durable pending request로 저장되고, human result 제출 후 프로세스 재시작/크래시/장기간 대기 상황에서도 같은 ToolCall snapshot을 기준으로 중복 없이 재개된다.

## 2. AS-IS

- `ToolDefinition`에는 HITL 정책 필드가 없다.
- `TurnResult.status`는 `completed | aborted | error | maxStepsReached`만 지원한다.
- `executeStep()`은 LLM tool call을 assistant message로 append한 뒤 즉시 `executeToolCall()`을 호출한다.
- `executeToolCall()`은 middleware chain과 tool handler를 직접 실행하며 durable pending 상태를 만들지 않는다.
- runtime control API는 `abortConversation()`만 제공한다.
- in-flight turn 추적은 runtime process memory에만 존재한다.
- conversation state는 event sourcing을 지원하지만, HITL pending request와 resume lifecycle을 저장하는 store 계약은 없다.

## 3. TO-BE

- `ToolDefinition.hitl`로 approval/text/form 기반 HITL 정책을 선언한다.
- HITL 대상 ToolCall은 deterministic `requestId`를 가진 `HitlRequestRecord`로 `HitlStore`에 저장된다.
- pending 전환 시 tool handler는 호출되지 않고 Turn은 `waitingForHuman`으로 settle한다.
- `runtime.control`은 pending 조회, result 제출, resume, cancel API를 제공한다.
- startup recovery는 pending/resolved/rejected/resuming/failed(retryable) request를 조회하고 resumable request를 재처리한다.
- in-runtime resume task는 lease와 idempotency key를 사용해 tool handler at-most-once completion을 보장한다.
- approve/replace result는 최종 args를 다시 schema 검증한 뒤 tool handler에 전달한다.
- reject result는 tool handler 없이 rejection ToolResult를 conversation에 append한다.

## 4. 구현 단계

### Phase 1 - Public Types

- `packages/types/src/hitl.ts` 추가
  - `HitlPolicy`, `HitlRequestRecord`, `HitlRequestView`
  - `HitlHumanResult`, `HitlCompletion`, `HitlFailure`
  - `HitlStore`, lease/result 관련 반환 타입
- `packages/types/src/tool.ts`
  - `ToolDefinition.hitl?: HitlPolicy` 추가
- `packages/types/src/middleware.ts`
  - `TurnResult.status`에 `waitingForHuman` 추가
  - `StepResult`와 `TurnResult`에 `pendingHitlRequestIds?: string[]` 추가
- `packages/types/src/runtime.ts`
  - `ControlApi`에 `listPendingHitl`, `getHitlRequest`, `submitHitlResult`, `resumeHitl`, `cancelHitl` 추가
- `packages/types/src/events.ts`
  - `hitl.requested/resolved/rejected/resuming/completed/failed/recovery` payload 추가
- `packages/types/src/index.ts`
  - HITL 타입 re-export

### Phase 2 - Store Infrastructure

- `packages/core/src/hitl/store.ts` 추가
  - `InMemoryHitlStore`는 unit/integration test 용도로만 제공
  - request state transition validator
  - deterministic request id helper
  - lease expiry helper
- 테스트
  - create/list/get
  - duplicate create idempotency
  - resolve/reject state transition
  - acquire/release lease
  - complete/fail compare-and-set behavior

### Phase 3 - Runtime Wiring

- config surface에 optional `hitlStore` 또는 runtime-level HITL config 추가
- `HarnessRuntimeImpl`
  - `HitlStore` 주입
  - control API 구현
  - startup recovery hook 추가
  - close 시 in-flight resume task abort/wait 정리
- `createHarness()`
  - HITL store/config를 runtime deps에 연결
- 테스트
  - runtime 생성 시 recovery summary event
  - pending request 조회
  - submit result idempotency
  - store unavailable failure path

### Phase 4 - Execution Integration

- `executeToolCall()`
  - HITL policy evaluation 추가
  - HITL required면 request snapshot 생성 후 `HitlStore.create()`
  - 저장 성공 후 `hitl.requested`, `ToolResult` 대신 pending signal 반환
  - tool handler는 호출하지 않음
- `executeStep()`
  - pending signal을 감지해 tool-result message append를 지연
  - `StepResult`에 pending HITL request id를 전달
- `executeTurn()`
  - pending HITL이 있는 Step 이후 `waitingForHuman`으로 종료
- 테스트
  - HITL required tool은 handler 미호출
  - 한 Step의 HITL pending 이후 뒤쪽 tool call 미실행
  - assistant tool-call message는 남고 tool-result는 아직 없음
  - non-HITL tool은 기존 동작 유지
  - store write 실패는 `turn.error`

### Phase 5 - Resume Task

- `packages/core/src/harness-runtime.ts`에 in-runtime resume task lifecycle 추가
  - request 조회
  - lease 획득
  - conversation event snapshot restore
  - result mapper 적용
  - final args schema revalidation
  - 외부 tool handler 실행 전 `HitlStore.startExecution()` durable marker 저장
  - tool handler 실행 또는 rejection result 생성
  - tool-result message append
  - lease guard 기반 `HitlStore.complete()` compare-and-set
  - close 시 in-flight resume task abort/wait
- 테스트
  - approve resume handler 1회 실행
  - reject resume handler 미호출
  - form result args mutation
  - invalid form result는 pending 유지
  - concurrent resume race에서 completion 1개
  - `resuming` 중 crash simulation 후 lease TTL recovery
  - `blocked` 상태는 startup recovery가 자동 재실행하지 않음

### Phase 6 - Documentation and Examples

- `docs/extensions-and-tools.md`에 HITL policy 예시 추가
- `docs/architecture.md`에 `waitingForHuman` lifecycle 추가
- `README.md`에는 짧은 safe tool approval 예시만 추가
- CLI HITL UX는 `FR-HITL-014` Candidate이므로 core 완료 뒤 별도 PR로 분리

## 5. 구현 순서와 병렬화

1. Phase 1 타입 추가를 먼저 완료한다.
2. Phase 2 store infrastructure와 Phase 3 runtime wiring은 타입 확정 후 병렬 가능하다.
3. Phase 4 execution integration은 Phase 2/3에 의존한다.
4. Phase 5 resume task는 Phase 4와 일부 병렬 가능하지만 final integration은 Phase 4 이후 수행한다.
5. Phase 6 문서는 behavior가 테스트로 고정된 뒤 업데이트한다.

## 6. 위험과 완화

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `TurnResult.status` union 확장으로 downstream exhaustiveness break | 중간 | migration note와 타입 테스트 추가 |
| 외부 tool handler side effect 후 `HitlStore.complete()` 전 crash | 높음 | handler 호출 전 `startExecution()`으로 `blocked`를 durable하게 저장하고 자동 재실행 금지 |
| 외부 side effect exactly-once 착각 | 높음 | core는 at-most-once completion만 보장하고 tool-level idempotency key를 문서화 |
| conversation snapshot 비용 증가 | 중간 | 우선 full snapshot으로 correctness 확보, 추후 store reference 최적화 |
| event ordering 혼선 | 중간 | durable-before-observable 규칙을 unit test로 고정 |

## 7. 검증 게이트

- `pnpm -r run typecheck`
- `pnpm --filter @goondan/openharness-types run typecheck`
- `pnpm --filter @goondan/openharness run test`
- HITL 신규 integration tests
  - pending 전환
  - runtime recreate 후 pending 조회
  - approve/reject resume
  - form args mutation
  - concurrent resume race
  - lease TTL recovery
- 기존 execution/ingress regression tests

## 8. 완료 기준

- `spec/core/hitl.md`의 `AC-07` ~ `AC-12`가 자동 테스트로 검증된다.
- HITL 미사용 도구의 기존 테스트가 모두 통과한다.
- durable store 없이 HITL policy를 사용하는 경우 명확한 config error가 발생한다.
- release note 또는 migration note에 `waitingForHuman` status와 `ToolDefinition.hitl` 추가가 기록된다.

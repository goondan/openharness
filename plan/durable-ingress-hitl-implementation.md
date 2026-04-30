# Durable Inbound and Human Gate Implementation Plan

## 1. 목표

`spec/inbound/durable-inbound.md`와 `spec/core/hitl.md`를 기준으로 phase 1 구현을 완료한다. phase 1은 durable mode opt-in, append-first inbound preservation, scheduler 기반 active delivery/blocking, in-memory reference store, Human Gate 생성/조회/submit/resume 기본 경로를 제공한다.

## 2. 범위

### Committed

- public type 확장: durable inbound, scheduler disposition, Human Gate, control API, event payload.
- `HarnessConfig` opt-in durable runtime 구성 추가.
- core in-memory reference stores:
  - `InMemoryDurableInboundStore`
  - `InMemoryHumanGateStore`
- ingress `receive()`/`dispatch()` append-first integration.
- direct `processTurn()` durable append-first path.
- scheduler:
  - idle conversation -> started
  - active Turn -> delivered
  - Human Gate blocker -> blocked
  - duplicate append -> duplicate
- active Turn Step 경계 durable drain.
- ToolDefinition `humanGate` policy와 handler-before-human guard.
- runtime control API:
  - inbound item list/retry/dead-letter/release
  - human task list/submit/resume/cancel
- tests for append-first, duplicate, active delivery, blocking, human gate creation/submit/reject basics.

### Planned / Out of Scope

- production DB adapter.
- true durable conversation execution / LLM provider call resume.
- external approval UI/CLI UX.
- distributed exactly-once external side effect guarantee.
- background worker hosting. Core는 opportunistic scheduling과 explicit control API를 제공한다.

## 3. 작업 순서

1. Types
   - `packages/types/src/ingress.ts`: disposition과 accepted result 확장.
   - `packages/types/src/tool.ts`: `HumanGatePolicy` 추가.
   - `packages/types/src/middleware.ts`: `waitingForHuman` TurnResult status 추가.
   - `packages/types/src/runtime.ts`: durable control API 추가.
   - `packages/types/src/config.ts`: durable store config 추가.
   - `packages/types/src/events.ts`: `inbound.*`, `humanGate.*`, `humanTask.*` events 추가.

2. Core stores and scheduler
   - `packages/core/src/inbound/*`: durable inbound store, scheduler, helper 구현.
   - `packages/core/src/hitl/*`: in-memory human gate store와 basic policy mapper 구현.
   - in-memory store는 adapter contract의 reference implementation 역할을 한다.

3. Runtime wiring
   - `create-harness.ts`: config에서 durable stores를 주입하고 runtime/pipeline에 연결.
   - `harness-runtime.ts`: scheduler, control API, durable direct path, active drain API 연결.
   - `ingress/pipeline.ts`: route 성공 후 durable append/scheduler outcome을 accepted result로 변환.
   - `execution/turn.ts`: Step 경계에서 durable delivered item drain.
   - `execution/tool-call.ts`: human gate policy면 handler 실행 전 Human Gate 생성 후 `waitingForHuman` result를 발생시키는 제어 흐름 추가.

4. Tests
   - `packages/core/src/__tests__/inbound/durable-inbound.test.ts`
   - `packages/core/src/__tests__/execution/hitl.test.ts`
   - 기존 ingress/runtime regression 유지.

5. Verification
   - `pnpm --filter @goondan/openharness-types run typecheck`
   - `pnpm --filter @goondan/openharness run typecheck`
   - `pnpm --filter @goondan/openharness test`
   - 가능하면 `pnpm typecheck`와 `pnpm test`

## 4. 리스크 대응

- stale `packages/types/dist`가 typecheck resolution에 영향을 줄 수 있으므로, 타입 변경 후 `pnpm --filter @goondan/openharness-types build`를 먼저 실행한다.
- durable mode는 opt-in으로 구현해 기존 non-durable tests가 깨지지 않게 한다.
- ToolCall resume의 완전한 continuation은 phase 1에서 제한하고, approval/rejection result 저장과 at-most-once guard를 우선 검증한다.

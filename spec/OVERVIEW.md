# OpenHarness v0.1 - 상위 스펙

## 1. 한 줄 요약

에이전트 개발자가 OpenHarness를 이용해 LLM 실행 루프, 대화 상태, ingress, 도구/확장 구성을 코드로 명시적으로 조립하고 실험할 수 있게 한다.

## 2. Desired State

OpenHarness는 얇고 조립 가능한 agent runtime으로 동작한다. 코어는 실행 루프, 대화 상태, ingress, 이벤트, 확장 등록 같은 공통 런타임 계약을 제공하고, 제품별 전략은 Extension/Tool/Connector/Connection이 명시적으로 구성한다.

- 코어 책임과 확장 책임은 문서화된 계약으로 분리된다.
- Extension, Tool, Connector는 코어 포크 없이 각자의 경계 안에서 동작한다.
- CLI, programmatic API, ingress는 같은 runtime 계약을 공유한다.
- 스펙은 구현의 목표 상태와 검증 가능한 수용 기준을 정의한다.

## 2.1 문제 정의와 배경

현재 ingress는 verify/normalize/route 이후 즉시 in-memory Turn 실행 또는 active Turn steering으로 연결된다. direct `processTurn()`은 ingress와 별개로 즉시 Turn을 시작한다. 이 구조에서는 active Turn 중 들어온 input, Human Gate 대기 중 input, process crash 직전 accepted 된 input이 같은 durability/ordering/idempotency 계약을 공유하지 못한다.

사용자가 기대하는 핵심 계약은 특정 HITL queue가 아니라 “accepted 된 inbound event는 잃지 않는다”는 것이다. 따라서 OpenHarness는 durable mode에서 ingress/direct input을 먼저 durable inbound queue에 append하고, conversation scheduler가 idle/active/blocker/recovery 상태를 판단해 처리하는 Desired State를 가진다.

## 3. 목표

| ID | 목표 | 설명 |
| --- | --- | --- |
| G-1 | 순수한 코어 | 코어는 Turn/Step/ToolCall 실행, ingress 파이프라인, 이벤트 버스, 대화 상태 인프라만 소유한다. |
| G-2 | 명시적 조립 | 시스템 프롬프트, 메모리 전략, 도구 카탈로그, ingress 개입은 선언한 Extension/Tool/Connection만 동작한다. |
| G-3 | 코드 우선 구성 | `harness.config.ts`와 `createHarness()`로 전체 구성을 선언하고 실행한다. |
| G-4 | 확장 가능 계약 | 서드파티 Extension/Tool/Connector가 코어 포크 없이 동작할 수 있어야 한다. |
| G-5 | 관찰 가능성 | Turn/Step/Tool/Ingress 주요 시점이 이벤트로 노출되고, ingress accepted handle과 실제 turn 실행이 상관관계를 가진다. |
| G-6 | 안전한 실험 | 전략 교체, 메시지 압축, route 개입, CLI override가 다른 책임 경계를 오염시키지 않아야 한다. |
| G-7 | 복구 가능한 Human Gate | 사람 승인이 필요한 ToolCall은 프로세스 재시작/크래시/장기간 대기 이후에도 안전하게 재개할 수 있어야 한다. |
| G-8 | Durable inbound contract | durable mode에서 accepted 된 ingress/direct input은 먼저 durable inbound log에 저장되어 유실 없이 재처리 가능해야 한다. |
| G-9 | 통합 conversation scheduling | idle, active Turn, Human Gate blocker, recovery 상황의 inbound input 처리는 같은 scheduler와 ordering/idempotency 계약을 따라야 한다. |

## 3.1 성공 지표와 Definition of Done

| ID | 성공 기준 | 검증 |
| --- | --- | --- |
| S-1 | durable mode의 `receive()`, `dispatch()`, `processTurn()`은 accepted 관찰 전 inbound append를 성공시킨다. | append failure/crash injection test |
| S-2 | 같은 conversation의 duplicate input과 concurrent scheduler run은 중복 inbound item/user message를 만들지 않는다. | idempotency/concurrency test |
| S-3 | Human Gate 중 들어온 input은 Human Gate 전용 queue가 아니라 durable inbound item으로 blocked 상태가 된다. | Human Gate integration test |
| S-4 | active Turn 중 input은 memory queue 유실과 무관하게 durable item 기준으로 delivery/recovery된다. | active delivery recovery test |
| S-5 | non-durable 기존 started/steered 동작과 기존 테스트는 config 변경 없이 유지된다. | regression test |

## 4. 비목표

- 완성형 에이전트 제품 제공
- 기본 시스템 프롬프트/기본 메모리/기본 도구 자동 활성화
- 특정 persistence backend를 코어에 내장
- HTTP 서버, queue consumer 같은 transport 호스팅 제공
- 동적 hot-reload 구성 변경

## 5. 범위와 시스템 경계

### 5.1 코어가 책임지는 것

- Turn -> Step -> ToolCall 실행 루프
- `maxSteps` 한도와 AbortSignal 전파
- 이벤트 소싱 기반 대화 상태 인프라
- Extension 등록과 Tool registry
- ingress `receive()` / `dispatch()` 파이프라인
- CLI에서 config/.env 로드 후 runtime 생성

### 5.2 코어가 책임지지 않는 것

- 시스템 프롬프트 내용
- 메시지 압축/요약/윈도우 정책
- persistence 저장
- 외부 이벤트 수신 transport
- 도구 선택 정책

## 6. 용어 정의

| 용어 | 정의 |
| --- | --- |
| Turn | 사용자 입력 1건을 받아 최종 텍스트 또는 종료 상태를 만드는 전체 처리 단위 |
| Step | Turn 내부에서 LLM을 한 번 호출하는 단위 |
| ToolCall | Step 내부에서 실행되는 개별 도구 호출 |
| Extension | `register(api)`로 미들웨어, 이벤트 구독, 도구 조작을 등록하는 플러그인 |
| Tool | JSON Schema 입력 검증을 거쳐 LLM이 호출하는 실행 핸들러 |
| Connector | raw payload를 검증하고 `InboundEnvelope`로 정규화하는 어댑터 |
| Connection | Connector와 routing rule, connection-level extension 묶음 |
| InboundEnvelope | ingress가 Turn 입력으로 사용하는 표준 이벤트 형식 |
| Ingress Disposition | durable accepted 결과가 새 Turn을 시작했는지(`started`), active Turn에 전달됐는지(`delivered`), blocker로 막혔는지(`blocked`), duplicate인지 나타내는 값. `steered`는 non-durable legacy alias다. |
| Runtime Snapshot | Extension 등록 시점에 제공되는 선언 기반 읽기 전용 구성 정보 |
| Durable Inbound Queue | ingress/direct input을 처리 전에 append하는 conversation-scoped durable inbox/log |
| Human Approval | ToolCall 실행 전 사람 승인/입력을 요구하는 public policy. `ToolDefinition.humanApproval`과 `HarnessConfig.humanApproval`로 선언한다. |
| Human Gate | Human Approval을 durable하게 표현하는 내부 gate/blocker lifecycle. persisted blocker/event compatibility key는 `humanGate`를 유지한다. |
| Human Task | Human Gate가 사람에게 노출하는 승인/거절/입력 요청 |
| Conversation Blocker | 특정 `(agentName, conversationId)`의 새 Turn/delivery를 막는 durable state. canonical owner는 Human Gate 또는 operator hold store이며 inbound item은 blocker reference만 저장한다. |
| Conversation Scheduler | conversation 상태와 inbound item 상태를 보고 새 Turn 시작, active Turn delivery, blocker 대기, retry/recovery를 결정하는 runtime component |

## 7. 기능 요구사항

### 7.1 실행 루프

| ID | 요구사항 |
| --- | --- |
| FR-EXEC-001 | Turn은 Step을 반복 실행하고, Step은 필요 시 ToolCall을 수행한다. |
| FR-EXEC-002 | 코어는 인바운드 사용자 메시지, assistant 응답, tool 결과를 `appendMessage` 이벤트로 대화 상태에 자동 기록한다. |
| FR-EXEC-003 | `maxSteps`에 도달하면 Turn은 `maxStepsReached`로 종료된다. |
| FR-EXEC-004 | 하나의 AbortSignal이 Turn, Step, ToolCall, LLM 호출, Tool handler까지 전달된다. |
| FR-EXEC-005 | LLM client가 `streamChat()`을 구현하면 우선 사용하고, 없으면 `chat()`으로 폴백한다. |
| FR-EXEC-006 | `step.textDelta`와 `step.toolCallDelta`는 스트리밍 중간 이벤트로 발행된다. |
| FR-EXEC-007 | ingress가 발급한 accepted `turnId`는 실제 turn 실행에서도 동일한 ID를 사용한다. |
| FR-EXEC-008 | runtime은 `turn.start` 발행 전에 해당 `(agentName, conversationId)`의 active turn 추적을 등록한다. |
| FR-EXEC-009 | active turn은 `turn.done`/`turn.error` 발행 전에 steer 불가 상태가 된다. |

### 7.2 대화 상태

| ID | 요구사항 |
| --- | --- |
| FR-STATE-001 | events가 원천(source of truth)이고 messages는 replay 결과다. |
| FR-STATE-002 | 이벤트 타입은 `appendSystem`, `appendMessage`, `replace`, `remove`, `truncate` 다섯 가지다. |
| FR-STATE-003 | `emit()`은 active turn 안에서만 허용된다. |
| FR-STATE-004 | `restore(events)`는 전체 상태를 원자적으로 교체하고, 실패 시 기존 상태를 보존한다. |
| FR-STATE-005 | runtime의 대화 상태는 `(agentName, conversationId)` 단위로 분리된다. |
| FR-STATE-006 | `appendSystem`은 role=`system`만 허용하고, `appendMessage`는 role=`system`을 거부한다. |
| FR-STATE-007 | `replace`는 동일 message id의 exact role match만 허용하며 role 변경은 금지한다. |

### 7.3 Extension / Tool 시스템

| ID | 요구사항 |
| --- | --- |
| FR-EXT-001 | Extension 등록은 중복 이름을 금지하고, 실패 시 부분 등록 없이 롤백된다. |
| FR-EXT-002 | `api.runtime`은 모든 agent/connection 메타데이터를 포함한 읽기 전용 스냅샷이다. |
| FR-EXT-003 | `api.runtime.agent.extensions/tools`는 선언 기반 스냅샷이며 live registry가 아니다. |
| FR-EXT-004 | live Tool registry는 `api.tools.register/remove/list`로 조작한다. |
| FR-EXT-005 | agent extension은 `turn`, `step`, `toolCall`, `route` 미들웨어를 등록할 수 있다. |
| FR-EXT-006 | connection extension은 `ingress` 미들웨어와 ingress 이벤트 구독을 담당한다. |
| FR-EXT-007 | event listener의 반환값은 무시되며, 동기 예외는 실행을 깨뜨리지 않는다. |

### 7.4 Ingress

| ID | 요구사항 |
| --- | --- |
| FR-INGRESS-001 | `receive()`는 verify -> normalize -> fan-out -> route -> dispatch 순서로 동작한다. |
| FR-INGRESS-002 | routing rule은 선언 순서대로 평가하는 first-match-wins다. |
| FR-INGRESS-003 | `conversationId` 우선순위는 `rule.conversationId` -> `rule.conversationIdProperty(+Prefix)` -> `envelope.conversationId`다. |
| FR-INGRESS-004 | route 미들웨어는 초기 route match 뒤, 선택된 agent에 대해서만 실행된다. |
| FR-INGRESS-005 | `dispatch()`는 verify/normalize를 건너뛰고 route부터 수행한다. |
| FR-INGRESS-006 | ingress 접수는 fire-and-forget이며, `receive()/dispatch()`는 Turn 완료를 기다리지 않는다. |
| FR-INGRESS-007 | connection extension은 ingress 이벤트 버스를 공유해 `ingress.received/accepted/rejected`를 관찰할 수 있다. |
| FR-INGRESS-008 | route 결과의 `(agentName, conversationId)`에 steer 가능한 active turn이 있으면 새 Turn 대신 해당 Turn의 다음 Step 입력으로 접수한다. |
| FR-INGRESS-009 | durable mode의 active Turn delivery disposition은 `delivered`이고, non-durable legacy mode는 기존 `steered` 값을 유지한다. |
| FR-INGRESS-010 | durable inbound mode에서 `receive()`/`dispatch()`는 accepted result 반환 전에 durable inbound append를 성공시켜야 한다. |
| FR-INGRESS-011 | duplicate ingress append는 새 inbound item을 만들지 않고 기존 item identity와 현재 disposition으로 수렴해야 한다. |
| FR-INGRESS-012 | Human Gate 또는 operator blocker가 있는 conversation의 ingress input은 새 Turn을 시작하지 않고 durable inbound item으로 blocked 상태가 되어야 한다. |
| FR-INGRESS-013 | accepted result는 durable mode에서 `inboundItemId`, `agentName`, `conversationId`, disposition, optional `turnId`, optional blocker 정보를 포함해야 한다. |

### 7.4b Durable Inbound / Direct Input

| ID | Level | 요구사항 |
| --- | --- | --- |
| FR-DIR-001 | Committed | durable inbound mode에서 ingress/direct input은 처리 전에 `DurableInboundStore`에 append되어야 한다. |
| FR-DIR-002 | Committed | inbound item은 `agentName`, `conversationId`, source metadata, normalized envelope, received timestamp, idempotency key를 포함해야 한다. |
| FR-DIR-003 | Committed | store는 같은 logical input을 idempotently 처리하고 같은 `(agentName, conversationId)` 안에서 deterministic sequence를 부여해야 한다. |
| FR-DIR-004 | Committed | inbound item 상태는 최소 `pending`, `leased`, `delivered`, `blocked`, `consumed`, `failed`, `deadLetter`를 표현해야 한다. |
| FR-SCHED-001 | Committed | scheduler는 idle conversation이면 가장 이른 pending item으로 새 Turn을 시작해야 한다. |
| FR-SCHED-002 | Committed | scheduler는 active Turn이 있으면 pending item을 durable active delivery 대상으로 전환해야 한다. |
| FR-SCHED-003 | Committed | scheduler는 Human Gate blocker가 있으면 inbound item을 `blockedBy=humanGate`로 표시하고 새 Turn을 시작하지 않아야 한다. |
| FR-ACTIVE-001 | Committed | active Turn의 in-memory steering inbox는 source of truth가 아니라 wake-up/cache로만 사용해야 한다. |
| FR-ACTIVE-002 | Committed | user message append와 inbound item consume은 중복 append를 방지할 수 있는 commit reference를 공유해야 한다. |
| FR-DIR-005 | Committed | expired lease는 pending/retryable item으로 복구 가능해야 한다. |
| FR-DIRECT-001 | Committed | `processTurn()`은 durable mode에서 direct input을 append-first 방식으로 처리해야 한다. |
| FR-DIRECT-002 | Committed | direct input과 ingress input은 queue, ordering, blocker, active delivery semantics를 공유해야 한다. |
| FR-OBS-001 | Committed | runtime control API는 pending/blocked/failed/deadLetter inbound item 조회와 retry/dead-letter/release 조작을 제공해야 한다. |
| FR-DIR-006 | Planned | durable conversation execution은 phase 1 이후 확장 범위이며 phase 1은 inbound preservation과 at-least-once delivery를 보장한다. |

### 7.5 구성 / CLI

| ID | 요구사항 |
| --- | --- |
| FR-CONFIG-001 | `defineHarness()`는 순수 identity 함수다. |
| FR-CONFIG-002 | `createHarness()`는 env ref를 해석하고 runtime을 생성한다. |
| FR-CONFIG-003 | CLI는 `.env`를 읽되 기존 `process.env`가 우선한다. |
| FR-CONFIG-004 | CLI는 선택된 agent를 결정한 뒤 runtime을 생성한다. |
| FR-CONFIG-005 | CLI의 `--max-steps`는 선택된 agent의 runtime 설정만 override 한다. |
| FR-CONFIG-006 | 패키지는 `types`, `core`, `cli`, `base` 책임으로 분리된다. |

### 7.6 Human Gate / HITL

| ID | Level | 요구사항 |
| --- | --- | --- |
| FR-HG-001 | Committed | ToolDefinition은 선택적으로 `humanApproval` policy를 선언할 수 있다. |
| FR-HG-002 | Committed | `humanApproval`이 필요한 ToolCall은 handler 실행 전에 durable Human Gate와 Human Task를 생성해야 한다. |
| FR-HG-003 | Committed | human task 저장 성공 전에는 handler를 호출하면 안 된다. |
| FR-HG-004 | Committed | Human Gate는 conversation blocker로 등록되어 같은 conversation의 새 Turn 시작을 막아야 한다. |
| FR-HG-005 | Committed | Human Gate 중 새 inbound event는 별도 HITL queue가 아니라 durable inbound item으로 저장되고 `blockedBy=humanGate`로 표시되어야 한다. |
| FR-HG-006 | Committed | Human Task는 approval, rejection, text input, structured form input을 지원해야 한다. |
| FR-HG-007 | Committed | human result submit은 durable write 이후에만 accepted response와 lifecycle event를 반환해야 한다. |
| FR-HG-008 | Committed | duplicate submit은 idempotent하게 기존 result로 수렴해야 한다. |
| FR-HG-009 | Committed | 모든 required Human Task가 resolved/rejected되기 전에는 blocked inbound item을 continuation에 반영하면 안 된다. |
| FR-HG-010 | Committed | Human Gate resume은 blocker 유지 상태에서 tool result를 먼저 append하고 blocked inbound items를 deterministic order로 append한 뒤 blocker를 해제해야 한다. |
| FR-HG-011 | Committed | human rejection은 handler 호출 없이 rejection tool result로 conversation에 반영되어야 한다. |
| FR-HG-012 | Committed | Human Gate status는 `waitingForHuman`, `ready`, `resuming`, `completed`, `blocked`, `canceled`, `expired`, `failed`를 표현해야 한다. |
| FR-HG-013 | Committed | Human Task status는 `waitingForHuman`, `resolved`, `rejected`, `canceled`, `expired`를 표현해야 한다. |
| FR-HG-014 | Committed | runtime은 pending Human Task 조회, human result 제출, resume/cancel control API를 제공해야 한다. |
| FR-HG-015 | Committed | Human Gate resume은 프로세스 재시작 이후에도 가능해야 한다. |
| FR-HG-016 | Committed | Human Gate resume은 handler 실행 전 durable `handlerStartedAt` boundary를 기록하고, 그 이후 lease 만료 재획득으로 같은 handler를 자동 재실행하지 않아야 한다. |
| FR-HG-017 | Planned | TTL, reminder, escalation, external approval UI는 extension/host 정책으로 구성할 수 있어야 한다. |
| FR-HG-018 | Committed | Human Gate resume은 tool result와 blocked inbound items를 append/consume한 뒤 continuation Turn을 실행해야 한다. |

## 8. 비기능 요구사항

| ID | 요구사항 | 검증 방향 |
| --- | --- | --- |
| NFR-001 | 타입 안전성: config와 tool schema 오류는 가능한 한 TypeScript/Ajv 단계에서 잡힌다. | `tsc`, unit test |
| NFR-002 | 상태 격리: agent가 달라도 같은 `conversationId`를 공유하지 않는다. | unit test |
| NFR-003 | 등록 원자성: extension 하나가 실패하면 이전 등록도 남지 않는다. | unit test |
| NFR-004 | 상관관계: `started` accepted result는 새 turn 이벤트와 같은 `turnId`를 쓰고, durable `delivered` 또는 legacy `steered` accepted result는 기존 active turn의 `turnId`를 반환한다. | integration test |
| NFR-005 | 종료 안정성: `runtime.close()`는 진행 중 turn을 abort하고 정리한다. | unit/integration test |
| NFR-DIR-001 | Durable-before-observable: durable mode accepted result/event는 inbound append 이후에만 발생한다. | crash injection test |
| NFR-DIR-002 | At-least-once: accepted inbound item은 consumed/deadLetter가 될 때까지 재처리 가능해야 한다. | recovery test |
| NFR-DIR-003 | Idempotency: duplicate input, duplicate submit, duplicate scheduler run이 중복 message/task를 만들지 않는다. | concurrency test |
| NFR-DIR-004 | Ordering: 같은 conversation의 inbound item은 sequence order로 delivery된다. | ordering test |
| NFR-DIR-005 | Isolation: 서로 다른 agent 또는 conversation의 queue state는 섞이지 않는다. | unit/integration test |
| NFR-DIR-006 | No hidden memory durability: runtime memory queue는 durable guarantee의 근거가 될 수 없다. | design review/test |
| NFR-DIR-007 | Store atomicity: store method는 성공 시 관련 상태를 모두 반영하고 실패 시 partial mutation을 노출하지 않아야 한다. | adapter contract test |
| NFR-DIR-008 | Performance: durable append path는 common webhook latency budget 안에서 동작해야 한다. | benchmark |
| NFR-DIR-009 | Operability: dead-letter와 blocked state는 operator가 조회/재시도/취소할 수 있어야 한다. | admin/control API test |
| NFR-HG-001 | Human Gate durable-before-handler: `humanGate.created`/`humanTask.created` 이벤트 전 gate/task가 durable store에 저장되고 handler는 실행되지 않는다. | crash recovery/unit test |
| NFR-HG-002 | Human Gate blocker consistency: blocker 중 inbound item은 durable inbound queue에 blocked 상태로 남는다. | integration test |
| NFR-HG-003 | Human Gate idempotency: duplicate task result/gate resume이 중복 handler execution을 만들지 않는다. | concurrency test |
| NFR-HG-004 | Human Gate observability: lifecycle events는 `humanGateId`, `humanTaskId`, `turnId`, `toolCallId`, `conversationId`를 포함한다. | unit test |
| NFR-HG-005 | Human Gate security: human result 제출은 task identity와 agent/conversation scope 검증을 통과해야 한다. | negative test |
| NFR-HG-006 | Human Gate compatibility: Human Gate 미사용 도구의 실행 루프와 결과 구조는 기존 동작을 유지한다. | regression test |
| NFR-HG-007 | Human Gate retention: 완료/거절/만료된 task는 store별 retention 정책으로 정리 가능해야 한다. | adapter test |

## 9. 안정성 분류

| 영역 | 분류 | 이유 |
| --- | --- | --- |
| Turn/Step/ToolCall 루프 | Stable | 코어의 중심 계약 |
| 이벤트 소싱 대화 상태 | Stable | 확장 전략이 여기에 의존 |
| ingress route 우선순위 | Stable | 외부 시스템 연동 계약 |
| `api.runtime` 스냅샷 의미 | Stable | 확장 작성자가 기대하는 introspection 계약 |
| CLI 옵션 표면 | Flexible | 사용성에 따라 확장 가능 |
| base 패키지 기본 제공 extension/tool 목록 | Flexible | 코어 계약과 분리된 편의 계층 |
| Human Gate 상태 머신과 store 계약 | Stable | 외부 승인 UI와 durable adapter가 의존 |
| append-first inbound contract | Stable | accepted input durability의 핵심 계약 |
| conversation 단위 ordering | Stable | agent 응답 일관성과 idempotency의 기반 |
| Human Gate가 queue를 소유하지 않는 모델 | Stable | HITL과 durable ingress 통합의 핵심 결정 |
| lease/retry/dead-letter 정책 | Flexible | store adapter와 운영 환경에 따라 조정 가능 |
| durable conversation execution | Planned | inbound preservation 이후 별도 확장 단계 |
| distributed exactly-once execution | Never | 외부 side effect까지 포함한 exactly-once는 core 보장 대상이 아님 |
| Human Gate CLI UX | Candidate | core 계약 검증 뒤 확장 가능 |

## 9.1 리스크와 완화책

| 리스크 | 가능성 | 영향 | 완화책 | 조기 신호 |
| --- | --- | --- | --- | --- |
| append latency가 webhook 응답 시간을 늘림 | Medium | Medium | durable mode opt-in, host-provided fast store, opportunistic/background scheduling 분리 | p95 receive latency 상승 |
| at-least-once delivery로 중복 message 발생 | Medium | High | inbound item id 기반 commitRef와 consume idempotency 강제 | 같은 inbound id가 여러 message id로 관측 |
| Human Gate blocker와 scheduler race | Medium | High | `createGate + registerBlocker`를 HumanGateStore atomic boundary로 고정 | blocked 중 새 Turn 생성 |
| adapter별 atomicity 차이 | Medium | High | store contract test suite와 in-memory reference implementation 제공 | 특정 adapter에서 duplicate/partial state |
| durable conversation execution과 phase 1 범위 혼동 | High | Medium | phase 1 보장 범위를 inbound preservation/at-least-once로 제한하고 LLM call resume은 Planned로 분리 | “LLM 호출 resume까지 되는가” 질문 반복 |

## 10. 상세 스펙 매핑

| 문서 | 다루는 책임 |
| --- | --- |
| `core/execution-loop.md` | Turn/Step/ToolCall, 스트리밍, abort, core append 정책 |
| `core/conversation-state.md` | event sourcing, restore, replay, 상태 스코프 |
| `core/extension-system.md` | Extension 등록, runtime snapshot, 이벤트/도구 표면 |
| `core/hitl.md` | Human Gate, Human Task, blocker, human result 제출, crash recovery, ToolCall resume |
| `ingress/ingress-pipeline.md` | Connector, routing, route middleware, fire-and-forget dispatch |
| `inbound/durable-inbound.md` | append-first inbound log, scheduler, active delivery, blocker/recovery semantics |
| `surface/configuration-api.md` | defineHarness/createHarness/runtime API/CLI/패키지 구조 |

## 11. 대표 수용 기준

### AC-01 최소 실행

- Given model만 선언하고 extension/tool이 없는 agent
- When `processTurn()` 또는 `oh run`을 호출하면
- Then 사용자 입력만으로 Turn이 실행되고, 코어가 시스템 프롬프트나 기본 도구를 추가하지 않는다.

### AC-02 전략 교체

- Given 동일한 agent/model/tool 구성을 유지한 상태에서 message management extension만 교체하면
- When runtime을 다시 생성하면
- Then 실행 루프는 동일하고 메시지 관리 전략만 달라진다.

### AC-03 persistence extension

- Given turn middleware에서 `ctx.conversation.events`를 저장하고 다음 runtime에서 `restore()`하는 extension
- When 같은 `(agentName, conversationId)`로 새 runtime에서 Turn을 시작하면
- Then 이전 대화 히스토리가 복원된 상태로 LLM 호출이 수행된다.

### AC-04 ingress correlation

- Given connection이 raw payload를 normalize하고 agent로 dispatch한다
- When `ingress.receive()`가 accepted result를 반환하면
- Then `disposition="started"`이면 반환된 `turnId`와 이후 `turn.start`의 `turnId`가 동일하다.

### AC-04b ingress active-turn delivery

- Given 같은 `(agentName, conversationId)`의 Turn이 실행 중이다
- When durable mode에서 같은 route 결과를 가진 ingress가 새로 accepted 된다
- Then 새 Turn을 시작하지 않고 기존 Turn의 다음 Step 입력으로 반영되며 `disposition="delivered"`와 기존 `turnId`, `inboundItemId`가 반환된다.
- And non-durable legacy mode에서는 기존 호환성을 위해 `disposition="steered"`를 반환할 수 있다.

### AC-04c ingress terminal boundary

- Given Turn이 `turn.done` 또는 `turn.error`를 발행하는 중이다
- When 같은 `(agentName, conversationId)`로 ingress가 들어온다
- Then 이미 종료 경계에 들어간 Turn에는 steer되지 않고 새 Turn으로 accepted 된다.

### AC-05 conversation isolation

- Given 두 agent가 같은 `conversationId`를 사용한다
- When 각 agent에서 Turn을 실행하면
- Then 각 agent는 자신의 대화 상태만 본다.

### AC-06 CLI override

- Given config에 `maxSteps`가 다르게 선언돼 있더라도
- When `oh run ... --max-steps 7` 또는 `oh repl --max-steps 7`로 특정 agent를 실행하면
- Then 선택된 agent runtime에만 `maxSteps=7`이 적용된다.

### AC-DIR-01 durable append before accepted

- Given durable inbound store가 설정되어 있다
- When `ingress.receive()` 또는 `ingress.dispatch()`가 route 성공한 envelope를 accept한다
- Then durable append가 성공하기 전에는 accepted result와 `ingress.accepted` 이벤트가 발생하지 않는다.

### AC-DIR-02 direct and ingress parity

- Given durable inbound store가 설정되어 있다
- When 같은 conversation에 direct `processTurn()`과 ingress `dispatch()`가 각각 호출된다
- Then 두 입력은 같은 queue, ordering, blocker, active delivery semantics를 따른다.

### AC-DIR-03 blocked inbound recovery

- Given conversation이 Human Gate에서 waiting 상태다
- When 같은 conversation으로 inbound event가 들어온다
- Then 새 Turn은 시작되지 않고 durable inbound item이 `blockedBy=humanGate`로 저장된다.

### AC-07 Human Approval pending 전환

- Given `humanApproval` required tool이 등록되어 있고 LLM이 해당 도구를 호출하면
- When Step이 ToolCall에 도달하면
- Then tool handler는 호출되지 않고 pending Human Gate와 Human Task가 durable store에 저장되며 Turn은 `waitingForHuman`으로 종료된다.

### AC-08 Human Gate 재시작 복구

- Given pending Human Task가 durable store에 저장되어 있으면
- When runtime을 종료하고 새 runtime을 생성한 뒤 pending Human Task를 조회하면
- Then 같은 `humanTaskId`가 조회된다.

### AC-09 Human Gate 승인 재개

- Given pending Human Task에 approval result를 제출하면
- When resume worker가 실행되면
- Then 저장된 ToolCall의 tool handler가 1회 실행되고 tool-result message가 conversation에 기록된 뒤 continuation Turn이 실행된다.

### AC-10 Human Gate 중복 방지

- Given 같은 Human Task에 같은 result가 여러 번 제출되면
- When 여러 resume worker가 동시에 실행되어도
- Then tool handler는 최대 1회만 호출되고 모든 호출자는 같은 completion을 관찰한다.

### AC-11 Human Gate 거절

- Given pending Human Task에 rejection result를 제출하면
- When resume이 실행되면
- Then tool handler는 호출되지 않고 거절 ToolResult가 conversation에 기록된다.

### AC-12 Human Gate form 입력

- Given form result가 tool args를 변경하도록 mapping되어 있으면
- When resume이 실행되면
- Then 최종 args는 JSON Schema 검증을 다시 통과한 뒤 tool handler에 전달된다.

## 12. 검증 계획

- core unit test로 실행 루프, abort, stream fallback, route priority, state restore를 검증한다.
- createHarness 수준 테스트로 runtime snapshot completeness, conversation isolation, ingress turnId correlation, active-turn delivery 경계 조건을 검증한다.
- durable inbound integration test로 append-first, duplicate append, lease conflict, blocked input, direct/ingress parity를 검증한다.
- Human Gate integration test로 pending 전환, runtime 재생성 후 조회, 승인/거절 resume, concurrent resume race를 검증한다.
- CLI 테스트로 agent 선택, `.env` 우선순위, `--max-steps` override를 검증한다.
- `pnpm -r run typecheck`를 기본 정합성 게이트로 사용한다.

## 13. 알려진 제약

- `api.runtime`은 선언 기반 스냅샷이며 동적으로 등록된 tool은 반영되지 않는다. live registry 확인은 `api.tools.list()`를 사용해야 한다.
- event listener는 비동기 작업을 기다려주지 않는다. 느리거나 중요한 후처리는 별도 큐/로깅 계층에서 처리해야 한다.
- connection extension은 ingress 맥락용이며 conversation mutation 책임은 가지지 않는다.
- system 메시지 선두 보장은 provider별 특례가 아니라 `appendSystem` 이벤트 의미와 conversation 파생 상태 규칙으로 유지한다.
- durable Human Gate는 core가 특정 저장소를 내장하지 않고 `HumanGateStore` 계약을 통해 외부 backend나 adapter가 제공한다.

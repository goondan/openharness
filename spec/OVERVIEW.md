# OpenHarness v0.1 - 상위 스펙

## 1. 한 줄 요약

에이전트 개발자가 OpenHarness를 이용해 LLM 실행 루프, 대화 상태, ingress, 도구/확장 구성을 코드로 명시적으로 조립하고 실험할 수 있게 한다.

## 2. Desired State

OpenHarness는 얇고 조립 가능한 agent runtime으로 동작한다. 코어는 실행 루프, 대화 상태, ingress, 이벤트, 확장 등록 같은 공통 런타임 계약을 제공하고, 제품별 전략은 Extension/Tool/Connector/Connection이 명시적으로 구성한다.

- 코어 책임과 확장 책임은 문서화된 계약으로 분리된다.
- Extension, Tool, Connector는 코어 포크 없이 각자의 경계 안에서 동작한다.
- CLI, programmatic API, ingress는 같은 runtime 계약을 공유한다.
- 스펙은 구현의 목표 상태와 검증 가능한 수용 기준을 정의한다.

## 3. 목표

| ID | 목표 | 설명 |
| --- | --- | --- |
| G-1 | 순수한 코어 | 코어는 Turn/Step/ToolCall 실행, ingress 파이프라인, 이벤트 버스, 대화 상태 인프라만 소유한다. |
| G-2 | 명시적 조립 | 시스템 프롬프트, 메모리 전략, 도구 카탈로그, ingress 개입은 선언한 Extension/Tool/Connection만 동작한다. |
| G-3 | 코드 우선 구성 | `harness.config.ts`와 `createHarness()`로 전체 구성을 선언하고 실행한다. |
| G-4 | 확장 가능 계약 | 서드파티 Extension/Tool/Connector가 코어 포크 없이 동작할 수 있어야 한다. |
| G-5 | 관찰 가능성 | Turn/Step/Tool/Ingress 주요 시점이 이벤트로 노출되고, ingress accepted handle과 실제 turn 실행이 상관관계를 가진다. |
| G-6 | 안전한 실험 | 전략 교체, 메시지 압축, route 개입, CLI override가 다른 책임 경계를 오염시키지 않아야 한다. |
| G-7 | 복구 가능한 HITL | 사람 승인이 필요한 ToolCall은 프로세스 재시작/크래시/장기간 대기 이후에도 안전하게 재개할 수 있어야 한다. |

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
| Ingress Disposition | ingress accepted 결과가 새 Turn을 시작했는지(`started`) 기존 active Turn에 합류했는지(`steered`) 나타내는 값 |
| Runtime Snapshot | Extension 등록 시점에 제공되는 선언 기반 읽기 전용 구성 정보 |

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
| FR-INGRESS-009 | `IngressAcceptResult.disposition`은 새 Turn 시작이면 `started`, 기존 active Turn 합류면 `steered`다. |

### 7.5 구성 / CLI

| ID | 요구사항 |
| --- | --- |
| FR-CONFIG-001 | `defineHarness()`는 순수 identity 함수다. |
| FR-CONFIG-002 | `createHarness()`는 env ref를 해석하고 runtime을 생성한다. |
| FR-CONFIG-003 | CLI는 `.env`를 읽되 기존 `process.env`가 우선한다. |
| FR-CONFIG-004 | CLI는 선택된 agent를 결정한 뒤 runtime을 생성한다. |
| FR-CONFIG-005 | CLI의 `--max-steps`는 선택된 agent의 runtime 설정만 override 한다. |
| FR-CONFIG-006 | 패키지는 `types`, `core`, `cli`, `base` 책임으로 분리된다. |

### 7.6 HITL

| ID | 요구사항 |
| --- | --- |
| FR-HITL-001 | ToolDefinition은 선택적으로 HITL 정책을 선언할 수 있다. |
| FR-HITL-002 | HITL 정책이 적용된 ToolCall은 tool handler 실행 전에 durable `HitlRequest`를 생성한다. |
| FR-HITL-003 | HITL request 저장 성공 전에는 해당 tool handler를 호출하지 않는다. |
| FR-HITL-004 | runtime은 pending HITL request 조회 API를 제공한다. |
| FR-HITL-005 | runtime은 human result 제출 API를 제공한다. |
| FR-HITL-006 | approve result는 ToolCall을 재개하고, reject result는 tool handler 호출 없이 거절 결과를 기록한다. |
| FR-HITL-007 | human result는 approval, text, JSON form payload를 지원한다. |
| FR-HITL-008 | HITL resume은 프로세스 재시작 이후에도 가능해야 한다. |
| FR-HITL-009 | HITL resume은 같은 request에 대해 at-most-once tool handler execution을 보장한다. |
| FR-HITL-010 | HITL lifecycle은 runtime event로 관찰 가능하다. |
| FR-HITL-011 | HITL로 보류된 Turn은 `waitingForHuman` 상태로 관찰 가능하다. |
| FR-HITL-012 | conversation event stream 복원 후에도 HITL request와 tool-call/tool-result 메시지 정합성이 유지된다. |
| FR-HITL-013 | TTL 만료, 자동 reject, reminder 같은 운영 정책은 extension으로 붙일 수 있다. |
| FR-HITL-014 | CLI는 pending request 조회와 approve/reject/submit 명령을 제공할 수 있다. |
| FR-HITL-015 | `HitlRequest`는 기본적으로 resume에 필요한 conversation event snapshot을 포함한다. |

## 8. 비기능 요구사항

| ID | 요구사항 | 검증 방향 |
| --- | --- | --- |
| NFR-001 | 타입 안전성: config와 tool schema 오류는 가능한 한 TypeScript/Ajv 단계에서 잡힌다. | `tsc`, unit test |
| NFR-002 | 상태 격리: agent가 달라도 같은 `conversationId`를 공유하지 않는다. | unit test |
| NFR-003 | 등록 원자성: extension 하나가 실패하면 이전 등록도 남지 않는다. | unit test |
| NFR-004 | 상관관계: `started` accepted result는 새 turn 이벤트와 같은 `turnId`를 쓰고, `steered` accepted result는 기존 active turn의 `turnId`를 반환한다. | integration test |
| NFR-005 | 종료 안정성: `runtime.close()`는 진행 중 turn을 abort하고 정리한다. | unit/integration test |
| NFR-HITL-001 | HITL 내구성: `hitl.requested` 이벤트 전 pending request가 durable store에 저장된다. | crash recovery test |
| NFR-HITL-002 | HITL 멱등성: 같은 request/result 재시도로 tool handler가 중복 실행되지 않는다. | concurrency test |
| NFR-HITL-003 | HITL 복구성: runtime 재생성 후 기존 pending request를 조회하고 재개할 수 있다. | integration test |
| NFR-HITL-004 | HITL 관찰성: 모든 HITL 상태 전이는 `requestId`, `turnId`, `toolCallId`, `conversationId`를 포함한다. | unit test |
| NFR-HITL-005 | HITL 보안성: human result 제출은 request identity와 agent/conversation scope 검증을 통과해야 한다. | negative test |
| NFR-HITL-006 | HITL 호환성: HITL 미사용 도구의 실행 루프와 결과 구조는 기존 동작을 유지한다. | regression test |
| NFR-HITL-007 | HITL retention: 완료/거절/만료된 request는 store별 retention 정책으로 정리 가능해야 한다. | adapter test |

## 9. 안정성 분류

| 영역 | 분류 | 이유 |
| --- | --- | --- |
| Turn/Step/ToolCall 루프 | Stable | 코어의 중심 계약 |
| 이벤트 소싱 대화 상태 | Stable | 확장 전략이 여기에 의존 |
| ingress route 우선순위 | Stable | 외부 시스템 연동 계약 |
| `api.runtime` 스냅샷 의미 | Stable | 확장 작성자가 기대하는 introspection 계약 |
| CLI 옵션 표면 | Flexible | 사용성에 따라 확장 가능 |
| base 패키지 기본 제공 extension/tool 목록 | Flexible | 코어 계약과 분리된 편의 계층 |
| HITL 상태 머신과 store 계약 | Stable | 외부 승인 UI와 durable adapter가 의존 |
| HITL CLI UX | Candidate | core 계약 검증 뒤 확장 가능 |

## 10. 상세 스펙 매핑

| 문서 | 다루는 책임 |
| --- | --- |
| `core/execution-loop.md` | Turn/Step/ToolCall, 스트리밍, abort, core append 정책 |
| `core/conversation-state.md` | event sourcing, restore, replay, 상태 스코프 |
| `core/extension-system.md` | Extension 등록, runtime snapshot, 이벤트/도구 표면 |
| `core/hitl.md` | durable HITL request, human result 제출, crash recovery, ToolCall resume |
| `ingress/ingress-pipeline.md` | Connector, routing, route middleware, fire-and-forget dispatch |
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

### AC-04b ingress active-turn steering

- Given 같은 `(agentName, conversationId)`의 Turn이 실행 중이다
- When 같은 route 결과를 가진 ingress가 새로 accepted 된다
- Then 새 Turn을 시작하지 않고 기존 Turn의 다음 Step 입력으로 반영되며 `disposition="steered"`와 기존 `turnId`가 반환된다.

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

### AC-07 HITL pending 전환

- Given HITL required tool이 등록되어 있고 LLM이 해당 도구를 호출하면
- When Step이 ToolCall에 도달하면
- Then tool handler는 호출되지 않고 pending HITL request가 durable store에 저장되며 Turn은 `waitingForHuman`으로 종료된다.

### AC-08 HITL 재시작 복구

- Given pending HITL request가 durable store에 저장되어 있으면
- When runtime을 종료하고 새 runtime을 생성한 뒤 pending HITL을 조회하면
- Then 같은 `requestId`가 조회된다.

### AC-09 HITL 승인 재개

- Given pending HITL request에 approve result를 제출하면
- When resume worker가 실행되면
- Then 저장된 ToolCall의 tool handler가 1회 실행되고 tool-result message가 conversation에 기록된다.

### AC-10 HITL 중복 방지

- Given 같은 request에 같은 result가 여러 번 제출되면
- When 여러 resume worker가 동시에 실행되어도
- Then tool handler는 최대 1회만 호출되고 모든 호출자는 같은 completion을 관찰한다.

### AC-11 HITL 거절

- Given pending HITL request에 reject result를 제출하면
- When resume이 실행되면
- Then tool handler는 호출되지 않고 거절 ToolResult가 conversation에 기록된다.

### AC-12 HITL form 입력

- Given form result가 tool args를 변경하도록 mapping되어 있으면
- When resume이 실행되면
- Then 최종 args는 JSON Schema 검증을 다시 통과한 뒤 tool handler에 전달된다.

## 12. 검증 계획

- core unit test로 실행 루프, abort, stream fallback, route priority, state restore를 검증한다.
- createHarness 수준 테스트로 runtime snapshot completeness, conversation isolation, ingress turnId correlation, active-turn steering 경계 조건을 검증한다.
- HITL integration test로 pending 전환, runtime 재생성 후 조회, 승인/거절 resume, concurrent resume race를 검증한다.
- CLI 테스트로 agent 선택, `.env` 우선순위, `--max-steps` override를 검증한다.
- `pnpm -r run typecheck`를 기본 정합성 게이트로 사용한다.

## 13. 알려진 제약

- `api.runtime`은 선언 기반 스냅샷이며 동적으로 등록된 tool은 반영되지 않는다. live registry 확인은 `api.tools.list()`를 사용해야 한다.
- event listener는 비동기 작업을 기다려주지 않는다. 느리거나 중요한 후처리는 별도 큐/로깅 계층에서 처리해야 한다.
- connection extension은 ingress 맥락용이며 conversation mutation 책임은 가지지 않는다.
- system 메시지 선두 보장은 provider별 특례가 아니라 `appendSystem` 이벤트 의미와 conversation 파생 상태 규칙으로 유지한다.
- durable HITL은 core가 특정 저장소를 내장하지 않고 `HitlStore` 계약을 통해 외부 backend나 adapter가 제공한다.

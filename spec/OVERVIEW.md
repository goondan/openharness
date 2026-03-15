# OpenHarness v2 — 상위 스펙

## 한 줄 요약

에이전트 개발자가 LLM 실행 루프의 모든 측면(입력, 행동, 상태, 관측)을 독립적인 Extension 조합으로 제어할 수 있는 순수 barebone composable harness를 구축한다.

---

## 문제 정의 & 배경

### 현 상태 (As-Is)

기존 에이전트 프레임워크들은 "합리적인 기본값"이라는 이름으로 시스템 프롬프트 주입, 대화 기록 관리, 기본 도구 자동 등록 등을 코어에 내장한다. 이 방식은 빠르게 시작하기엔 좋지만, 에이전트의 동작을 세밀하게 제어하려 하면 프레임워크 내부를 뜯어야 한다.

OpenHarness v1은 이 문제를 해결하기 위해 Extension 기반 아키텍처를 도입했으나, YAML 구성 의존, 불명확한 Extension API 경계, 코어와 편의 계층의 혼재 등 실용적 한계가 드러났다.

### Pain Point

1. **실험 비용이 높다** — 압축 전략, 프롬프트 관리, 도구 선택 전략 등을 비교하려면 프레임워크 내부를 이해해야 한다. "한 변수만 바꿔서 실험"이 어렵다.
2. **암묵적 동작이 디버깅을 방해한다** — 코어가 기본 시스템 메시지를 주입하거나, 기본 도구를 자동 등록하면 "이 동작이 내 Extension에서 온 건지 코어에서 온 건지" 판단이 어렵다.
3. **Extension 생태계 부재** — Extension/Tool을 npm 패키지로 만들고 공유하는 표준 경로가 없다.
4. **v1의 YAML + code 이중 구성** — 설정 변경 시 두 곳을 동기화해야 하며, 타입 안전성이 없다.

### 우선순위 근거

순수한 코어 + composable Extension 패턴은 OpenHarness의 존재 이유다. v2는 v1의 개념을 code-first 기반으로 재설계하여 실용적으로 동작하게 만드는 것이 목적이다.

---

## 목표 & 성공 지표

### 목표

| ID | 목표 | 설명 |
|----|------|------|
| G-1 | 순수한 코어 | 코어는 실행 루프, 미들웨어 훅, 이벤트 발행, 대화 상태 인프라만 소유한다. 시스템 프롬프트, 기본 도구, Persistence는 코어에 없다. |
| G-2 | Composable Extension | Extension 조합으로 LLM의 입력, 행동, 상태, 관측을 완전히 제어한다. Extension 교체 = import 한 줄 변경. |
| G-3 | Code-first 구성 | TypeScript 파일 하나(`harness.config.ts`)가 에이전트의 전체 구성. 타입 안전, IDE 자동완성, 매니페스트 이중 관리 제거. |
| G-4 | 플러그인 생태계 | Extension과 Tool은 npm 패키지로 배포. `pnpm add` + `import` + `defineHarness` 선언으로 활성화. |
| G-5 | 명시적 선택 | 암묵적으로 켜지는 것은 없다. 선언한 것이 전부이고, 숨겨진 동작은 없다. |

### 성공 지표

| 지표 | 기준 |
|------|------|
| Extension 교체 비용 | import 한 줄 + 팩토리 호출 변경으로 전략 교체 가능 |
| 코어 표면적 | 코어 패키지에 시스템 프롬프트, 기본 도구, Persistence 코드가 없음 |
| 최소 실행 구성 | model + 1 extension + 0 tools로 Turn 실행 가능 |
| 서드파티 Extension | 코어 포크 없이 npm 패키지만으로 Extension/Tool 배포 가능 |
| 타입 안전성 | Extension config 오류가 `tsc` 시점에 잡힘 |

### Definition of Done

1. `harness.config.ts`에 선언된 구성으로 `oh` CLI와 `createHarness()` 양쪽에서 Turn 실행이 가능하다.
2. Extension 없이 실행하면 LLM에 빈 메시지가 전달된다 (시스템 프롬프트 미주입 증명).
3. base 패키지의 Extension/Tool이 코어 패키지와 독립적으로 빌드된다.
4. 서드파티 Extension npm 패키지를 만들어 `pnpm add` + import + 선언으로 활성화할 수 있다.

---

## 스펙 안정성 분류

| 항목 | 분류 | 근거 |
|------|------|------|
| 코어 실행 루프 (Turn/Step/ToolCall) | **Stable** | v1에서 검증된 모델. 변경 시 전체 Extension 호환성에 영향. |
| 미들웨어 훅 (chain-of-responsibility) | **Stable** | Extension 생태계의 근간. |
| 이벤트 소싱 대화 상태 (events → messages) | **Stable** | 브레인스토밍에서 합의. events만이 원천이고 messages는 파생. |
| ExtensionApi 5개 표면 (pipeline, tools, on, conversation, runtime) | **Stable** | 브레인스토밍에서 합의. |
| 미들웨어 훅 vs 이벤트 구독 분리 | **Stable** | 브레인스토밍에서 합의. 훅은 개입, 이벤트는 관찰. |
| Ingress 4단계 파이프라인 | **Flexible** | 단계 수는 조정 가능. AC를 해치지 않는 범위에서 세분화/병합 허용. |
| CLI 옵션/모드 | **Flexible** | 코어 계약에 영향 없음. 사용성 피드백에 따라 조정 가능. |
| 패키지 구조 (@goondan/* 네이밍) | **Flexible** | 네이밍은 조정 가능. 코어/base 분리 원칙은 Stable. |
| base 패키지 기본 제공 Extension/Tool 목록 | **Flexible** | 추가/제거 가능. 코어에 영향 없음. |

---

## 용어 정의

| 용어 | 정의 |
|------|------|
| **Turn** | 인바운드 메시지 하나에 대한 전체 처리 과정. 최종 응답 또는 에러로 종료된다. |
| **Step** | Turn 안에서 LLM을 한 번 호출하는 단위. LLM이 도구를 요청하면 실행 후 결과를 다시 전달하며, 도구 요청이 없을 때까지 반복한다. |
| **ToolCall** | Step 안에서 실행되는 개별 도구 호출. LLM이 한 번에 여러 도구를 요청할 수 있으므로 한 Step에 여러 ToolCall이 존재할 수 있다. |
| **Extension** | 코어의 미들웨어 훅과 이벤트 구독에 등록되어 동작하는 플러그인. `name` + `register(api)` 인터페이스를 구현한다. |
| **Tool** | LLM이 호출할 수 있는 도구. `name` + `description` + `parameters`(JSON Schema) + `handler` 인터페이스를 구현한다. |
| **Connector** | 외부 이벤트 소스의 페이로드를 검증(verify)하고 InboundEnvelope로 정규화(normalize)하는 어댑터. transport 서버가 아니다. |
| **Connection** | Connector 하나와 라우팅 규칙 집합을 묶는 구성 단위. |
| **InboundEnvelope** | 외부 이벤트를 정규화한 표준 형식. content, properties, conversationId, source, metadata를 포함한다. |
| **Ingress** | 외부 이벤트를 받아서 Turn을 시작시키는 입구. verify → normalize → route → dispatch 4단계 파이프라인. |
| **미들웨어 훅** | 실행 흐름에 **개입**하는 지점. `next()`를 호출하여 다음 단계로 넘기고, 호출 전후로 상태를 변경할 수 있다. `next()`를 호출하지 않으면 실행을 차단할 수 있다. |
| **이벤트 구독** | 실행 흐름을 **관찰만** 하는 표면. 리스너가 에러를 던지거나 오래 걸려도 실행 흐름에 영향을 주지 않는다. |
| **ExtensionApi** | Extension이 코어에 접근하는 5개 표면: pipeline(미들웨어), tools(도구 관리), on(이벤트 구독), conversation(대화 상태), runtime(구성 읽기). |
| **코어** | `@goondan/openharness` 패키지. 실행 루프, 미들웨어 훅, 이벤트 발행, 대화 상태 인프라, 중단 제어만 소유한다. |
| **base** | `@goondan/openharness-base` 패키지. 편의를 위해 기본 제공하는 Extension/Tool 모음. 코어의 일부가 아니다. |
| **events** | 대화 상태의 원천 데이터. 대화에 발생한 모든 변경(append, replace, remove, truncate)의 불변 스트림. |
| **messages** | events를 replay하여 계산된 현재 시점의 메시지 목록. 파생 데이터이므로 읽기 전용. |

---

## 기능 요구사항

### FR-CORE: 코어 실행 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-CORE-001 | Turn → Step → ToolCall 실행 루프를 제공한다. | G-1 |
| FR-CORE-002 | 실행 루프의 세 단계(Turn, Step, ToolCall)에 chain-of-responsibility 미들웨어 훅을 노출한다. | G-1, G-2 |
| FR-CORE-003 | 미들웨어 등록 시 priority를 지정하여 실행 순서를 제어한다. 낮은 값이 먼저 실행된다. | G-2 |
| FR-CORE-004 | 미들웨어에서 `next()`를 호출하지 않으면 실행을 차단할 수 있다. | G-2 |
| FR-CORE-005 | 하나의 AbortSignal이 Turn → Step → ToolCall → LLM 호출까지 전체 체인을 관통한다. | G-1 |
| FR-CORE-006 | `maxSteps` 설정으로 무한 루프를 방지한다. Step 수가 한계에 도달하면 Turn을 종료한다. | G-1 |

### FR-STATE: 대화 상태 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-STATE-001 | 대화 상태를 이벤트 소싱 모델로 관리한다. events가 원천이고 messages는 events를 replay한 파생 데이터다. | G-1 |
| FR-STATE-002 | 이벤트 타입: append(메시지 추가), replace(메시지 교체), remove(메시지 삭제), truncate(초과분 잘라내기). | G-1 |
| FR-STATE-003 | `conversation.events`로 원천 이벤트 스트림에 접근한다. | G-1, G-2 |
| FR-STATE-004 | `conversation.messages`로 현재 시점의 계산된 메시지 목록을 읽기 전용으로 접근한다. | G-1, G-2 |
| FR-STATE-005 | `conversation.restore(events)`로 외부에서 이벤트 스트림을 주입하여 상태를 복원한다. | G-2 |
| FR-STATE-006 | 코어는 Persistence를 제공하지 않는다. Persistence Extension이 없으면 상태는 인메모리에만 존재하며 프로세스 종료 시 소멸한다. | G-1, G-5 |

### FR-OBS: 이벤트 발행 / Observability (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-OBS-001 | 코어는 실행 루프의 주요 시점에서 관측 이벤트를 발행한다. | G-1 |
| FR-OBS-002 | 이벤트 구독(`api.on`)은 미들웨어 훅(`api.pipeline`)과 분리된 별도 표면이다. | G-1, G-2 |
| FR-OBS-003 | 이벤트 리스너가 에러를 던지거나 오래 걸려도 실행 흐름은 영향받지 않는다. 코어가 이를 보장한다. | G-1 |
| FR-OBS-004 | 코어가 발행하는 이벤트: turn.start, turn.done, turn.error, step.start, step.done, tool.start, tool.done, tool.error, ingress.received, ingress.accepted, ingress.rejected. | G-1 |

### FR-EXT: Extension 시스템 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-EXT-001 | Extension은 `{ name: string; register(api: ExtensionApi): void }` 인터페이스를 구현한다. | G-2, G-4 |
| FR-EXT-002 | Extension은 팩토리 함수로 생성한다. 팩토리 함수는 설정을 받아 Extension 객체를 반환한다. | G-2, G-3 |
| FR-EXT-003 | ExtensionApi는 5개 표면을 제공한다: pipeline, tools, on, conversation, runtime. | G-2 |
| FR-EXT-004 | `api.pipeline` — Turn/Step/ToolCall 미들웨어 등록. | G-2 |
| FR-EXT-005 | `api.tools` — 도구 동적 등록/제거/조회. | G-2 |
| FR-EXT-006 | `api.on` — 관찰 전용 이벤트 구독. | G-2 |
| FR-EXT-007 | `api.conversation` — events(원천), messages(파생, 읽기 전용), restore(외부 복원). | G-2 |
| FR-EXT-008 | `api.runtime` — 현재 에이전트 및 전체 런타임 구성 읽기 전용 조회. | G-2 |
| FR-EXT-009 | Extension 자체 상태는 Extension의 책임이다. 코어는 Extension 상태 저장 표면을 제공하지 않는다. | G-1, G-5 |

### FR-TOOL: Tool 시스템 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-TOOL-001 | Tool은 `{ name, description, parameters(JSON Schema), handler }` 인터페이스를 구현한다. | G-2, G-4 |
| FR-TOOL-002 | Tool은 팩토리 함수로 생성한다. | G-3 |
| FR-TOOL-003 | 도구 등록 경로: 정적 선언(`defineHarness`의 `agents.*.tools`)과 동적 등록(`api.tools.register()`). | G-2 |
| FR-TOOL-004 | 코어는 등록된 도구에 대해 JSON Schema 기반 인자 검증을 수행한다. 검증 실패 시 LLM에 에러를 반환한다. | G-1 |
| FR-TOOL-005 | Tool을 선언하지 않으면 도구 없음. 자동으로 추가되는 기본 도구는 없다. | G-5 |
| FR-TOOL-006 | ToolContext에 conversationId, agentName, abortSignal을 전달한다. | G-1 |

### FR-INGRESS: Ingress 파이프라인 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-INGRESS-001 | 외부 이벤트를 4단계 파이프라인(verify → normalize → route → dispatch)으로 처리한다. | G-1 |
| FR-INGRESS-002 | Connector는 transport 서버가 아니라 순수한 정규화 어댑터다. `verify()`와 `normalize()`를 구현한다. | G-1 |
| FR-INGRESS-003 | Connector는 팩토리 함수로 생성한다. | G-3 |
| FR-INGRESS-004 | normalize는 InboundEnvelope 표준 형식을 반환한다. 1:N fan-out을 허용한다(배열 반환). | G-1 |
| FR-INGRESS-005 | Connection은 Connector 하나와 라우팅 규칙 집합을 묶는 구성 단위다. | G-1 |
| FR-INGRESS-006 | 라우팅 규칙은 선언 순서대로 평가하며 first-match-wins다. | G-1 |
| FR-INGRESS-007 | conversationId 해석 우선순위: rule.conversationId > rule.conversationIdProperty+Prefix > envelope.conversationId. 세 값이 모두 없으면 reject한다. | G-1 |
| FR-INGRESS-008 | 4단계 각각에 미들웨어 훅이 있어 Extension이 개입할 수 있다. | G-2 |
| FR-INGRESS-009 | Connection 수준 Extension은 verify/normalize(pre-route), Agent 수준 Extension은 route/dispatch(post-route)에 개입한다. | G-2 |

### FR-CONFIG: 구성 시스템 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-CONFIG-001 | `defineHarness(config)`가 구성 선언의 유일한 진입점이다. 순수한 구성 선언이며 런타임을 생성하지 않는다. | G-3 |
| FR-CONFIG-002 | `harness.config.ts` 파일이 에이전트의 전체 구성을 선언한다. | G-3 |
| FR-CONFIG-003 | `env(name)` 헬퍼로 환경 변수를 참조한다. 런타임 생성 시점에 `process.env`에서 해석된다. | G-3 |
| FR-CONFIG-004 | 모델 프로바이더별 팩토리 함수(Anthropic, OpenAI, Google 등)를 제공한다. | G-3 |
| FR-CONFIG-005 | 복수의 에이전트를 `agents` 맵에 선언할 수 있다. 각 에이전트는 독립적으로 실행된다. | G-1 |

### FR-API: Programmatic API (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-API-001 | `createHarness(config)`가 런타임을 생성한다. | G-3 |
| FR-API-002 | `runtime.processTurn(agentName, input)`으로 Turn을 동기적으로 실행한다. | G-1 |
| FR-API-003 | `runtime.ingress.receive()`로 Connector의 전체 파이프라인을 실행한다. fan-out 결과를 배열로 반환한다. | G-1 |
| FR-API-004 | `runtime.ingress.dispatch()`로 이미 정규화된 InboundEnvelope를 직접 접수한다 (verify/normalize 건너뜀). | G-1 |
| FR-API-005 | `runtime.control.abortConversation()`으로 실행 중인 Turn을 중단한다. | G-1 |
| FR-API-006 | `runtime.close()`로 런타임을 정상 종료한다. | G-1 |
| FR-API-007 | Ingress의 `receive()/dispatch()`는 Turn 완료를 기다리지 않고 accepted handle을 반환한다. Turn은 비동기로 접수된다. | G-1 |

### FR-CLI: CLI (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-CLI-001 | `oh` 또는 `oh repl`로 REPL 모드 진입. | G-3 |
| FR-CLI-002 | `oh run "<text>"`로 단일 Turn 실행. | G-3 |
| FR-CLI-003 | `--workdir`, `--config`, `--agent`, `--conversation`, `--max-steps` 옵션 지원. | G-3 |
| FR-CLI-004 | `--agent`가 없고 에이전트가 1개면 해당 에이전트 선택. 2개 이상이면 에러. | G-3 |
| FR-CLI-005 | `workdir/.env`가 존재하면 읽어서 `process.env`와 merge. `process.env`가 우선한다. | G-3 |

### FR-PKG: 패키지 구조 (Committed)

| ID | 요구사항 | 목표 |
|----|---------|------|
| FR-PKG-001 | `@goondan/openharness-types` — 순수 타입 정의. 런타임 의존성 제로. | G-4 |
| FR-PKG-002 | `@goondan/openharness` — 코어. types에만 의존. | G-1 |
| FR-PKG-003 | `@goondan/openharness-cli` — CLI. core에 의존. | G-3 |
| FR-PKG-004 | `@goondan/openharness-base` — 기본 Extension/Tool. types에만 의존. | G-1, G-4 |
| FR-PKG-005 | base의 Extension/Tool은 코어와 독립적으로 빌드된다. | G-1 |
| FR-PKG-006 | 서드파티 Extension/Tool은 types에만 의존하여 구현할 수 있다. | G-4 |

---

## 비기능 요구사항

| ID | 영역 | 요구사항 | 검증 방법 |
|----|------|---------|----------|
| NFR-001 | 타입 안전성 | Extension/Tool의 config 오류가 `tsc --noEmit` 시점에 잡힌다. | tsc 실행으로 검증 |
| NFR-002 | 관측 격리 | 이벤트 리스너(`api.on`)의 예외/지연이 실행 루프에 영향을 주지 않는다. | 고의 예외/무한루프 리스너 테스트 |
| NFR-003 | Extension 격리 | 하나의 Extension 에러가 다른 Extension에 전파되지 않는다 (미들웨어 체인에서의 에러 핸들링 정책). | 에러 주입 테스트 |
| NFR-004 | 종료 안정성 | `runtime.close()`가 진행 중인 Turn을 abort 후 리소스를 정리한다. | 통합 테스트 |
| NFR-005 | 최소 의존성 | 코어 패키지(`@goondan/openharness`)의 런타임 의존성을 최소화한다. | package.json 검토 |

---

## 수용 기준

### AC-1: 최소 실행

- **Given** harness.config.ts에 model과 Extension 1개(ContextMessage)가 선언되어 있고, Tool은 선언하지 않았다.
- **When** `oh run "hello"`를 실행한다.
- **Then** LLM이 시스템 프롬프트와 사용자 메시지를 받아 텍스트 응답을 반환한다. 도구 없이 순수 텍스트 대화만 진행된다.

### AC-2: 명시적 선택 원칙 (Extension 없음)

- **Given** harness.config.ts에 model만 선언하고, Extension과 Tool을 선언하지 않았다.
- **When** `processTurn("assistant", "hello")`를 실행한다.
- **Then** LLM에 시스템 프롬프트가 전달되지 않고, 도구도 없다. 빈 컨텍스트에서 Turn이 실행된다.

### AC-3: Extension 교체

- **Given** MessageWindow Extension을 사용하는 구성이 있다.
- **When** MessageWindow를 CompactionSummarize로 교체한다 (import 한 줄 + 팩토리 호출 변경).
- **Then** 나머지 구성(model, 다른 Extension, Tool)은 변경 없이, 대화 압축 전략만 바뀐다.

### AC-4: 이벤트 소싱 상태

- **Given** 여러 Turn을 실행하여 events가 쌓인 상태다.
- **When** `conversation.events`를 읽어 새로운 대화에 `conversation.restore(events)`한다.
- **Then** `conversation.messages`가 원래 대화와 동일한 메시지 목록을 반환한다.

### AC-5: Persistence Extension

- **Given** Persistence Extension이 선언된 구성에서 3회 Turn을 실행했다.
- **When** 프로세스를 재시작하고 같은 conversationId로 Turn을 실행한다.
- **Then** 이전 3회의 대화 기록이 복원된 상태에서 Turn이 진행된다.

### AC-6: Persistence Extension 없음

- **Given** Persistence Extension을 선언하지 않은 구성에서 3회 Turn을 실행했다.
- **When** 프로세스를 재시작하고 같은 conversationId로 Turn을 실행한다.
- **Then** 이전 대화 기록이 없는 상태에서 Turn이 시작된다.

### AC-7: Observability 격리

- **Given** `api.on("turn.done", () => { throw new Error("boom") })`를 등록한 Extension이 있다.
- **When** Turn을 실행한다.
- **Then** Turn은 정상 완료되고, 리스너 에러는 실행 흐름에 영향을 주지 않는다.

### AC-8: 미들웨어 차단

- **Given** ToolCall 미들웨어에서 특정 도구 호출 시 `next()`를 호출하지 않고 에러를 반환하는 Extension이 있다.
- **When** LLM이 해당 도구를 호출한다.
- **Then** 도구 실행이 차단되고 LLM에 에러가 반환된다.

### AC-9: Ingress 파이프라인

- **Given** SlackConnector와 라우팅 규칙이 선언된 Connection이 있다.
- **When** `runtime.ingress.receive({ connectionName: "slack-main", payload: rawSlackBody })`를 호출한다.
- **Then** verify → normalize → route → dispatch가 순서대로 실행되고, 매칭된 에이전트에 Turn이 비동기로 접수된다.

### AC-10: Ingress conversationId 해석

- **Given** 라우팅 규칙에 conversationIdProperty: "channel"이 설정되어 있다.
- **When** envelope.properties에 channel: "C123"이 있는 이벤트가 도착한다.
- **Then** conversationId가 "C123"으로 해석되어 해당 대화에 Turn이 접수된다.

### AC-11: Ingress conversationId 부재

- **Given** 라우팅 규칙에 conversationId 관련 설정이 없고, Connector도 conversationId를 설정하지 않았다.
- **When** 이벤트가 도착한다.
- **Then** reject된다.

### AC-12: Runtime introspection

- **Given** 2개 Extension과 3개 Tool이 선언된 에이전트가 있다.
- **When** Extension 내에서 `api.runtime.agent`를 조회한다.
- **Then** 현재 에이전트의 이름, 모델 정보, Extension 2개, Tool 3개가 구조화된 데이터로 반환된다.

### AC-13: 중단 제어

- **Given** 장시간 실행되는 Tool이 있는 Turn이 진행 중이다.
- **When** `runtime.control.abortConversation({ conversationId: "xxx" })`를 호출한다.
- **Then** AbortSignal이 전파되어 Turn, 현재 Step, 현재 ToolCall이 중단된다.

### AC-14: 서드파티 Extension 배포

- **Given** `@goondan/openharness-types`에만 의존하는 npm 패키지로 Extension을 구현했다.
- **When** 사용자가 `pnpm add @someone/my-extension` 후 harness.config.ts에 import + 선언한다.
- **Then** 코어 포크 없이 Extension이 정상 동작한다.

---

## 범위 경계 (Non-goals)

### Never (절대 하지 않을 것)

| 항목 | 근거 |
|------|------|
| 코어의 암묵적 Tool/Extension 활성화 | G-5 (명시적 선택 원칙) 위배 |
| 코어의 fallback 시스템/사용자 메시지 주입 | G-1 (순수한 코어) 위배 |
| Persistence를 코어 관심사로 편입 | 브레인스토밍 합의: Extension 책임 |

### 이번 범위 밖 (차기 후보)

| 항목 | 근거 |
|------|------|
| 멀티 에이전트 오케스트레이션 (에이전트 간 호출/위임) | 별도 프로젝트로 분리. 브레인스토밍 합의. |
| Transport 서버 퍼스트파티 구현 (Slack/Telegram/Webhook 서버) | Connector는 정규화 어댑터만. transport는 외부 호스트 책임. |
| Outbound 공통 포트 (채널별 응답 표준화) | 채널별 응답은 Tool/Extension 책임. 표준화는 생태계 성숙 후 검토. |
| Streaming/SSE 응답 | v2 MVP 이후 검토. 코어의 Turn 모델 확장 필요. |

---

## 제약 & 가정

### 제약

| ID | 제약 | 영향 |
|----|------|------|
| C-1 | Node.js 런타임 전제 (TypeScript + ESM) | 브라우저, Deno, Bun은 v2 범위 밖 |
| C-2 | LLM 프로바이더 SDK 의존 | model 팩토리는 각 프로바이더 SDK를 래핑. SDK 변경 시 팩토리 업데이트 필요. |
| C-3 | npm 레지스트리 의존 | Extension/Tool 배포에 npm 레지스트리를 사용. 프라이빗 레지스트리도 가능. |

### 가정

| ID | 가정 | 검증 시점 |
|----|------|----------|
| A-1 | Extension 개발자가 TypeScript에 익숙하다. | Extension 온보딩 테스트 시 |
| A-2 | Connector의 verify/normalize가 동기적으로 빠르게 완료된다. | Ingress 성능 테스트 시 |
| A-3 | 대부분의 사용 사례에서 에이전트 수가 10개 미만이다. | 구성 로딩 성능 테스트 시 |

---

## 리스크 & 완화책

| ID | 리스크 | 발생 가능성 | 임팩트 | 완화 | 조기 신호 |
|----|--------|-----------|--------|------|----------|
| R-1 | Extension 간 미들웨어 순서 충돌 (priority 겹침) | 중 | 중 | priority 가이드라인 문서화. 같은 priority일 때 등록 순서(선언 순서) 기반 결정. | 커뮤니티 Extension에서 priority 충돌 이슈 리포트 |
| R-2 | 이벤트 소싱 상태에서 events 무한 증가 | 중 | 중 | Compaction Extension이 오래된 events를 체크포인트로 압축하는 패턴 안내. 코어는 개입하지 않음. | 단일 대화 events > 10,000개 |
| R-3 | Observability 이벤트 리스너가 GC를 지연시킴 | 낮 | 낮 | 리스너는 fire-and-forget. 코어가 리스너 완료를 await하지 않음. | 프로파일링에서 GC pause 증가 |
| R-4 | 서드파티 Extension이 코어 내부에 의존 | 중 | 높 | types 패키지만으로 Extension 구현 가능한 구조 유지. 코어 내부 export 최소화. | types 외 코어 import가 Extension에서 발견됨 |

---

## 검증 계획

| 대상 | 검증 방법 | 성공 기준 |
|------|----------|----------|
| 코어 실행 루프 | 유닛 테스트: Turn/Step/ToolCall 사이클, maxSteps 초과, AbortSignal | 모든 AC 통과 |
| 미들웨어 훅 | 유닛 테스트: priority 순서, next() 미호출 차단, 에러 전파 | AC-8 통과 |
| 이벤트 소싱 | 유닛 테스트: events → messages replay, restore, 이벤트 타입별 동작 | AC-4 통과 |
| Observability 격리 | 유닛 테스트: 리스너 예외가 Turn 결과에 영향 없음 | AC-7 통과 |
| Ingress 파이프라인 | 유닛 테스트: 4단계 순서, fan-out, conversationId 해석, reject | AC-9~11 통과 |
| Extension 생태계 | 통합 테스트: types만 의존하는 서드파티 Extension이 코어에서 동작 | AC-14 통과 |
| Persistence | 통합 테스트: 프로세스 재시작 후 상태 복원 | AC-5, AC-6 통과 |
| 명시적 선택 | 통합 테스트: Extension/Tool 미선언 시 빈 컨텍스트 확인 | AC-2 통과 |
| CLI | E2E 테스트: `oh run`, `oh repl`, 각 옵션 동작 | FR-CLI-* 충족 |
| 타입 안전성 | `tsc --noEmit` 통과 | NFR-001 충족 |

---

## 상세 스펙 목차

| 파일 | 도메인 | 관련 FR |
|------|--------|---------|
| `spec/core/execution-loop.md` | 코어 실행 루프, 미들웨어, 중단, Observability | FR-CORE-*, FR-OBS-* |
| `spec/core/conversation-state.md` | 이벤트 소싱 대화 상태 | FR-STATE-* |
| `spec/core/extension-system.md` | Extension 구조, ExtensionApi, Tool 시스템 | FR-EXT-*, FR-TOOL-* |
| `spec/ingress/ingress-pipeline.md` | Ingress 4단계, Connector, Connection, 라우팅 | FR-INGRESS-* |
| `spec/surface/configuration-api.md` | defineHarness, createHarness, Runtime API, CLI, 패키지 구조 | FR-CONFIG-*, FR-API-*, FR-CLI-*, FR-PKG-* |

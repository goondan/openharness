# configuration-api — defineHarness, createHarness, Runtime API, CLI, 패키지 구조

## 1. 한 줄 요약

사용자가 `harness.config.ts`에 code-first로 에이전트를 구성하고, `createHarness()`로 런타임을 생성하며, `oh` CLI 또는 Programmatic API로 실행한다.

---

## 2. 상위 스펙 연결

- **Related Goals:** G-1 (순수한 코어), G-3 (Code-first), G-4 (플러그인 생태계)
- **Related Requirements:** FR-CONFIG-001~005, FR-API-001~007, FR-CLI-001~005, FR-PKG-001~006
- **Related AC:** AC-1, AC-3, AC-14

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: CONFIG-DEFINE-01 — 구성 선언

- **Actor:** 사용자 (개발자)
- **Trigger:** `harness.config.ts` 파일 작성
- **Preconditions:**
  - `@goondan/openharness` 패키지가 설치되어 있다.
- **Main Flow:**
  1. 사용자가 `defineHarness(config)`를 호출하는 TypeScript 파일을 작성한다.
  2. config에 agents, connections를 선언한다.
  3. 각 agent에 model, extensions, tools를 선언한다.
  4. `export default defineHarness(config)`로 내보낸다.
- **Alternative Flow:**
  - 타입 오류가 있으면 `tsc` 시점에 잡힌다.
- **Outputs:** HarnessConfig 객체.
- **Side Effects:** 없음 (순수한 구성 선언).
- **Failure Modes:**
  - 타입 오류: tsc 에러.

#### Flow ID: CONFIG-CREATE-01 — 런타임 생성

- **Actor:** 사용자 코드 또는 CLI
- **Trigger:** `createHarness(config)` 호출
- **Preconditions:**
  - config가 유효한 HarnessConfig다.
- **Main Flow:**
  1. config의 각 agent에 대해:
     - Model 팩토리를 해석하여 LLM 클라이언트를 생성한다.
     - Extension을 선언 순서대로 등록한다 (EXT-REGISTER-01).
     - Tool을 등록한다 (EXT-TOOL-STATIC-01).
  2. config의 각 connection에 대해:
     - Connector를 등록한다.
     - Connection 수준 Extension을 등록한다.
     - 라우팅 규칙을 로드한다.
  3. `env()` 참조를 `process.env`에서 해석한다.
  4. HarnessRuntime 객체를 반환한다.
- **Alternative Flow:**
  - env() 참조가 process.env에 없는 경우: 런타임 생성 에러.
  - Extension/Tool 등록 실패: 런타임 생성 에러.
  - 중복 에이전트 이름: 런타임 생성 에러.
- **Outputs:** HarnessRuntime
- **Failure Modes:**
  - 환경 변수 미설정: 명확한 에러 메시지와 함께 실패.
  - Extension.register 예외: 런타임 생성 실패.

#### Flow ID: CONFIG-CLI-RUN-01 — CLI 단일 실행

- **Actor:** 사용자 (터미널)
- **Trigger:** `oh run "<text>"` 명령 실행
- **Preconditions:**
  - 현재 디렉토리(또는 --workdir)에 harness.config.ts가 존재한다.
- **Main Flow:**
  1. workdir/.env가 존재하면 로드하여 process.env와 merge (process.env 우선).
  2. harness.config.ts를 로드한다 (또는 --config 경로).
  3. `createHarness(config)`로 런타임을 생성한다.
  4. 에이전트를 선택한다:
     - `--agent`가 있으면 해당 에이전트.
     - 없고 에이전트가 1개면 그 에이전트.
     - 없고 2개 이상이면 에러.
  5. `runtime.processTurn(agentName, text)`를 실행한다.
  6. 결과 텍스트를 stdout에 출력한다.
  7. `runtime.close()`를 호출한다.
- **Outputs:** stdout에 Turn 결과 텍스트.
- **Failure Modes:**
  - config 파일 미발견: 에러 메시지.
  - 에이전트 선택 불가: 에러 메시지.

#### Flow ID: CONFIG-CLI-REPL-01 — CLI REPL 모드

- **Actor:** 사용자 (터미널)
- **Trigger:** `oh` 또는 `oh repl` 명령 실행
- **Preconditions:**
  - harness.config.ts가 존재한다.
- **Main Flow:**
  1. CONFIG-CLI-RUN-01의 1~4 단계와 동일하게 런타임 생성 + 에이전트 선택.
  2. readline 프롬프트를 시작한다.
  3. 사용자 입력마다 `processTurn()`을 실행하고 결과를 출력한다.
  4. 같은 conversationId를 유지한다 (--conversation이 있으면 해당 값, 없으면 자동 생성).
  5. 사용자가 종료 신호(Ctrl+C, exit)를 보내면 `runtime.close()`를 호출한다.
- **Outputs:** 대화형 세션.

#### Flow ID: CONFIG-CLOSE-01 — 런타임 종료

- **Actor:** 사용자 코드 또는 CLI
- **Trigger:** `runtime.close()` 호출
- **Preconditions:**
  - HarnessRuntime이 활성 상태다.
- **Main Flow:**
  1. 진행 중인 모든 Turn에 AbortSignal을 발행한다.
  2. Turn들이 abort로 종료되기를 기다린다 (타임아웃 있음).
  3. LLM 클라이언트 연결을 정리한다.
  4. 런타임을 종료 상태로 전이한다. 이후 processTurn/ingress 호출은 에러를 반환한다.
- **Outputs:** void (Promise)
- **Failure Modes:**
  - 타임아웃 내에 Turn이 종료되지 않으면: 강제 종료 후 경고 로그.

---

## 4. Constraint Specification

### Constraint ID: CONFIG-CONST-001 — defineHarness는 순수 선언

- **Category:** 아키텍처
- **Description:** `defineHarness(config)`는 config 객체를 그대로 반환하는 identity 함수다. 런타임을 생성하거나, I/O를 수행하거나, 환경 변수를 해석하지 않는다.
- **Scope:** CONFIG-DEFINE-01
- **Measurement:** defineHarness 함수가 부수효과 없음을 확인.
- **Verification:** defineHarness의 구현이 `return config`와 동등함을 검증.

### Constraint ID: CONFIG-CONST-002 — env()는 지연 해석

- **Category:** 동작 보장
- **Description:** `env(name)` 헬퍼는 구성 선언 시점이 아니라 `createHarness()` 호출 시점에 `process.env`에서 해석된다.
- **Scope:** CONFIG-CREATE-01
- **Measurement:** defineHarness 호출 시 env가 해석되지 않고, createHarness 호출 시 해석됨.
- **Verification:** defineHarness 후 process.env를 변경하고 createHarness에서 새 값이 반영됨을 확인.

### Constraint ID: CONFIG-CONST-003 — .env 로딩 우선순위

- **Category:** 동작 보장
- **Description:** `.env` 파일의 값보다 `process.env`의 기존 값이 우선한다 (기존 환경 변수를 덮어쓰지 않는다).
- **Scope:** CONFIG-CLI-RUN-01, CONFIG-CLI-REPL-01
- **Measurement:** process.env에 이미 있는 키가 .env로 덮어쓰이지 않음.
- **Verification:** 유닛 테스트.

### Constraint ID: CONFIG-CONST-004 — 코어/base 패키지 분리

- **Category:** 아키텍처
- **Description:** `@goondan/openharness` (코어)에 시스템 프롬프트, 기본 도구, Persistence 코드가 없다. 이것들은 `@goondan/openharness-base`에 있다. base는 코어에 의존하지 않고 types에만 의존한다.
- **Scope:** FR-PKG-001~006
- **Measurement:** 패키지 간 의존성 그래프 검사.
- **Verification:** base의 package.json에 core가 없음을 확인.

### Constraint ID: CONFIG-CONST-005 — 서드파티 Extension은 types에만 의존

- **Category:** 생태계
- **Description:** 서드파티 Extension/Tool은 `@goondan/openharness-types`에만 의존하여 구현할 수 있다. 코어 패키지의 내부 API에 의존하지 않는다.
- **Scope:** FR-PKG-006
- **Measurement:** types만 import하는 Extension이 정상 동작.
- **Verification:** AC-14.

---

## 5. Interface Specification

### 5.1 defineHarness 계약

```ts
function defineHarness(config: HarnessConfig): HarnessConfig;

interface HarnessConfig {
  agents: Record<string, AgentConfig>;
  connections?: Record<string, ConnectionConfig>;
}

interface AgentConfig {
  model: ModelConfig;
  extensions?: Extension[];
  tools?: ToolDefinition[];
  maxSteps?: number;      // Step 무한루프 방지. 기본값: 구현에서 정의.
  systemPrompt?: string;  // ContextMessage Extension이 사용.
}
```

### 5.2 createHarness 계약

```ts
function createHarness(config: HarnessConfig): Promise<HarnessRuntime>;
```

### 5.3 HarnessRuntime 계약

```ts
interface HarnessRuntime {
  processTurn(agentName: string, input: string): Promise<TurnResult>;
  ingress: IngressApi;
  control: ControlApi;
  close(): Promise<void>;
}

interface ControlApi {
  abortConversation(input: {
    conversationId: string;
    agentName?: string;
    reason?: string;
  }): Promise<AbortResult>;
}

interface AbortResult {
  conversationId: string;
  abortedTurns: number;
  reason?: string;
}
```

### 5.4 env 헬퍼

```ts
function env(name: string): EnvRef;  // 지연 해석 참조 객체
```

### 5.5 Model 팩토리

```ts
// @goondan/openharness/models에서 export

function Anthropic(config: {
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
}): ModelConfig;

function OpenAI(config: {
  model: string;
  apiKey: string | EnvRef;
  baseUrl?: string;
}): ModelConfig;

function Google(config: {
  model: string;
  apiKey: string | EnvRef;
}): ModelConfig;
```

### 5.6 CLI 인터페이스

```
oh                          → REPL 모드
oh repl                     → REPL 모드 (명시적)
oh run "<text>"             → 단일 Turn 실행

옵션:
  --workdir <path>          작업 디렉토리 (기본: cwd)
  --config <file>           구성 파일 경로 (기본: harness.config.ts)
  --agent <name>            에이전트 선택
  --conversation <key>      대화 ID
  --max-steps <n>           최대 Step 수 (AgentConfig.maxSteps 오버라이드)

종료 코드:
  0  성공
  1  런타임 에러 (config 로드 실패, 환경 변수 미설정 등)
  2  사용법 오류 (잘못된 인자)
```

### 5.7 패키지 구조

```
@goondan/openharness-types       순수 타입 정의. 런타임 의존성 제로.
        ↑
@goondan/openharness             코어: 실행 루프, 레지스트리, 미들웨어 훅, 이벤트 발행
        ↑
@goondan/openharness-cli         CLI 도구 (oh 명령어)

@goondan/openharness-types
        ↑
@goondan/openharness-base        기본 제공 Extension/Tool
```

의존성 규칙:
- core → types (O)
- cli → core (O)
- base → types (O)
- base → core (X, 금지)
- third-party → types (O)
- third-party → core (X, 비권장. types만으로 구현 가능해야 함)

---

## 6. Realization Specification

- **Module Boundaries:**
  - `defineHarness`: types 패키지에 위치 (identity 함수).
  - `createHarness`: 코어 패키지에 위치. 구성 해석, Extension/Tool 등록, 런타임 생성.
  - `oh` CLI: cli 패키지에 위치. config 로드, .env 처리, REPL/run 모드.
- **Data Ownership:**
  - HarnessConfig: 사용자 소유. createHarness에 전달 후 코어가 소비.
  - HarnessRuntime: 코어 소유. 사용자는 인터페이스를 통해 접근.
- **Failure Handling:**
  - config 오류: createHarness에서 명확한 에러 메시지와 함께 실패.
  - env() 미해석: createHarness에서 "환경 변수 {name}이 설정되지 않았습니다" 에러.
  - close() 타임아웃: 경고 로그 후 강제 종료.

---

## 7. Dependency Map

- **Depends On:** `@goondan/openharness-types` (모든 타입), execution-loop.md (Turn 실행), extension-system.md (Extension 등록), ingress-pipeline.md (Ingress 등록), conversation-state.md (대화 상태)
- **Blocks:** 없음 (최상위 조립 계층)
- **Parallelizable With:** 없음 (다른 모듈이 완성된 후 통합)

---

## 8. Acceptance Criteria

- **Given** harness.config.ts에 model + ContextMessage + 0 tools가 선언된 상태에서, **When** `oh run "hello"`를 실행하면, **Then** LLM이 시스템 프롬프트와 사용자 메시지를 받아 텍스트 응답을 반환한다. (AC-1)
- **Given** MessageWindow를 CompactionSummarize로 교체한 상태에서, **When** Turn을 실행하면, **Then** 나머지 구성은 변경 없이 압축 전략만 바뀐다. (AC-3)
- **Given** types에만 의존하는 Extension npm 패키지를 만들어 import + 선언한 상태에서, **When** Turn을 실행하면, **Then** 정상 동작한다. (AC-14)
- **Given** process.env에 KEY=A가 설정되고 .env에 KEY=B가 있는 상태에서, **When** CLI가 .env를 로드하면, **Then** KEY의 값은 A다 (process.env 우선).
- **Given** defineHarness 후 createHarness 전에 process.env.API_KEY를 설정한 상태에서, **When** createHarness를 호출하면, **Then** env("API_KEY")가 해당 값으로 해석된다.
- **Given** agents에 2개 에이전트가 선언되고 --agent 없이 `oh run`을 실행하면, **When** 에이전트 선택 시, **Then** 에러가 발생한다.
- **Given** 런타임이 활성 상태에서 `runtime.close()`를 호출하면, **When** 이후 `processTurn()`을 호출하면, **Then** 에러가 발생한다.

# extension-system — Extension 구조, ExtensionApi, Tool 시스템

## 1. 한 줄 요약

Extension과 Tool이 표준 인터페이스(팩토리 함수 + register/handler)를 통해 코어에 등록되고, ExtensionApi의 5개 표면으로 코어의 모든 확장 지점에 접근한다.

---

## 2. 상위 스펙 연결

- **Related Goals:** G-1 (순수한 코어), G-2 (Composable Extension), G-3 (Code-first), G-4 (플러그인 생태계), G-5 (명시적 선택)
- **Related Requirements:** FR-EXT-001~009, FR-TOOL-001~006
- **Related AC:** AC-2, AC-3, AC-12, AC-14

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: EXT-REGISTER-01 — Extension 등록

- **Actor:** 코어 런타임 (createHarness 시)
- **Trigger:** `createHarness(config)` 호출 시 config.agents.*.extensions 순회
- **Preconditions:**
  - Extension 객체가 `{ name: string; register(api: ExtensionApi): void }` 인터페이스를 만족한다.
- **Main Flow:**
  1. 선언 순서대로 Extension을 순회한다.
  2. 각 Extension에 대해 해당 에이전트 스코프의 ExtensionApi 인스턴스를 생성한다.
  3. `extension.register(api)`를 호출한다.
  4. Extension이 register 내에서 api.pipeline, api.tools, api.on 등에 등록한다.
- **Alternative Flow:**
  - register에서 예외 발생: 해당 Extension 등록 실패. 런타임 생성 에러로 전파.
  - 같은 name의 Extension이 중복 선언된 경우: 런타임 생성 에러.
- **Outputs:** Extension이 등록된 런타임.
- **Failure Modes:**
  - register 예외: 런타임 생성 실패. 부분 등록 상태를 남기지 않는다.

#### Flow ID: EXT-TOOL-STATIC-01 — 정적 Tool 등록

- **Actor:** 코어 런타임 (createHarness 시)
- **Trigger:** `createHarness(config)` 호출 시 config.agents.*.tools 순회
- **Preconditions:**
  - Tool 객체가 `{ name, description, parameters, handler }` 인터페이스를 만족한다.
- **Main Flow:**
  1. 선언 순서대로 Tool을 순회한다.
  2. 각 Tool의 parameters(JSON Schema)를 검증한다.
  3. Tool Registry에 등록한다.
- **Alternative Flow:**
  - JSON Schema가 유효하지 않은 경우: 런타임 생성 에러.
  - 같은 name의 Tool이 중복 선언된 경우: 런타임 생성 에러.
- **Outputs:** Tool이 등록된 런타임.

#### Flow ID: EXT-TOOL-DYNAMIC-01 — 동적 Tool 등록/제거

- **Actor:** Extension (런타임 중)
- **Trigger:** `api.tools.register(tool)` 또는 `api.tools.remove(name)` 호출
- **Preconditions:**
  - Extension이 register 시 또는 미들웨어 실행 중 호출한다.
- **Main Flow (register):**
  1. Tool의 parameters를 검증한다.
  2. Tool Registry에 추가한다.
  3. 이후 LLM 호출 시 해당 도구가 사용 가능하다.
- **Main Flow (remove):**
  1. 해당 name의 Tool을 Registry에서 제거한다.
  2. 이후 LLM 호출 시 해당 도구가 사용 불가능하다.
- **Alternative Flow:**
  - 이미 존재하는 name으로 register: 에러 (덮어쓰기 금지).
  - 존재하지 않는 name으로 remove: 에러.
- **Outputs:** 갱신된 Tool Registry.

#### Flow ID: EXT-TOOL-EXEC-01 — Tool 실행

> 상세 흐름은 `execution-loop.md`의 **EXEC-TOOLCALL-01**을 참조한다. 여기서는 Tool 시스템 관점의 요약만 기술한다.

- **Actor:** 코어 런타임 (ToolCall 시)
- **Trigger:** LLM이 도구 호출을 요청
- **Main Flow:** JSON Schema 검증 → ToolCall 미들웨어 체인 → `tool.handler(args, toolContext)` 호출 → 결과 반환. (상세: EXEC-TOOLCALL-01)
- **Failure Modes:** 검증 실패/핸들러 예외 시 LLM에 에러 반환. Turn은 계속.

---

## 4. Constraint Specification

### Constraint ID: EXT-CONST-001 — Extension 인터페이스 불변

- **Category:** API 안정성
- **Description:** Extension 인터페이스는 `{ name: string; register(api: ExtensionApi): void }`만이다. 추가 필드(lifecycle hooks 등)를 코어가 요구하지 않는다.
- **Scope:** 전체
- **Measurement:** 코어가 Extension 객체에서 name, register 외 필드에 접근하지 않음.
- **Verification:** 코드 리뷰 + 타입 검사.

### Constraint ID: EXT-CONST-002 — ExtensionApi 5개 표면

- **Category:** API 안정성
- **Description:** ExtensionApi는 정확히 5개 표면(pipeline, tools, on, conversation, runtime)을 제공한다. 추가 표면을 도입하면 Stable 항목 변경에 해당.
- **Scope:** 전체
- **Measurement:** ExtensionApi 타입 정의 검사.
- **Verification:** 타입 정의 리뷰.

### Constraint ID: EXT-CONST-003 — Tool 이름 유일성

- **Category:** 동작 보장
- **Description:** Tool Registry에 같은 이름의 도구가 두 개 이상 존재할 수 없다. 정적 선언과 동적 등록 모두에 적용.
- **Scope:** EXT-TOOL-STATIC-01, EXT-TOOL-DYNAMIC-01
- **Measurement:** 중복 이름 등록 시 에러 발생 테스트.
- **Verification:** 유닛 테스트.

### Constraint ID: EXT-CONST-004 — Extension 자체 상태는 Extension 책임

- **Category:** 아키텍처
- **Description:** 코어는 Extension 상태 저장을 위한 별도 표면을 제공하지 않는다. Extension이 자체 상태(예: 압축 횟수, 캐시)를 유지해야 하면 자체적으로 관리한다.
- **Scope:** 전체
- **Measurement:** ExtensionApi에 상태 저장 관련 메서드가 없음.
- **Verification:** 타입 정의 검사.

### Constraint ID: EXT-CONST-005 — 명시적 선택

- **Category:** 아키텍처
- **Description:** Tool을 선언하지 않으면 도구 없음. Extension을 선언하지 않으면 확장 없음. 코어가 자동으로 추가하는 기본 Tool/Extension은 없다.
- **Scope:** 전체
- **Measurement:** 빈 extensions/tools 배열로 실행 시 카탈로그가 비어있는 테스트.
- **Verification:** AC-2 테스트.

---

## 5. Interface Specification

### 5.1 Extension 인터페이스

```ts
interface Extension {
  name: string;
  register(api: ExtensionApi): void;
}
```

### 5.2 ExtensionApi

```ts
interface ExtensionApi {
  // 1. 미들웨어 훅 등록
  pipeline: {
    // 실행 미들웨어
    register(level: "turn", handler: TurnMiddleware, options?: MiddlewareOptions): void;
    register(level: "step", handler: StepMiddleware, options?: MiddlewareOptions): void;
    register(level: "toolCall", handler: ToolCallMiddleware, options?: MiddlewareOptions): void;
    // Ingress 미들웨어 (Connection 수준 Extension: ingress, Agent 수준 Extension: route)
    register(level: "ingress", handler: IngressMiddleware, options?: MiddlewareOptions): void;
    register(level: "route", handler: RouteMiddleware, options?: MiddlewareOptions): void;
  };

  // 2. 도구 동적 관리
  tools: {
    register(tool: ToolDefinition): void;
    remove(name: string): void;
    list(): readonly ToolDefinition[];
  };

  // 3. 이벤트 구독 (관찰 전용)
  on(event: string, listener: (payload: EventPayload) => void): void;

  // 4. 대화 상태 접근 (현재 Turn에 바인딩된 프록시. emit()은 Turn 실행 중에서만 호출 가능.)
  conversation: ConversationState;

  // 5. 런타임 구성 읽기 (읽기 전용)
  runtime: RuntimeInfo;
}
```

### 5.3 RuntimeInfo (읽기 전용)

```ts
interface RuntimeInfo {
  // 현재 에이전트의 구성
  agent: {
    name: string;
    model: ModelInfo;
    extensions: readonly ExtensionInfo[];
    tools: readonly ToolInfo[];
    maxSteps?: number;
  };

  // 전체 에이전트 목록
  agents: Readonly<Record<string, AgentInfo>>;

  // 전체 Connection 목록
  connections: Readonly<Record<string, ConnectionInfo>>;
}

interface ModelInfo {
  provider: string;  // "anthropic" | "openai" | "google" | ...
  model: string;     // "claude-sonnet-4-20250514" 등
}

interface ExtensionInfo {
  name: string;
}

interface ToolInfo {
  name: string;
  description: string;
}

interface AgentInfo {
  name: string;
  model: ModelInfo;
  extensionCount: number;
  toolCount: number;
}

interface ConnectionInfo {
  name: string;
  connectorName: string;
  ruleCount: number;
}
```

### 5.4 ToolDefinition

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  conversationId: string;
  agentName: string;
  abortSignal: AbortSignal;
}

type ToolResult =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "error"; error: string };
```

---

## 6. Realization Specification

- **Module Boundaries:**
  - Extension 등록/관리: 코어 패키지의 extension 모듈.
  - Tool Registry: 코어 패키지의 tool 모듈.
  - ExtensionApi: 코어 패키지에서 에이전트 스코프로 생성하는 facade.
- **Data Ownership:**
  - Tool Registry: 에이전트당 하나. 정적 선언과 동적 등록 모두 같은 Registry에 반영.
  - ExtensionApi: 에이전트당, Extension당 하나의 인스턴스. 같은 에이전트의 Extension들은 같은 pipeline/tools/conversation을 공유.
- **State Model:**
  - Extension 등록: createHarness 시 1회. 등록 후 Extension 목록은 변경 불가.
  - Tool Registry: 런타임 중 동적 변경 가능 (api.tools.register/remove).
- **Failure Handling:**
  - Extension.register 예외: 런타임 생성 실패. 롤백 (부분 등록 상태 불허).
  - Tool 핸들러 예외: LLM에 에러 반환. Turn 계속.
  - JSON Schema 검증 실패: LLM에 에러 반환. 핸들러 미호출.

---

## 7. Dependency Map

- **Depends On:** `@goondan/openharness-types` (Extension, ToolDefinition, ExtensionApi 타입), execution-loop.md (미들웨어 실행), conversation-state.md (api.conversation)
- **Blocks:** 없음 (이 모듈은 다른 모듈에서 의존하는 중심 모듈)
- **Parallelizable With:** ingress-pipeline.md

---

## 8. Acceptance Criteria

- **Given** 2개 Extension과 3개 Tool이 선언된 에이전트에서, **When** Extension 내에서 `api.runtime.agent`를 조회하면, **Then** extensions 2개, tools 3개가 구조화된 데이터로 반환된다. (AC-12)
- **Given** MessageWindow Extension을 CompactionSummarize로 교체하면, **When** Turn을 실행하면, **Then** 나머지 구성은 변경 없이 대화 압축 전략만 바뀐다. (AC-3)
- **Given** Extension/Tool을 선언하지 않은 상태에서, **When** Turn을 실행하면, **Then** LLM에 시스템 프롬프트가 전달되지 않고 도구도 없다. (AC-2)
- **Given** `@goondan/openharness-types`에만 의존하는 Extension을 npm 패키지로 구현한 상태에서, **When** import + 선언하면, **Then** 코어 포크 없이 정상 동작한다. (AC-14)
- **Given** Extension이 `api.tools.register()`로 도구를 동적 추가한 상태에서, **When** LLM이 해당 도구를 호출하면, **Then** 정상 실행되고 결과가 반환된다.
- **Given** 같은 이름의 Tool을 두 번 등록하려고 하면, **When** 두 번째 등록 시, **Then** 에러가 발생한다.
- **Given** `api.tools.list()`를 호출하면, **When** 정적 3개 + 동적 1개 Tool이 등록된 상태에서, **Then** 4개 Tool의 name과 description이 반환된다.

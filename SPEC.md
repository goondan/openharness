# OpenHarness v2 스펙

> 이 문서는 OpenHarness v2의 기술 계약을 정의합니다.
> CONCEPTS.md가 "왜, 무엇을"을 설명한다면, 이 문서는 "어떤 계약으로"를 명시합니다.

---

## 설계 원칙

### 순수한 코어

코어는 실행 로직만 소유한다. 시스템 프롬프트 주입, 대화 기록 관리, 도구 자동 등록, 상태 저장 — 이것들은 코어의 관심사가 아니다. 전부 Extension이 담당한다.

### 명시적 선택

암묵적으로 켜지는 것은 없다. 도구를 선언하지 않으면 도구 없음. Extension을 선언하지 않으면 시스템 프롬프트조차 LLM에 전달되지 않는다. 선언한 것이 전부이고, 숨겨진 동작은 없다.

### Code-first 구성

구성 파일은 TypeScript 코드다. `import`가 곧 의존성 선언이며, 별도의 매니페스트나 리소스 해석 레이어가 없다. Node.js 모듈 시스템이 의존성 해석을 처리한다.

---

## Part 1: 코어

코어(`@goondan/openharness`)가 제공하는 것:

1. **실행 루프** — Turn → Step → ToolCall 사이클
2. **미들웨어 훅** — 실행 루프 각 단계에 Extension이 개입하는 지점
3. **표준 포트** — Tool, Extension을 등록하는 레지스트리
4. **이벤트 발행** — 실행 과정에서 발생하는 관측 이벤트
5. **대화 상태** — 이벤트 소싱 기반 인메모리 상태와 직렬화 표면
6. **중단 제어** — AbortSignal 기반 실행 취소

코어는 이 이상을 하지 않는다.

---

### 1.1 실행 루프

```
Turn (사용자 메시지 하나 → 최종 응답까지)
 │
 └─ Step 1: LLM 호출 → 도구 사용 요청
 │   ├─ ToolCall A
 │   └─ ToolCall B
 │
 └─ Step 2: 도구 결과 → LLM → 추가 도구 요청
 │   └─ ToolCall C
 │
 └─ Step 3: 도구 결과 → LLM → 텍스트 응답 → Turn 종료
```

**Turn**: 인바운드 메시지 하나에 대한 전체 처리 과정.

**Step**: Turn 안에서 LLM을 한 번 호출하는 단위. LLM이 도구를 요청하면 실행 후 결과를 다시 전달하며, 도구 요청이 없을 때까지 반복한다.

**ToolCall**: Step 안에서 실행되는 개별 도구 호출. LLM이 한 번에 여러 도구를 요청할 수 있으므로 한 Step에 여러 ToolCall이 존재할 수 있다.

코어는 이 루프를 돌리는 것이 전부다. LLM에 어떤 메시지가 들어갈지, 어떤 도구가 보일지는 코어가 결정하지 않는다.

---

### 1.2 미들웨어 훅

실행 루프의 세 단계 각각에 미들웨어 훅을 노출한다.

| 훅 레벨 | 개입 시점 | Extension이 할 수 있는 일 |
|---------|----------|------------------------|
| **Turn** | 전체 턴 실행 전/후 | 상태 복원/저장, 에러 핸들링 |
| **Step** | LLM 호출 직전/직후 | 메시지 목록 조작, 컨텍스트 주입, 대화 압축 |
| **ToolCall** | 도구 실행 직전/직후 | 인자 검증, 결과 가공, 호출 차단 |

미들웨어는 chain-of-responsibility 패턴으로 동작한다:

```
[요청] → 미들웨어 A → 미들웨어 B → [코어 로직] → 미들웨어 B → 미들웨어 A → [응답]
```

미들웨어는 `next()`를 호출하여 다음 단계로 넘기고, 호출 전후로 상태를 읽거나 변경할 수 있다. `next()`를 호출하지 않으면 실행을 차단할 수 있다.

미들웨어 등록 시 `priority`를 지정하여 실행 순서를 제어한다. 낮은 값이 먼저 실행된다.

---

### 1.3 이벤트 발행 (Observability)

코어는 실행 루프의 주요 시점에서 관측 이벤트를 발행한다. 이벤트 구독은 미들웨어 훅과 **분리된 별도 표면**이다.

**미들웨어 훅과의 차이:**
- 미들웨어는 실행 흐름에 **개입**한다 — 상태를 바꾸거나 실행을 차단할 수 있다.
- 이벤트 구독은 **관찰만** 한다 — 실행 흐름에 영향을 줄 수 없다.

리스너가 에러를 던지거나 오래 걸려도 실행 흐름은 영향받지 않는다. 코어는 이를 보장한다.

**코어가 발행하는 이벤트:**

| 이벤트 | 시점 |
|--------|------|
| `turn.start` | Turn 실행 시작 |
| `turn.done` | Turn 정상 완료 |
| `turn.error` | Turn 실행 중 에러 |
| `step.start` | Step(LLM 호출) 시작 |
| `step.done` | Step 완료 |
| `tool.start` | ToolCall 실행 시작 |
| `tool.done` | ToolCall 정상 완료 |
| `tool.error` | ToolCall 실행 중 에러 |
| `ingress.received` | Ingress로 이벤트 수신 |
| `ingress.accepted` | Ingress에서 Turn 접수 |
| `ingress.rejected` | Ingress에서 거부 |

---

### 1.4 대화 상태

코어는 대화 상태를 **이벤트 소싱** 모델로 관리한다.

**원천 데이터는 events뿐이다.** messages는 events를 replay한 파생 데이터다.

| 구분 | 설명 |
|------|------|
| `events` | 원천. 대화에 발생한 모든 변경의 스트림 |
| `messages` | 파생. events를 replay한 현재 시점의 메시지 목록 (읽기 전용) |

**이벤트 타입:**

| 이벤트 | 동작 |
|--------|------|
| `append` | 메시지 추가 |
| `replace` | 특정 메시지를 다른 내용으로 교체 |
| `remove` | 특정 메시지 삭제 |
| `truncate` | 지정 개수 초과분 잘라내기 |

코어는 이 이벤트 시스템의 인프라만 제공한다. 실제로 이벤트를 발생시켜 메시지 목록을 조작하는 것은 Extension의 일이다.

**직렬화 표면:**

Extension(특히 Persistence Extension)이 상태를 외부로 꺼내고 복원할 수 있도록 최소한의 표면을 제공한다.

- `conversation.events` — 원천 이벤트 스트림 접근
- `conversation.messages` — 현재 시점의 계산된 메시지 목록 (읽기 전용)
- `conversation.restore(events)` — 이벤트 스트림에서 상태 복원

체크포인트(특정 시점의 messages 스냅샷을 저장해서 replay 시작점으로 사용)는 Persistence Extension의 전략이며, 코어가 관여하지 않는다.

---

### 1.5 중단 제어

하나의 `AbortSignal`이 Turn → Step → ToolCall → LLM 호출까지 전체 체인을 관통한다. 미들웨어와 도구 핸들러 모두 중단 여부를 확인할 수 있다.

---

## Part 2: Extension

코어가 순수한 실행 로직만 제공하므로, "LLM이 무엇을 보고, 무엇을 할 수 있는가"를 결정하는 것은 전부 Extension이다.

---

### 2.1 Extension 구조

Extension은 `name`과 `register` 함수를 가진 객체다. `register`에서 `ExtensionApi`를 받아 코어의 표면에 접근한다.

```ts
interface Extension {
  name: string;
  register(api: ExtensionApi): void;
}
```

Extension은 팩토리 함수로 생성한다. 팩토리 함수는 설정을 받아 Extension 객체를 반환한다.

```ts
function MessageWindow(config: { maxMessages: number }): Extension {
  return {
    name: "message-window",
    register(api) {
      api.pipeline.register("step", async (ctx, next) => {
        // ...
        await next();
      }, { priority: 200 });
    },
  };
}
```

---

### 2.2 ExtensionApi

Extension이 코어에 접근하는 5개 표면:

#### `api.pipeline` — 미들웨어 훅 등록

```ts
api.pipeline.register(
  level: "turn" | "step" | "toolCall",
  handler: MiddlewareHandler,
  options?: { priority?: number },
): void;
```

실행 흐름에 개입한다. `next()`를 호출하여 다음 단계로 넘기고, 호출 전후로 상태를 읽거나 변경할 수 있다.

#### `api.tools` — 도구 동적 등록/제거

```ts
api.tools.register(tool: ToolDefinition): void;
api.tools.remove(name: string): void;
api.tools.list(): ToolDefinition[];
```

Extension이 런타임에 도구를 동적으로 추가하거나 제거할 수 있다. 예: `ToolSearch` Extension이 LLM의 검색 요청에 따라 도구를 동적으로 활성화.

#### `api.on` — 이벤트 구독 (관찰 전용)

```ts
api.on(event: string, listener: (payload: EventPayload) => void): void;
```

실행 흐름에 영향을 주지 않는 관찰 전용 구독. 로깅, 메트릭 수집, 감사 기록 등에 사용.

#### `api.conversation` — 대화 상태 접근

```ts
api.conversation.events: readonly MessageEvent[];
api.conversation.messages: readonly Message[];
api.conversation.restore(events: MessageEvent[]): void;
```

이벤트 소싱 기반 대화 상태의 원천(events)과 파생(messages)에 접근하고, 외부에서 상태를 복원할 수 있다.

#### `api.runtime` — 런타임 구성 읽기 (읽기 전용)

```ts
api.runtime.agent: {
  name: string;
  model: ModelInfo;
  extensions: ExtensionInfo[];
  tools: ToolInfo[];
};
api.runtime.agents: Record<string, AgentInfo>;
api.runtime.connections: Record<string, ConnectionInfo>;
```

현재 에이전트의 구성과 전체 런타임 구성을 읽기 전용으로 조회한다. 에이전트가 자기 구성을 구조화된 데이터로 파악할 수 있게 한다.

---

### 2.3 Extension의 역할 분류

| 역할 | 설명 | 예시 |
|------|------|------|
| **입력 제어** | LLM에 전달되는 메시지 목록을 결정 | ContextMessage, CompactionSummarize, MessageWindow |
| **행동 제어** | LLM이 사용할 수 있는 도구를 관리 | ToolSearch, RequiredToolsGuard |
| **상태 관리** | 대화 상태의 저장/복원 | Persistence |
| **관측** | 실행 과정을 관찰하고 기록 | Logging, Metrics |

이것은 분류일 뿐 제약이 아니다. 하나의 Extension이 여러 역할을 수행할 수 있다.

---

### 2.4 Persistence는 Extension이다

상태 저장은 코어의 관심사가 아니다. Persistence Extension이 Turn 미들웨어를 통해 처리한다.

- Turn 시작 전: 외부 저장소에서 events를 로드하여 `conversation.restore(events)` 호출
- Turn 종료 후: `conversation.events`를 읽어 외부 저장소에 저장

저장 전략(전체 스냅샷, 증분 append, 체크포인트)은 Persistence Extension의 구현 선택이다. 코어는 관여하지 않는다.

Persistence Extension을 선언하지 않으면 상태는 인메모리에만 존재하며 프로세스 종료 시 소멸한다.

---

### 2.5 Extension 자체 상태

Extension이 자체적으로 유지해야 하는 상태(예: 압축 횟수, 검색 캐시)는 Extension의 책임이다. 코어는 Extension 상태 저장을 위한 별도 표면을 제공하지 않는다. Extension이 필요하면 자체적으로 저장소를 구성한다.

---

## Part 3: Tool

Tool은 LLM이 호출할 수 있는 도구다.

---

### 3.1 Tool 구조

Tool은 `name`, `description`, `parameters`(JSON Schema), `handler`를 가진다.

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (args: JsonObject, context: ToolContext) => Promise<ToolResult>;
}
```

Tool도 Extension과 마찬가지로 팩토리 함수로 생성한다.

```ts
function FileSystem(config: { allowWrite: boolean }): ToolDefinition {
  return {
    name: "file-system",
    description: "파일 읽기/쓰기",
    parameters: { /* JSON Schema */ },
    handler: async (args, ctx) => {
      // ...
    },
  };
}
```

### 3.2 Tool 등록

도구는 두 가지 경로로 등록된다:

1. **정적 선언** — `defineHarness`의 `agents.*.tools`에 포함
2. **동적 등록** — Extension이 `api.tools.register()`로 런타임에 추가

코어는 등록된 도구에 대해 JSON Schema 기반 인자 검증을 수행한다. 검증 실패 시 LLM에 에러를 반환한다.

도구를 선언하지 않으면 도구 없음. 자동으로 추가되는 기본 도구는 없다.

---

### 3.3 ToolContext

도구 핸들러에 전달되는 컨텍스트:

```ts
interface ToolContext {
  conversationId: string;
  agentName: string;
  abortSignal: AbortSignal;
  // Extension이 미들웨어에서 주입한 추가 컨텍스트
}
```

---

## Part 4: Ingress

Ingress는 외부 이벤트를 받아서 Turn을 시작시키는 입구다.

---

### 4.1 이벤트 소스

HTTP webhook만이 아니다. cron 스케줄, 파일 시스템 watch, 큐 consumer, 다른 에이전트의 출력 — Turn을 촉발하는 모든 것이 Ingress가 될 수 있다.

### 4.2 4단계 파이프라인

```
이벤트 소스
  │
  ▼
① Verify    ─ 검증 (서명 확인, 중복 체크 등)
  │
  ▼
② Normalize ─ 소스별 형식 → InboundEnvelope 표준 형식
  │
  ▼
③ Route     ─ 라우팅 규칙에 따라 대상 Agent 결정
  │
  ▼
④ Dispatch  ─ Agent 세션에 Turn 비동기 접수
```

4단계 각각에 미들웨어 훅이 있어 Extension이 개입할 수 있다.

### 4.3 Connector

Connector는 transport 서버가 아니라 순수한 정규화 어댑터다. 외부 호스트가 이벤트를 수신하고 ingress API를 호출하는 구조를 전제한다.

```ts
interface Connector {
  name: string;
  verify?(ctx: ConnectorContext): Promise<void> | void;
  normalize(ctx: ConnectorContext): Promise<InboundEnvelope | InboundEnvelope[]>;
}
```

Connector도 팩토리 함수로 생성한다:

```ts
function SlackConnector(config?: SlackConfig): Connector {
  return {
    name: "slack",
    verify(ctx) { /* 서명 검증 */ },
    normalize(ctx) { /* Slack payload → InboundEnvelope */ },
  };
}
```

### 4.4 InboundEnvelope

Ingress를 통해 정규화된 이벤트의 표준 형식:

```ts
type InboundContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string }
  | { type: "file"; url: string; name: string; mimeType?: string };

interface InboundEnvelope {
  name: string;
  content: InboundContentPart[];
  properties: Record<string, string | number | boolean>;
  conversationId?: string;
  source: EventSource;
  metadata?: Record<string, unknown>;
}
```

### 4.5 Connection

Connection은 Connector와 라우팅 규칙을 묶는 단위다.

```ts
connections: {
  "slack-main": {
    connector: SlackConnector(),
    rules: [
      { match: { event: "slack.message" }, agent: "assistant" },
    ],
  },
},
```

- 규칙은 선언 순서대로 평가하며 `first-match-wins`다.
- conversationId 해석 우선순위:
  1. `rule.conversationId` (명시적 지정)
  2. `rule.conversationIdProperty` + `rule.conversationIdPrefix` (envelope properties에서 추출)
  3. `envelope.conversationId` (Connector가 normalize 시 설정)
- 세 값이 모두 없으면 reject한다.

### 4.6 Ingress 미들웨어 범위

| 미들웨어 등록 위치 | 동작 단계 |
|------------------|----------|
| Connection 수준 Extension | verify, normalize (pre-route) |
| Agent 수준 Extension | route, dispatch (post-route) |

---

## Part 5: 구성 — defineHarness

### 5.1 harness.config.ts

`harness.config.ts` 파일이 에이전트의 전체 구성을 선언한다.

```ts
import { defineHarness } from "@goondan/openharness";
import { Anthropic } from "@goondan/openharness/models";
import {
  ContextMessage,
  MessageWindow,
  Logging,
  FileSystem,
  HttpFetch,
} from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      model: Anthropic({
        model: "claude-sonnet-4-20250514",
        apiKey: env("ANTHROPIC_API_KEY"),
      }),
      extensions: [
        ContextMessage(),
        MessageWindow({ maxMessages: 30 }),
        Logging({ level: "info" }),
      ],
      tools: [
        FileSystem({ allowWrite: false }),
        HttpFetch(),
      ],
    },
  },
});
```

이 파일이 있으면 `oh` CLI로 바로 실행된다.

### 5.2 defineHarness 계약

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
  maxSteps?: number;
  systemPrompt?: string;
}

interface ConnectionConfig {
  connector: Connector;
  extensions?: Extension[];
  rules: RoutingRule[];
}

interface RoutingRule {
  match: { event?: string; [key: string]: unknown };
  agent: string;
  conversationId?: string;
  conversationIdProperty?: string;
  conversationIdPrefix?: string;
}
```

`defineHarness`는 순수한 구성 선언이다. 런타임을 생성하지 않는다.

### 5.3 env 헬퍼

환경 변수를 참조하는 헬퍼:

```ts
function env(name: string): string;
```

`harness.config.ts`에서 API 키 등 비밀 값을 환경 변수로 참조할 때 사용한다. 런타임 생성 시점에 `process.env`에서 해석된다.

### 5.4 Model 팩토리

모델 프로바이더별 팩토리 함수:

```ts
import { Anthropic, OpenAI, Google } from "@goondan/openharness/models";

Anthropic({ model: "claude-sonnet-4-20250514", apiKey: env("ANTHROPIC_API_KEY") })
OpenAI({ model: "gpt-4o", apiKey: env("OPENAI_API_KEY") })
Google({ model: "gemini-2.5-flash", apiKey: env("GOOGLE_API_KEY") })
```

---

## Part 6: Programmatic API

### 6.1 createHarness

`defineHarness`로 선언한 구성에서 런타임을 생성한다.

```ts
import { createHarness } from "@goondan/openharness";
import config from "./harness.config.ts";

const runtime = await createHarness(config);
```

또는 인라인으로:

```ts
const runtime = await createHarness({
  agents: {
    assistant: { /* ... */ },
  },
});
```

### 6.2 Runtime API

`createHarness`가 반환하는 런타임 객체:

```ts
interface HarnessRuntime {
  processTurn(agentName: string, input: string): Promise<TurnResult>;
  ingress: IngressApi;
  control: ControlApi;
  close(): Promise<void>;
}
```

#### processTurn

지정한 에이전트에 텍스트 입력으로 Turn을 실행한다. 내부적으로 텍스트를 InboundEnvelope로 변환하여 동일한 실행 경로를 탄다.

```ts
const result = await runtime.processTurn("assistant", "안녕하세요");
console.log(result.text);
```

#### Ingress API

```ts
interface IngressApi {
  receive(input: {
    connectionName: string;
    payload: unknown;
    receivedAt?: string;
  }): Promise<IngressAcceptResult[]>;

  dispatch(input: {
    connectionName: string;
    event: InboundEnvelope;
    receivedAt?: string;
  }): Promise<IngressAcceptResult>;

  listConnections(): ConnectionInfo[];
}
```

- `receive`: Connector의 verify → normalize → route → dispatch 전체 파이프라인을 실행. fan-out 이벤트를 배열로 반환.
- `dispatch`: 이미 정규화된 InboundEnvelope를 직접 접수. verify, normalize를 건너뛰고 route → dispatch만 수행.
- `listConnections`: 로드된 connection 목록 조회.

```ts
interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId: string;
}
```

route에서 agent/conversation을 결정한 뒤, Turn 생성은 비동기로 접수된다. 반환값은 Turn 완료 결과가 아니라 accepted handle이다.

#### Control API

```ts
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

실행 중인 Turn을 중단한다. 하나의 AbortSignal이 Turn → Step → ToolCall → LLM 호출까지 전체 체인을 관통한다.

---

## Part 7: CLI

### 7.1 바이너리

`oh`

### 7.2 모드

- `oh` 또는 `oh repl` — REPL 모드
- `oh run "<text>"` — 단일 실행

### 7.3 옵션

| 옵션 | 설명 |
|------|------|
| `--workdir <path>` | 작업 디렉토리 (기본: 현재 디렉토리) |
| `--config <file>` | 구성 파일 경로 (기본: `harness.config.ts`) |
| `--agent <name>` | 에이전트 선택 |
| `--conversation <key>` | 대화 ID |
| `--max-steps <n>` | 최대 Step 수 |

### 7.4 에이전트 선택

- `--agent <name>`이 있으면 해당 에이전트
- 없고 에이전트가 1개면 그 에이전트
- 없고 에이전트가 2개 이상이면 에러

### 7.5 .env 로딩

`workdir/.env`가 존재하면 읽어서 `process.env`와 merge한다. `process.env`가 우선한다.

---

## Part 8: 패키지 구조

```
@goondan/openharness-types       순수 타입 정의. 런타임 의존성 제로.
        ↑
@goondan/openharness             코어: 실행 루프, 레지스트리, 미들웨어 훅, 이벤트 발행
        ↑
@goondan/openharness-cli         CLI 도구 (oh 명령어)

@goondan/openharness-types
        ↑
@goondan/openharness-base        기본 제공 Tool + Extension
```

### 기본 제공 Tool (base 패키지)

| Tool | 기능 |
|------|------|
| `Bash` | 셸 명령/스크립트 실행 |
| `FileSystem` | 파일 읽기/쓰기/목록/디렉토리 생성 |
| `HttpFetch` | HTTP GET/POST 요청 |
| `JsonQuery` | JSON 데이터 쿼리/추출 |
| `TextTransform` | 텍스트 치환/분할/결합/변환 |
| `Wait` | 지정 시간 대기 |

### 기본 제공 Extension (base 패키지)

| Extension | 역할 | 설명 |
|-----------|------|------|
| `ContextMessage` | 입력 | 시스템 프롬프트 및 인바운드 컨텍스트 주입 |
| `CompactionSummarize` | 입력 | 긴 대화 기록을 요약본으로 압축 |
| `MessageWindow` | 입력 | 최근 N개 메시지만 LLM에 전달 |
| `Logging` | 관측 | Turn/Step/ToolCall 이벤트 로깅 |
| `ToolSearch` | 행동 | 동적 도구 검색/발견 |
| `RequiredToolsGuard` | 행동 | 필수 도구 존재 여부 검증 |
| `Persistence` | 상태 | 대화 상태 저장/복원 |

이 Tool과 Extension은 편의를 위해 기본 제공될 뿐, 코어의 일부가 아니다. 별도 패키지이며, 명시적으로 선언해야 활성화된다.

---

## Non-goals

- 멀티 에이전트 오케스트레이션 (에이전트 간 호출/위임) — 별도 프로젝트
- Transport 서버 퍼스트파티 구현 (Slack/Telegram/Webhook 서버)
- Outbound 공통 포트 (채널별 응답은 Tool/Extension 책임)
- 코어의 암묵적 Tool/Extension 활성화
- 코어의 fallback system/user message 주입
- 특정 서비스 전용 DB schema 표준화

---

## Acceptance Criteria

1. `harness.config.ts`에 에이전트, 모델, Tool, Extension이 선언되어 있으면 `oh` CLI와 `processTurn()`으로 실행할 수 있다.
2. `createHarness()`가 `{ processTurn, ingress, control, close }`를 반환한다.
3. Extension을 선언하지 않으면 시스템 프롬프트가 LLM에 전달되지 않는다. Tool을 선언하지 않으면 도구가 없다.
4. Extension은 `ExtensionApi`의 5개 표면(pipeline, tools, on, conversation, runtime)을 통해 코어에 접근한다.
5. 미들웨어 훅(pipeline)과 이벤트 구독(on)은 분리되어 있다. 이벤트 리스너는 실행 흐름에 영향을 줄 수 없다.
6. 대화 상태는 events가 원천이고 messages는 파생이다. `conversation.restore(events)`로 외부에서 상태를 복원할 수 있다.
7. Persistence Extension을 선언하지 않으면 상태는 인메모리에만 존재한다.
8. Connector/Connection이 선언되면 `ingress.receive()`로 verify → normalize → route → dispatch 파이프라인을 실행할 수 있다.
9. Connection의 라우팅 규칙은 `first-match-wins`로 평가되며 conversationId 해석 우선순위를 따른다.
10. `control.abortConversation()`으로 실행 중인 Turn을 중단할 수 있다. AbortSignal이 전체 체인을 관통한다.
11. 에이전트는 `api.runtime`을 통해 자기 구성을 구조화된 데이터로 조회할 수 있다.
12. 코어 이벤트(turn/step/tool/ingress)는 `api.on`으로 구독할 수 있다.
13. 복수의 에이전트가 독립적으로 존재하고, Ingress 라우팅으로 대상 에이전트가 결정된다. 에이전트 간 직접 호출은 v2 범위가 아니다.
14. Extension과 Tool은 npm 패키지로 배포할 수 있다. `import` + `defineHarness` 선언으로 활성화된다.

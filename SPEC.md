# harness.yaml 기반 실행 + ingress 상위 API 스펙

## Problem

`@goondan/openharness`는 Turn/Step/ToolCall 실행 엔진을 제공하지만, 실제 사용 시에는 다음 두 흐름을 함께 지원해야 한다.

1. `harness.yaml`만 두고 CLI 또는 programmatic API로 곧바로 텍스트 턴을 실행하는 흐름
2. Slack, Telegram, HTTP API, Queue consumer 같은 외부 호스트가 payload를 받아 ingress API로 전달하는 흐름

OpenHarness는 barebone harness이므로 transport 서버 자체는 제공하지 않고, ingress 표준 입력 계약과 라우팅/접수 런타임만 제공한다.

## Goals (Committed)

1. 폴더에 `harness.yaml`만 있으면 `oh` CLI 또는 상위 API로 실행할 수 있다.
2. `harness.yaml`은 `goondan.ai/v1` 멀티 문서 YAML이며 다음 kind를 지원한다.
   - `Package`
   - `Model`
   - `Agent`
   - `Tool`
   - `Extension`
   - `Connector`
   - `Connection`
3. Tool/Extension은 패키지의 `dist/harness.yaml`에서 로드하고, `Agent.tools` / `Agent.extensions`로 명시적으로 선택해 활성화한다.
4. `createHarnessRuntimeFromYaml()`가 텍스트 턴과 ingress를 함께 다루는 상위 runtime API를 제공한다.
5. ingress 표준화 범위는 `수신 -> 검증 -> 정규화 -> 라우팅 -> 비동기 turn 접수`까지로 한정한다.
6. runner는 persistence 포트를 통해 conversation 상태와 runtime observability를 저장할 수 있어야 한다.

## Non-goals

- Goondan 오케스트레이터(프로세스/IPC/스폰) 의존
- Slack/Telegram/Webhook/Queue transport 퍼스트파티 구현
- outbound(reply/send/edit/delete/react) 공통 포트
- core runtime의 암묵 Tool/Extension 활성화
- core runtime의 fallback system/user message 주입 정책
- sync wait 기본 API
- Swarm/멀티 에이전트 오케스트레이션
- 특정 서비스 전용 DB schema 표준화

## harness.yaml 입력 형식

### 기본 규칙

- 파일명 기본값: `harness.yaml`
- 멀티 문서 YAML(`---`) 지원
- `apiVersion` 기본값: `goondan.ai/v1`

### Package

- `Package.spec.dependencies[]`를 읽어 각 패키지의 `dist/harness.yaml`을 추가 로드한다.
- `dependencies[].version`은 설치된 패키지 해석용 힌트로만 사용한다.

### Model

- `provider`, `model`, `apiKey`를 가진다.
- `apiKey`는 `valueFrom.env`를 기본 지원한다.
- `secretRef`는 programmatic API의 resolver로 해석할 수 있다.

### Agent

- `modelConfig.modelRef`로 `Model`을 참조한다.
- `tools`는 `Tool` 리소스를 선택한다.
- `extensions`는 `Extension` 리소스를 선택한다.
- `tools`가 생략되거나 빈 배열이면 자동 선택 없이 빈 tool 집합으로 본다.
- `extensions`가 생략되거나 빈 배열이면 자동 선택 없이 빈 extension 집합으로 본다.

### Connector

- `spec.entry`는 transport 서버가 아니라 `ConnectorAdapter` 모듈을 가리킨다.
- 어댑터는 최소 아래 계약을 만족해야 한다.

```ts
interface ConnectorAdapterContext {
  payload: unknown;
  connectionName: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  logger: LoggerLike;
  receivedAt: string;
}

interface ConnectorAdapter {
  verify?(ctx: ConnectorAdapterContext): Promise<void> | void;
  normalize(
    ctx: ConnectorAdapterContext,
  ): Promise<InboundEnvelope | InboundEnvelope[]> | InboundEnvelope | InboundEnvelope[];
}
```

- 어댑터는 순수 모듈이며 transport listener/server를 직접 소유하지 않는다.
- 외부 호스트가 payload를 수신한 뒤 `ingress.receive()`를 호출하는 구조를 전제로 한다.

### Ingress 입력 계약

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
  auth?: TurnAuth;
  rawPayload?: JsonValue;
  source: EventSource;
  metadata?: JsonObject;
}
```

- 입력 본문은 `input: string`이 아니라 `content[]`가 기준이다.
- `rawPayload`는 `InboundEnvelope.rawPayload`로 전달한다.

### Connection

- `connectorRef`로 `Connector`를 참조한다.
- `config` / `secrets`는 connector adapter에 전달되는 값이다.
- `extensions`는 pre-route ingress(`verify`, `normalize`) 용 extension을 선택한다.
- `ingress.rules[]`가 공식 라우팅 표면이다.
- 규칙 평가는 선언 순서대로 수행하며 `first-match-wins`다.

## Resource 선택(Ref/Selector)

- ref(string): `"Kind/name"`
- selector: `kind`, `name`, `matchLabels`
- selector 결과 순서는 로드된 리소스 등장 순서를 유지한다.

## Entry Agent 선택

- `--agent <name>`가 있으면 해당 Agent
- 없고 Agent가 1개면 그 Agent
- 없고 Agent가 2개 이상이면 에러

## Runtime 조립

### Tool

- 선택된 `Tool` 리소스만 동적 import해 `ToolRegistry`에 등록한다.
- export handler는 `module[exportName]` 우선, 없으면 `module.handlers?.[exportName]`를 사용한다.
- 로드된 리소스의 존재만으로 tool이 활성화되지는 않는다.
- core runtime은 `tier=base` 같은 selector를 암묵 적용하지 않는다.

### Extension

- 선택된 `Extension` 리소스만 `loadExtensions()`로 로드한다.
- `Connection.extensions`는 pre-route ingress(`verify`, `normalize`)를 등록한다.
- `Agent.extensions`는 post-route ingress(`route`, `dispatch`)와 기존 `turn/step/toolCall` middleware를 등록한다.
- `Connection.extensions`는 connection-scope pre-route runtime에서 실행되며 state는 런타임 수명 동안만 인메모리로 유지된다.
- 로드된 리소스의 존재만으로 extension이 활성화되지는 않는다.
- core runtime은 `context-message` 같은 특정 extension을 암묵 선택하지 않는다.
- inbound를 conversation message로 투영하거나 system prompt를 conversation state에 주입하는 정책은 선택된 extension의 책임이다.
- core runtime은 위 정책을 위한 fallback turn middleware를 자동 설치하지 않는다.

### Ingress

- `receive({ connectionName, payload })`
  - `verify -> normalize -> route -> dispatch`
- `dispatch({ connectionName, event })`
  - 이미 정규화된 `InboundEnvelope`를 바로 접수
  - `verify`, `normalize`는 건너뛰고 `route -> dispatch`만 수행
- route에서 agent/conversation을 결정한 뒤 turn 생성은 비동기로 큐에 넣는다.
- 반환값은 turn 완료 결과가 아니라 accepted handle이다.

### Runtime Context

- `RuntimeContext.inbound`는 아래 정보를 제공한다.
  - `connectionName`
  - `eventName`
  - `properties`
  - `content[]`
  - `rawPayload?`
- `processTurn(text)`는 별도 source kind를 만들지 않고, `source.kind = "connector"`, `source.name = "cli"`인 synthetic text event로 runtime에 진입한다.
- `ctx.runtime.agent.prompt.system`은 runtime이 materialize한 실행 컨텍스트 값이며, conversation state 주입 여부는 extension 정책에 따른다.
- 텍스트 외 파트는 `[image]`, `[file]` 형태의 구조화된 요약으로 렌더링한다.

## CLI 스펙

### 바이너리

- `oh`

### 모드

- `oh` 또는 `oh repl`
- `oh run "<text>"`

### 공통 옵션

- `--workdir <path>`
- `--entrypoint <file>`
- `--agent <name>`
- `--conversation <key>`
- `--state-root <path>`
- `--max-steps <n>`

### .env 로딩

- `workdir/.env`가 존재하면 읽어서 `process.env`와 merge한다.
- 우선순위는 `process.env`가 높다.

## Programmatic API

### 신규 상위 API

```ts
createHarnessRuntimeFromYaml(options)
```

- 입력
  - `workdir`
  - `entrypointFileName?`
  - `agentName?`
  - `conversationId?`
  - `stateRoot?`
  - `maxSteps?`
  - `logger?`
  - `env?`
  - `resolveSecretRef?`
  - `persistence?`
- 반환
  - `{ processTurn, ingress, control, close }`

### ingress API

- `ingress.receive({ connectionName, payload, receivedAt? })`
  - 반환: `IngressAcceptResult[]`
- `ingress.dispatch({ connectionName, event, receivedAt? })`
  - 반환: `IngressAcceptResult`
- `ingress.listConnections()`
  - 반환: 로드된 `connectionName`, `connectorName`, `ruleCount`

```ts
interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  connectorName: string;
  agentName: string;
  conversationId: string;
  eventId: string;
  eventName: string;
  turnId: string;
  traceId: string;
}
```

### control API

- `control.abortConversation({ conversationId, agentName?, reason? })`
  - 반환: `AbortConversationResult`

```ts
interface AbortConversationResult {
  conversationId: string;
  agentNames: string[];
  matchedSessions: number;
  abortedTurns: number;
  reason?: string;
}
```

- `turn`, `step`, `toolCall`, `tool` context는 모두 `abortSignal: AbortSignal`을 가진다.
- runtime은 같은 signal을 LLM 호출과 tool 실행에 전달해야 한다.
- abort는 accepted 이후의 turn 실행을 끊는 제어 경로이며, ingress route/dispatch 실패와 구분된다.

### legacy convenience API

```ts
createRunnerFromHarnessYaml(options)
```

- 내부적으로 `createHarnessRuntimeFromYaml()`를 사용한다.
- `createHarnessRuntimeFromYaml()`와 달리 entry agent / conversationId를 즉시 결정한다.
- `processTurn(text)`는 내부적으로 text-only synthetic event를 만든 뒤 동일한 runtime 경로로 실행한다.
- 반환: `{ processTurn(text), ingress, control, close, conversationId }`

## Workspace Persistence

runner의 저장 경계는 `WorkspacePersistence` 포트로 추상화한다.

```ts
interface WorkspacePersistence {
  conversations: ConversationStore;
  runtimeEvents: RuntimeEventStore;
}
```

### Conversation Store

conversation 상태 저장은 아래 책임을 포함한다.

- conversation 생성/복원
- message `base + events` 로드
- message event append
- extension state read/write
- lifecycle metadata(`idle | processing`) 갱신

```ts
interface ConversationStore {
  ensureConversation(input: {
    conversationId: string;
    agentName: string;
  }): Promise<ConversationMetadata>;

  loadState(input: {
    conversationId: string;
  }): Promise<LoadedConversationState>;

  appendMessageEvents(input: {
    conversationId: string;
    events: MessageEvent[];
  }): Promise<void>;

  readExtensionState(input: {
    conversationId: string;
    extensionName: string;
  }): Promise<JsonObject | null>;

  writeExtensionState(input: {
    conversationId: string;
    extensionName: string;
    value: JsonObject;
  }): Promise<void>;

  readMetadata(input: {
    conversationId: string;
  }): Promise<ConversationMetadata | null>;

  updateStatus(input: {
    conversationId: string;
    status: "idle" | "processing";
  }): Promise<void>;
}
```

### Runtime Event Store

runtime event 저장은 caller가 workspace/conversation fan-out을 직접 결정하지 않는다.

```ts
interface RuntimeEventRecord {
  workspaceId: string;
  conversationId?: string;
  event: RuntimeEvent;
}

interface RuntimeEventStore {
  append(input: {
    records: RuntimeEventRecord[];
  }): Promise<void>;
}
```

- core는 `workspaceId`, `conversationId?`, `event`만 전달한다.
- workspace view / conversation view materialization 방식은 구현체 책임이다.
- 파일 구현체는 복수 JSONL fan-out을 유지할 수 있다.
- DB 구현체는 단일 row 저장 + 인덱스 조회를 선택할 수 있다.

## Routing 규칙

- `Connection.ingress.rules`는 선언 순서대로 평가한다.
- conversationId 해석 우선순위:
  1. `route.conversationId`
  2. `route.conversationIdProperty` + `route.conversationIdPrefix`
  3. `event.conversationId`
- 세 값이 모두 없으면 reject한다.

## Observability

runtime event 최소 표면:

- `ingress.received`
- `ingress.accepted`
- `ingress.rejected`
- 기존 `turn.*`, `step.*`, `tool.*`

`ingress.received`는 raw `receive()` 요청과 각 `dispatch()` 입력 이벤트에 대해 각각 기록될 수 있다.
ingress 이벤트는 workspace observability에 남아야 하고, conversationId가 확정된 이벤트는 conversation 기준으로도 추적 가능해야 한다.
workspace/conversation별 물리 materialization 방식은 `RuntimeEventStore` 구현체가 결정한다.

## Acceptance Criteria

1. `harness.yaml`에 필요한 `Package`, `Model`, `Agent`와 명시적 `Tool`/`Extension` 선택이 있으면 `oh` CLI와 `processTurn()`으로 실행할 수 있다.
2. `createHarnessRuntimeFromYaml()`가 `{ processTurn, ingress, control, close }`를 반환한다.
3. `createHarnessRuntimeFromYaml()`는 `control.abortConversation()`을 제공하고, 실행 중인 turn을 abort할 수 있다.
4. `Connector`/`Connection` 리소스를 로드하고 `ingress.listConnections()`로 조회할 수 있다.
5. `ingress.receive()`는 connector adapter의 `verify -> normalize -> route -> dispatch`를 수행하고, fan-out 이벤트를 배열로 반환한다.
6. `Connection.extensions`는 `verify`, `normalize` 단계에서 동작하고, `Agent.extensions`는 `route`, `dispatch` 단계에서 동작한다.
7. `Connection.ingress.rules`는 `first-match-wins`로 평가되며 `conversationIdProperty/prefix`를 지원한다.
8. route/verify/normalize/dispatch 단계 오류는 `ingress.rejected`로 관측 가능하다.
9. `context-message`와 기본 runner는 `content[]`를 안정적으로 user message로 투영한다.
10. outbound 공통 포트는 추가하지 않는다. 채널별 응답은 tool/extension 책임으로 남는다.
11. `createHarnessRuntimeFromYaml()`와 `createRunnerFromHarnessYaml()`는 `persistence?` 옵션을 받아야 한다.
12. `persistence`가 없으면 기존 파일 기반 observable behavior를 유지해야 한다.
13. custom persistence를 주입하면 runner는 파일 경로/JSONL append 구현을 직접 호출하지 않아야 한다.
14. `Agent.tools` / `Agent.extensions`가 생략되거나 빈 배열이어도 base tool bundle이나 특정 extension이 자동 활성화되지 않는다.
15. `content[]`의 conversation message 투영과 system prompt 주입은 선택된 extension이 소유하며, core runtime은 fallback middleware를 자동 설치하지 않는다.
16. `processTurn(text)`는 `source.kind = "connector"`, `source.name = "cli"`인 synthetic event로 runtime inbound 표면과 합류한다.

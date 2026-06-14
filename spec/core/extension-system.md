# extension-system - Extension 등록, runtime snapshot, 도구/이벤트 표면

## 1. 한 줄 요약

OpenHarness의 Extension 시스템은 선언 순서대로 등록되며, 실패 시 롤백되고, runtime snapshot과 live registry를 구분해 노출한다.

## 2. 상위 스펙 연결

- Related Goals: `G-2`, `G-4`, `G-6`
- Related Requirements: `FR-EXT-001` ~ `FR-EXT-007`
- Related AC: `AC-02`, `AC-03`

## 3. Behavior Specification

### 3.1 Flow: Extension 등록

**ID:** `EXT-REGISTER-01`

- Trigger: `createHarness(config)`
- Main Flow:
  1. extension 이름 중복을 먼저 검사한다.
  2. 실제 registry 대신 recording deps에 대해 각 `extension.register(api)`를 실행한다. `api`는 scope에 따라 `AgentExtensionApi`(`useTurn`/`useStep`/`useToolCall`/`useModelInput`/`tools`/`on`/`conversation`) 또는 `ConnectionExtensionApi`(`useIngress`/`on`)로 결정된다.
  3. recording된 ops를 throwaway temp registry에 replay해 부팅 검증을 돌린다(미들웨어 순서 cycle/미지 ref/중복 name, scope 위반).
  4. 검증을 통과하면 같은 ops를 실제 registry/tool/eventBus/model-input에 commit한다.
- Failure:
  - 중복 이름이면 등록 전에 실패한다.
  - 어떤 extension이든 `register()`에서 예외를 던지면 전체 등록을 취소한다(recording 단계라 실제 registry는 손대지 않는다).
  - 미들웨어 순서가 `before`/`after`에서 미지 이름을 참조하거나 cycle을 이루면 `MiddlewareOrderError`로 부팅이 실패한다.

### 3.2 Flow: runtime snapshot 생성

**ID:** `EXT-RUNTIME-01`

- Trigger: 각 extension에 `api` 전달 직전
- Main Flow:
  1. 모든 agent/connection 메타데이터를 먼저 수집한다.
  2. 현재 agent의 선언된 extension/tool 목록과 `maxSteps`를 포함한 `RuntimeInfo`를 만든다.
  3. snapshot을 deep-freeze한 뒤 `api.runtime`으로 전달한다.
- Result:
  - 먼저 등록되는 extension도 전체 agent/connection 목록을 본다.

### 3.3 Flow: live tool registry 조작

**ID:** `EXT-TOOL-01`

- `api.tools.register/remove/list`는 실제 runtime registry를 조작한다.
- `api.runtime.agent.tools`는 선언 기반 스냅샷이므로, 동적으로 등록한 tool을 반영하지 않는다.

### 3.4 Flow: 이벤트 구독

**ID:** `EXT-EVENT-01`

- `api.on(event, listener)`는 EventBus에 리스너를 등록한다. 이벤트 이름은 scope에 맞게 타입이 좁혀진다: agent extension은 `AgentScopeEventType`(turn/step/tool 등) + 선언된 custom event를, connection extension은 `ConnectionScopeEventType`(`ingress.*` 등)를 구독한다.
- 커스텀 이벤트 발행은 `api.events.emit(event, payload)`로 한다. 커스텀 이벤트 타입은 `declare module`로 `CustomHarnessEvents`를 증강해 등록한다(캐스트 금지).
- `api.on`/`api.events`(EventBus)는 관측용 HarnessEvents 레이어다. 상태 변경은 여기로 일어나지 않으며, durable 변경은 `ctx.conversation.append`를 쓴다(replay==restore인 MessageEvent 레이어).
- listener 반환값은 무시된다.
- 동기 예외는 EventBus가 잡고 경고만 남긴다.
- listener가 느린 동기 작업을 수행하면 같은 call stack을 점유할 수 있으므로, 관찰 코드는 짧아야 한다.

### 3.5 Flow: 미들웨어 표면별 책임

**ID:** `EXT-PIPELINE-01`

- Agent extension (`AgentExtensionApi`):
  - `useTurn` / `useStep` / `useToolCall`: agent 실행 루프(turn/step/toolCall) 양파 미들웨어로 개입.
  - `useModelInput((messages, ctx) => messages)`: 모델 입력 조립. step 직전 1회, 순수, 영속 안 됨. `conversation`/`ctx` 변형 금지.
- Connection extension (`ConnectionExtensionApi`):
  - `useIngress`: verify/normalize 구간 양파 미들웨어로 개입.
  - `ingress.*` 이벤트 구독(`api.on`).
- 순서 옵션: 각 `use*`는 `{ name?, before?, after? }`를 받는다. `before`/`after`는 다른 미들웨어 이름 또는 밴드 센티넬 `'*'`이며, 진입 순서를 뜻한다("A before B" = A가 B보다 먼저 진입). 옵션 생략 시 등록 순서. (숫자 priority·phase 밴드는 v1에 없다.)
- scope 분리는 노출 메서드로 강제된다:
  - agent extension에는 `useIngress`가 없다.
  - connection extension에는 `useTurn`/`useStep`/`useToolCall`/`useModelInput`/`tools`/`conversation`이 없다.
  - 잘못된 레벨 등록은 부팅 시 `MiddlewareOrderError`로 거부된다.
- 어느 표면에도 agent용 `route` 미들웨어는 없다. ingress route 매칭(어느 agent로 dispatch할지)은 connection의 `RoutingRule`로 결정하는 core 내부 단계이며, 확장이 등록하는 미들웨어 레벨이 아니다.

## 4. Constraint Specification

### EXT-CONST-001 - registration은 원자적이다

- 부분 등록 금지
- declaration order 보장

### EXT-CONST-002 - runtime snapshot은 읽기 전용이다

- extension이 `api.runtime`을 mutate할 수 없다.
- snapshot은 live state가 아니라 declaration snapshot이다.

### EXT-CONST-003 - conversation mutation은 context에서 한다

- live conversation 조작은 미들웨어 핸들러의 `ctx.conversation`을 사용한다. 읽기는 `getMessages()`/`getEventLog()`, 쓰기는 `append(event)` 한 길이다.
- `getMessages()`는 `Object.freeze`된 불변 스냅샷이며 변형 시 throw한다. `append`는 동기라 직후 `getMessages()`에 즉시 반영된다.
- `register(api)`에서 받는 `api.conversation`은 등록 시점 핸들이 아니라 미들웨어 실행 중 쓰는 표면이다. register-time에는 미들웨어를 등록만 하고, 실제 조작은 `ctx`에서 한다.
- persistence, compaction, guard 같은 확장은 middleware 기반으로 작성해야 한다.

### EXT-CONST-004 - agent 선택은 connection routing이 결정한다

- 확장이 등록하는 agent-facing `route` 미들웨어는 없다. 어느 agent로 dispatch할지는 connection의 `RoutingRule`로 결정되는 core 내부 단계다.
- agent 미들웨어(`turn`/`step`/`toolCall`)는 routing이 그 agent를 선택했을 때만, 즉 그 agent의 실행 루프에서만 실행된다. 다른 agent의 미들웨어 체인에 섞이지 않는다.

### EXT-CONST-005 - connection extension은 ingress event bus를 공유한다

- connection extension은 `ingress.received`, `ingress.accepted`, `ingress.rejected`를 같은 bus에서 볼 수 있다.

## 5. Interface Specification

확장은 scope에 따라 두 형태로 나뉜다. 각 표면은 노출 메서드 자체로 scope를 강제한다(string 레벨 dispatch 없음).

```ts
interface AgentExtension {
  name: string;
  register(api: AgentExtensionApi): void;
}

interface ConnectionExtension {
  name: string;
  register(api: ConnectionExtensionApi): void;
}

interface AgentExtensionApi {
  useTurn(mw: TurnMiddleware, options?: MiddlewareOptions): void;
  useStep(mw: StepMiddleware, options?: MiddlewareOptions): void;
  useToolCall(mw: ToolCallMiddleware, options?: MiddlewareOptions): void;
  // 모델 입력 조립 — step 직전 1회, 순수, 영속 X. before/after 없음(등록 순서).
  useModelInput(mw: ModelInputMiddleware): void;
  tools: {
    register(tool: ToolDefinition): void;
    remove(name: string): void;
    list(): readonly ToolDefinition[];
  };
  // event 이름은 agent scope + 선언된 custom event로 타입이 좁혀진다.
  on<T extends AgentScopeEventType | keyof CustomHarnessEvents>(
    event: T,
    listener: (payload: HarnessEvents[T]) => void,
  ): void;
  events: EventsApi; // events.emit(event, payload) — custom event 발행
  conversation: ConversationState;
  runtime: RuntimeInfo;
}

interface ConnectionExtensionApi {
  useIngress(mw: IngressMiddleware, options?: MiddlewareOptions): void;
  on<T extends ConnectionScopeEventType | keyof CustomHarnessEvents>(
    event: T,
    listener: (payload: HarnessEvents[T]) => void,
  ): void;
  events: EventsApi;
  runtime: RuntimeInfo;
}

// 선언적 순서: 숫자 priority·phase 없음. before/after는 미들웨어 이름 또는 밴드 센티넬 '*'.
interface MiddlewareOptions {
  name?: string;
  before?: string | string[];
  after?: string | string[];
}
```

- `store`는 어느 표면에도 없다. conversation 스코프 영속 KV는 미들웨어 핸들러의 `ctx.store`로만 접근하며, register 시점에 캡처하지 않는다(자동 네임스페이스: 확장이름 × conversationId).

### 5.1 RuntimeInfo 의미

```ts
interface RuntimeInfo {
  agent: {
    name: string;
    model: { provider: string; model: string };
    extensions: readonly { name: string }[];
    tools: readonly { name: string; description: string }[];
    maxSteps?: number;
  };
  agents: Readonly<Record<string, AgentInfo>>;
  connections: Readonly<Record<string, ConnectionInfo>>;
}
```

- `agent.extensions/tools`는 config 선언 기준
- 동적 tool 목록은 `api.tools.list()`로 확인

## 6. Realization Specification

- Registration Engine (two-phase commit + 검증): [extension-registry.ts](/Users/channy/workspace/repos/openharness/packages/core/src/extension-registry.ts:1)
- Middleware 순서 (before/after + '*' 위상 정렬): [middleware-chain.ts](/Users/channy/workspace/repos/openharness/packages/core/src/middleware-chain.ts:1)
- Model-input 조립 파이프: [model-input.ts](/Users/channy/workspace/repos/openharness/packages/core/src/model-input.ts:1)
- Runtime snapshot assembly: [create-harness.ts](/Users/channy/workspace/repos/openharness/packages/core/src/create-harness.ts:1)
- Event isolation: [event-bus.ts](/Users/channy/workspace/repos/openharness/packages/core/src/event-bus.ts:1)

## 7. Dependency Map

- Depends On: `configuration-api`, `execution-loop`, `ingress-pipeline`
- Blocks: base extension 작성, third-party extension 생태계
- Parallelizable With: `conversation-state`

## 8. Acceptance Criteria

- Given 2개 extension이 선언돼 있으면, When 등록하면, Then declaration order대로 `register()`가 호출된다.
- Given 뒤쪽 extension이 `register()`에서 실패하면, When createHarness가 실패하면, Then 앞쪽 extension이 남긴 middleware/tool/event 등록은 남지 않는다.
- Given 첫 번째 agent의 extension이 `api.runtime.agents`와 `api.runtime.connections`를 읽으면, When 등록 중이라도, Then 전체 agent/connection 목록을 본다.
- Given agent extension이 `api.useStep(mw, { before: "other" })`로 순서를 선언하면, When 부팅 검증이 돌면, Then `before`/`after` 위상 정렬로 실행 순서가 결정되고, 미지 이름·cycle이면 `MiddlewareOrderError`로 부팅이 실패한다.
- Given connection extension이 `api.useIngress(mw)`를 등록하고 connection의 `RoutingRule`이 한 agent를 가리키면, When ingress가 그 agent로 route되면, Then 선택된 agent의 `turn`/`step`/`toolCall` 미들웨어만 실행된다(agent-facing `route` 미들웨어는 없다).
- Given connection extension이 `api.on("ingress.accepted", ...)`를 등록하면, When ingress가 accepted 되면, Then accepted payload를 관찰할 수 있다.

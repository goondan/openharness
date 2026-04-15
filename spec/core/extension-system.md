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
  2. 실제 registry 대신 recording wrapper에 대해 각 `extension.register(api)`를 실행한다.
  3. 모든 extension이 성공하면 recording된 작업을 실제 registry/tool/eventBus에 재생한다.
- Failure:
  - 중복 이름이면 등록 전에 실패한다.
  - 어떤 extension이든 `register()`에서 예외를 던지면 전체 등록을 취소한다.

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

- `api.on(event, listener)`는 EventBus에 리스너를 등록한다.
- listener 반환값은 무시된다.
- 동기 예외는 EventBus가 잡고 경고만 남긴다.
- listener가 느린 동기 작업을 수행하면 같은 call stack을 점유할 수 있으므로, 관찰 코드는 짧아야 한다.

### 3.5 Flow: 미들웨어 레벨별 책임

**ID:** `EXT-PIPELINE-01`

- Agent extension:
  - `turn`, `step`, `toolCall`: agent 실행 루프 개입
  - `route`: ingress route match 후, dispatch 직전 개입
- Connection extension:
  - `ingress`: verify/normalize 구간 개입
  - ingress 이벤트 구독
- 비지원 조합:
  - connection extension의 `route`
  - agent extension의 `ingress`
  - 이런 등록은 현재 runtime wiring에서 효과를 기대하면 안 된다.

## 4. Constraint Specification

### EXT-CONST-001 - registration은 원자적이다

- 부분 등록 금지
- declaration order 보장

### EXT-CONST-002 - runtime snapshot은 읽기 전용이다

- extension이 `api.runtime`을 mutate할 수 없다.
- snapshot은 live state가 아니라 declaration snapshot이다.

### EXT-CONST-003 - conversation mutation은 context에서 한다

- live conversation 조작은 `ctx.conversation`을 사용한다.
- `api.conversation.emit()`은 active turn 밖에서 실패한다.
- persistence, compaction, guard 같은 확장은 middleware 기반으로 작성해야 한다.

### EXT-CONST-004 - agent route middleware는 matched-agent only다

- 모든 agent extension이 global route 체인에 섞이지 않는다.
- routing rule이 agent를 결정한 뒤, 선택된 agent의 route middleware만 실행된다.

### EXT-CONST-005 - connection extension은 ingress event bus를 공유한다

- connection extension은 `ingress.received`, `ingress.accepted`, `ingress.rejected`를 같은 bus에서 볼 수 있다.

## 5. Interface Specification

```ts
interface Extension {
  name: string;
  register(api: ExtensionApi): void;
}

interface ExtensionApi {
  pipeline: {
    register(level: "turn" | "step" | "toolCall" | "ingress" | "route", handler, options?): void;
  };
  tools: {
    register(tool: ToolDefinition): void;
    remove(name: string): void;
    list(): readonly ToolDefinition[];
  };
  on(event: string, listener: (payload: EventPayload) => void): void;
  conversation: ConversationState;
  runtime: RuntimeInfo;
}
```

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

- Registration Engine: [extension-registry.ts](/Users/channy/workspace/openharness/packages/core/src/extension-registry.ts:1)
- Runtime snapshot assembly: [create-harness.ts](/Users/channy/workspace/openharness/packages/core/src/create-harness.ts:1)
- Event isolation: [event-bus.ts](/Users/channy/workspace/openharness/packages/core/src/event-bus.ts:1)

## 7. Dependency Map

- Depends On: `configuration-api`, `execution-loop`, `ingress-pipeline`
- Blocks: base extension 작성, third-party extension 생태계
- Parallelizable With: `conversation-state`

## 8. Acceptance Criteria

- Given 2개 extension이 선언돼 있으면, When 등록하면, Then declaration order대로 `register()`가 호출된다.
- Given 뒤쪽 extension이 `register()`에서 실패하면, When createHarness가 실패하면, Then 앞쪽 extension이 남긴 middleware/tool/event 등록은 남지 않는다.
- Given 첫 번째 agent의 extension이 `api.runtime.agents`와 `api.runtime.connections`를 읽으면, When 등록 중이라도, Then 전체 agent/connection 목록을 본다.
- Given agent extension이 `api.pipeline.register("route", ...)`를 등록하면, When ingress가 해당 agent로 route되면, Then 그 agent의 route middleware만 실행된다.
- Given connection extension이 `api.on("ingress.accepted", ...)`를 등록하면, When ingress가 accepted 되면, Then accepted payload를 관찰할 수 있다.

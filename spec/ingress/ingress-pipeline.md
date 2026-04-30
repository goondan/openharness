# ingress-pipeline - Connector, routing, durable append, and scheduling handoff

## 1. 한 줄 요약

Ingress는 raw payload를 검증/정규화한 뒤 routing rule로 agent와 conversation을 결정하고, durable mode에서는 append-first inbound 계약을 거쳐 conversation scheduler에 처리를 위임한다.

## 2. 상위 스펙 연결

- Related Goals: `G-1`, `G-3`, `G-5`, `G-7`, `G-8`, `G-9`
- Related Requirements: `FR-INGRESS-001` ~ `FR-INGRESS-013`, `FR-DIR-001` ~ `FR-DIR-006`, `FR-SCHED-001` ~ `FR-SCHED-003`, `FR-ACTIVE-001`, `FR-ACTIVE-002`
- Related AC: `AC-04`, `AC-04b`, `AC-04c`, `AC-DIR-001`, `AC-DIR-008`

## 3. Behavior Specification

### 3.1 Flow: `receive()`

**ID:** `INGRESS-RECEIVE-01`

- Trigger: `runtime.ingress.receive({ connectionName, payload, receivedAt? })`
- Main Flow:
  1. `ingress.received` 이벤트를 발행한다.
  2. connection을 조회한다.
  3. connection-level `ingress` middleware 체인을 실행한다.
  4. core ingress 단계에서 `connector.verify?()` 후 `connector.normalize()`를 수행한다.
  5. normalize 결과를 배열로 fan-out 한다.
  6. 각 envelope에 대해 route+dispatch를 수행한다.
  7. accepted 결과 배열을 반환한다.
- Failure:
  - unknown connection이면 즉시 예외
  - verify/normalize 예외면 `ingress.rejected`를 발행하고 빈 배열 반환

### 3.2 Flow: route + dispatch

**ID:** `INGRESS-ROUTE-01`

- Trigger: fan-out된 envelope 1건 처리
- Main Flow:
  1. `routeEnvelope()`로 first-match routing을 수행한다.
  2. `conversationId`를 우선순위 규칙으로 결정한다.
  3. route result를 만든다. 이때 `turnId`를 미리 생성한다.
  4. 선택된 agent의 `route` middleware 체인을 실행한다.
  5. route 결과가 유효하면 runtime dispatch로 넘긴다.
  6. durable mode이면 runtime은 `DurableInboundStore.append()`를 성공시킨 뒤 scheduler에 넘긴다.
  7. non-durable mode이면 runtime은 같은 `(agentName, conversationId)`에 steer 가능한 active Turn이 있으면 envelope를 그 Turn의 steering inbox에 넣고, 없으면 Turn을 fire-and-forget으로 시작한다.
  8. dispatch/scheduler outcome의 `turnId`, `inboundItemId`, `disposition`, blocker metadata로 `IngressAcceptResult`를 만든다.
  9. `ingress.accepted`를 발행하고 handle을 반환한다.
- Failure:
  - 매칭 rule 없음, 미등록 agent, `conversationId` 부재면 `ingress.rejected`
  - route middleware가 throw 하거나 invalid result를 만들면 `ingress.rejected`

### 3.3 Flow: `dispatch()`

**ID:** `INGRESS-DISPATCH-01`

- Trigger: `runtime.ingress.dispatch({ connectionName, envelope })`
- Behavior:
  - verify/normalize를 생략하고 `INGRESS-ROUTE-01`부터 실행한다.
  - reject되면 예외를 던진다.

### 3.4 Conversation ID 해석 순서

**ID:** `INGRESS-CONV-01`

1. `rule.conversationId`
2. `rule.conversationIdProperty`로 `envelope.properties[key]` 추출
   - `conversationIdPrefix`가 있으면 접두사 부착
3. `envelope.conversationId`

세 경로 모두 실패하면 reject다.

### 3.5 Active Turn Steering

**ID:** `INGRESS-STEER-01`

- Trigger: route 결과가 유효한 envelope dispatch
- Behavior:
  - 같은 `(agentName, conversationId)`에 steer 가능한 active Turn이 있으면 새 Turn을 만들지 않는다.
  - envelope는 active Turn의 steering inbox에 추가된다.
  - durable mode의 accepted result는 active Turn의 `turnId`, `inboundItemId`, `disposition: "delivered"`를 반환한다.
  - non-durable legacy mode의 accepted result는 active Turn의 `turnId`, `disposition: "steered"`를 반환한다.
  - 이 경우 추가 `turn.start`는 발행되지 않는다.
  - active Turn은 Step 경계에서 steering inbox를 drain해 steered envelope를 사용자 메시지로 conversation에 반영한다.
  - 현재 Step이 tool call 없이 완료됐더라도 drain된 steered input이 있으면 Turn은 종료하지 않고 다음 Step으로 계속한다.
- Boundary:
  - active Turn은 `turn.done`/`turn.error` 발행 전에 steer 불가 상태가 된다.
  - 따라서 `turn.done`/`turn.error` listener 안에서 들어온 ingress는 종료 중인 Turn에 합류하지 않고, route가 유효하면 새 Turn으로 `started` 된다.

### 3.5.1 Active delivery 가능 조건

| Conversation condition | Durable mode decision | Non-durable legacy decision |
| --- | --- | --- |
| idle | `started` | `started` |
| LLM calling/streaming 중 active Turn | `delivered` | `steered` |
| tool handler 실행 중 active Turn | `delivered` | `steered` |
| Step 경계에서 durable drain 중 | sequence order로 다음 drain batch에 포함 | 다음 steering inbox drain batch에 포함 |
| Human Gate `waitingForHuman` | `blocked` | durable Human Gate 사용 시 `blocked` |
| Human Gate `resuming` | `blocked` 또는 gate resume drain 대상 | durable Human Gate 사용 시 `blocked` |
| `turn.done`/`turn.error` 발행 직전 이후 | 새 `started` 후보 | 새 `started` 후보 |

### 3.6 Durable append handoff

**ID:** `INGRESS-DURABLE-01`

- Trigger: route 결과가 유효하고 durable inbound mode가 활성화된 envelope dispatch
- Behavior:
  - route result 이후 accepted result 전에 `DurableInboundStore.append()`를 호출한다.
  - append 결과가 duplicate이면 새 Turn 또는 active delivery를 만들지 않고 기존 item identity와 현재 state를 반환한다.
  - append 결과가 new item이면 conversation scheduler가 `started`, `delivered`, `blocked` 중 하나의 disposition을 결정한다.
  - `ingress.accepted`는 append 이후에만 발행한다.
- Boundary:
  - durable inbound queue와 scheduler의 상세 상태 전이는 `inbound/durable-inbound.md`가 소유한다.
  - durable mode에서 in-memory steering inbox는 notification/cache이며 durability source of truth가 아니다.

## 4. Constraint Specification

### INGRESS-CONST-001 - Connector는 transport 서버가 아니다

- Connector는 payload 검증과 정규화만 책임진다.
- HTTP server, queue consumer, scheduler는 외부 호스트 책임이다.

### INGRESS-CONST-002 - first-match-wins

- routing rule은 선언 순서가 의미 있다.
- 첫 번째 매칭 rule이 agent 결정권을 가진다.

### INGRESS-CONST-003 - route middleware는 post-match 단계다

- route middleware는 rule selection 자체를 대신하지 않는다.
- 일단 선택된 agent에 대해 dispatch 직전 검사/차단/결과 조정을 담당한다.

### INGRESS-CONST-004 - non-durable dispatch는 비동기 접수다

- durable mode가 아닌 `receive()`/`dispatch()`는 Turn 완료를 기다리지 않는다.
- accepted handle은 “접수 성공”이지 “Turn 완료”가 아니다.
- accepted handle은 새 Turn 시작일 수도 있고 기존 active Turn steering일 수도 있다.

### INGRESS-CONST-005 - durable mode는 append-first다

- durable mode의 accepted handle은 “durable append 성공” 이후에만 관찰 가능하다.
- durable mode의 accepted scheduling 결과는 `started`, `delivered`, `blocked`, `duplicate` 중 하나로 수렴한다.
- `steered`는 migration compatibility alias이며 canonical active delivery disposition은 `delivered`다.

### INGRESS-CONST-006 - turnId 상관관계 유지

- `disposition="started"`이면 `IngressAcceptResult.turnId`는 새로 시작된 Turn의 `turn.*` 이벤트와 동일한 식별자다.
- `disposition="delivered"`이면 `IngressAcceptResult.turnId`는 이미 실행 중인 active Turn의 식별자이며, 해당 ingress 때문에 새 `turn.start`가 추가로 발생하지 않는다.
- `disposition="steered"`는 non-durable legacy mode에서만 같은 의미의 compatibility value로 사용한다.

## 5. Interface Specification

```ts
interface Connector {
  name: string;
  verify?(ctx: ConnectorContext): Promise<void> | void;
  normalize(ctx: ConnectorContext): Promise<InboundEnvelope | InboundEnvelope[]>;
}

interface InboundEnvelope {
  name: string;
  content: InboundContentPart[];
  properties: Record<string, string | number | boolean>;
  conversationId?: string;
  source: {
    connector: string;
    connectionName: string;
    receivedAt: string;
  };
  metadata?: Record<string, unknown>;
}

interface RoutingRule {
  match: RoutingMatch;
  agent: string;
  conversationId?: string;
  conversationIdProperty?: string;
  conversationIdPrefix?: string;
}

type IngressDisposition =
  | "started"
  | "delivered"
  | "blocked"
  | "duplicate"
  | "steered";

interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId?: string;
  disposition: IngressDisposition;
  inboundItemId?: string;
  blocker?: {
    type: "humanGate" | "operatorHold";
    id: string;
  };
}

interface IngressRejectResult {
  accepted: false;
  connectionName: string;
  reason: string;
}
```

Disposition별 필수 필드:

| Disposition | 필수 필드 |
| --- | --- |
| `started` | `turnId`; durable mode이면 `inboundItemId` |
| `delivered` | `turnId`, `inboundItemId` |
| `blocked` | `inboundItemId`, `blocker` |
| `duplicate` | `inboundItemId` |
| `steered` | `turnId`; non-durable legacy mode 전용 |

### 5.1 Ingress API

```ts
interface IngressApi {
  receive(input: {
    connectionName: string;
    payload: unknown;
    receivedAt?: string;
  }): Promise<IngressAcceptResult[]>;

  dispatch(input: {
    connectionName: string;
    envelope: InboundEnvelope;
    receivedAt?: string;
  }): Promise<IngressAcceptResult>;

  listConnections(): ConnectionInfo[];
}
```

### 5.2 이벤트

| 이벤트 | 목적 |
| --- | --- |
| `ingress.received` | payload 수신 관찰 |
| `ingress.accepted` | agent/conversation/turnId/disposition 접수 관찰 |
| `ingress.rejected` | verify/normalize/route 실패 원인 관찰 |

## 6. Realization Specification

- Pipeline runtime: [pipeline.ts](/Users/channy/workspace/openharness/packages/core/src/ingress/pipeline.ts:1)
- Routing logic: [router.ts](/Users/channy/workspace/openharness/packages/core/src/ingress/router.ts:1)
- Runtime wiring: [create-harness.ts](/Users/channy/workspace/openharness/packages/core/src/create-harness.ts:1)
- Durable handoff: [durable-inbound.md](/Users/channy/workspace/openharness/spec/inbound/durable-inbound.md:1)

## 7. Dependency Map

- Depends On: `configuration-api`, `extension-system`, `execution-loop`, `inbound/durable-inbound`
- Blocks: Slack/webhook/cron style ingress adapter 구현
- Parallelizable With: `surface/configuration-api`

## 8. Acceptance Criteria

- Given connector가 envelope 3개를 normalize 하면, When `receive()`를 호출하면, Then envelope마다 route+dispatch가 독립 수행되고 accepted 결과 3개가 반환된다.
- Given 두 개 이상의 rule이 모두 매칭되면, When route를 수행하면, Then 첫 번째 rule만 적용된다.
- Given matched rule이 `conversationIdProperty`를 가지면, When 해당 property가 envelope에 있으면, Then 그 값이 conversationId가 된다.
- Given envelope가 특정 agent로 route되면, When agent extension의 `route` middleware가 등록돼 있으면, Then 그 agent의 middleware만 실행된다.
- Given active Turn이 없고 `receive()`가 `disposition="started", turnId=X`를 반환하면, When 실제 Turn이 시작되면, Then `turn.start.turnId === X`다.
- Given durable mode에서 같은 `(agentName, conversationId)`의 active Turn이 있으면, When `receive()`가 같은 route 결과의 envelope를 접수하면, Then 새 Turn을 만들지 않고 `disposition="delivered"`와 active Turn의 `turnId`, `inboundItemId`를 반환한다.
- Given non-durable legacy mode에서 같은 `(agentName, conversationId)`의 active Turn이 있으면, When `receive()`가 같은 route 결과의 envelope를 접수하면, Then 새 Turn을 만들지 않고 `disposition="steered"`와 active Turn의 `turnId`를 반환한다.
- Given Turn이 `turn.done`을 발행하는 중이면, When 같은 `(agentName, conversationId)`의 ingress가 들어오면, Then 종료 중인 Turn에 steer하지 않고 새 Turn으로 `disposition="started"`를 반환한다.
- Given verify 또는 normalize가 실패하면, When `receive()`를 호출하면, Then 예외 대신 빈 배열과 `ingress.rejected` 이벤트가 발생한다.
- Given durable inbound mode가 활성화되어 있으면, When route가 성공한 envelope를 accept하면, Then `DurableInboundStore.append()` 성공 이후에만 `ingress.accepted`가 발행된다.
- Given durable inbound mode에서 conversation이 Human Gate로 blocked 상태이면, When route가 성공한 envelope를 accept하면, Then accepted result는 `disposition="blocked"`와 `inboundItemId`, blocker metadata를 포함한다.

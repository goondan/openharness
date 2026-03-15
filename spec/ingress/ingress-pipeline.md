# ingress-pipeline — Ingress 4단계 파이프라인

## 1. 한 줄 요약

외부 이벤트를 4단계 파이프라인(verify → normalize → route → dispatch)으로 처리하여, 적절한 에이전트의 적절한 대화에 Turn을 비동기로 접수한다.

---

## 2. 상위 스펙 연결

- **Related Goals:** G-1 (순수한 코어), G-2 (Composable Extension), G-3 (Code-first)
- **Related Requirements:** FR-INGRESS-001~009
- **Related AC:** AC-9, AC-10, AC-11

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: INGRESS-RECEIVE-01 — 전체 파이프라인 실행

- **Actor:** 외부 호스트 (HTTP 서버, 큐 consumer 등)
- **Trigger:** `runtime.ingress.receive({ connectionName, payload })` 호출
- **Preconditions:**
  - 해당 connectionName에 대응하는 Connection이 등록되어 있다.
- **Main Flow:**
  1. Connection의 Connector를 조회한다.
  2. **Verify 단계:** Connection 수준 미들웨어를 실행한 후, `connector.verify`가 정의되어 있으면 `connector.verify(ctx)`를 호출한다. 서명 확인, 중복 체크 등. verify가 미정의면 이 단계를 통과한다.
  3. **Normalize 단계:** `connector.normalize(ctx)`를 호출한다. 소스별 페이로드를 InboundEnvelope 표준 형식으로 변환한다. 1:N fan-out을 허용한다 (배열 반환).
  4. **Route 단계:** 각 InboundEnvelope에 대해 Connection의 라우팅 규칙을 선언 순서대로 평가한다 (first-match-wins).
     - 매칭된 규칙에서 대상 agentName과 conversationId를 결정한다.
  5. **Dispatch 단계:** Agent 수준 미들웨어를 실행한 후, 매칭된 에이전트에 Turn을 비동기로 접수한다.
  6. 접수 결과(IngressAcceptResult 배열)를 반환한다. 결과는 Turn 완료가 아니라 accepted handle이다.
  7. `ingress.accepted` 이벤트를 발행한다 (각 접수건별).
- **Alternative Flow:**
  - verify 실패: 에러를 반환한다. normalize 이후 단계 실행하지 않음. `ingress.rejected` 이벤트 발행.
  - normalize가 빈 배열 반환: 처리할 이벤트 없음. 빈 결과 배열 반환.
  - 매칭되는 라우팅 규칙 없음: 해당 envelope을 reject. `ingress.rejected` 이벤트 발행.
  - conversationId를 결정할 수 없음 (3개 경로 모두 없음): reject. `ingress.rejected` 이벤트 발행.
  - 대상 agentName이 등록되지 않은 경우: reject. `ingress.rejected` 이벤트 발행.
- **Outputs:** IngressAcceptResult[]
- **Side Effects:** Turn이 비동기로 접수됨.
- **Failure Modes:**
  - connectionName이 등록되지 않은 경우: 즉시 에러 반환.
  - Connector verify/normalize 예외: reject로 처리.

#### Flow ID: INGRESS-DISPATCH-01 — 직접 접수 (verify/normalize 건너뜀)

- **Actor:** 외부 코드
- **Trigger:** `runtime.ingress.dispatch({ connectionName, envelope })` 호출
- **Preconditions:**
  - 이미 정규화된 InboundEnvelope가 전달된다.
- **Main Flow:**
  1. Route 단계부터 실행한다 (verify/normalize 건너뜀).
  2. 이하 INGRESS-RECEIVE-01의 Route/Dispatch 단계와 동일.
- **Outputs:** IngressAcceptResult
- **Failure Modes:**
  - 매칭 실패, conversationId 부재: INGRESS-RECEIVE-01과 동일.

#### Flow ID: INGRESS-ROUTE-01 — conversationId 해석

- **Actor:** 코어 (Route 단계 내부)
- **Trigger:** 라우팅 규칙 매칭 시
- **Preconditions:**
  - 매칭된 라우팅 규칙이 있다.
- **Main Flow:**
  - conversationId 해석 우선순위 (첫 번째로 결정되는 값 사용):
    1. `rule.conversationId` — 규칙에 명시적으로 지정된 고정 값.
    2. `rule.conversationIdProperty` — envelope.properties에서 해당 키의 값을 추출.
       - `rule.conversationIdPrefix`가 있으면 접두사를 붙인다.
    3. `envelope.conversationId` — Connector가 normalize 시 설정한 값.
  - 세 경로 모두에서 값이 없으면 reject.
- **Outputs:** 결정된 conversationId.
- **Failure Modes:**
  - 세 경로 모두 값 없음: reject.

---

## 4. Constraint Specification

### Constraint ID: INGRESS-CONST-001 — Connector는 정규화 어댑터

- **Category:** 아키텍처
- **Description:** Connector는 transport 서버가 아니다. HTTP 서버, 큐 consumer, 스케줄러 등은 외부 호스트의 책임이며, Connector는 수신된 페이로드를 검증하고 정규화하는 순수 함수 역할만 한다.
- **Scope:** 전체
- **Measurement:** Connector 인터페이스에 listen/bind/serve 등의 메서드가 없음.
- **Verification:** 타입 정의 검사.

### Constraint ID: INGRESS-CONST-002 — first-match-wins 라우팅

- **Category:** 동작 보장
- **Description:** 라우팅 규칙은 선언 순서대로 평가하며 첫 번째 매칭 규칙이 적용된다. 이후 규칙은 평가하지 않는다.
- **Scope:** INGRESS-RECEIVE-01, INGRESS-DISPATCH-01
- **Measurement:** 두 규칙이 모두 매칭 가능할 때 첫 번째가 적용되는 테스트.
- **Verification:** 유닛 테스트.

### Constraint ID: INGRESS-CONST-003 — conversationId 필수

- **Category:** 데이터 무결성
- **Description:** Turn 접수 시 conversationId가 반드시 결정되어야 한다. 세 경로 모두에서 결정할 수 없으면 reject.
- **Scope:** INGRESS-ROUTE-01
- **Measurement:** conversationId 부재 시 reject 테스트.
- **Verification:** AC-11.

### Constraint ID: INGRESS-CONST-004 — 비동기 접수

- **Category:** 동작 보장
- **Description:** `receive()`와 `dispatch()`는 Turn 완료를 기다리지 않고 accepted handle을 반환한다. Turn은 비동기로 실행된다.
- **Scope:** INGRESS-RECEIVE-01, INGRESS-DISPATCH-01
- **Measurement:** receive() 반환 후 Turn이 아직 진행 중일 수 있는 테스트.
- **Verification:** 통합 테스트.

### Constraint ID: INGRESS-CONST-005 — 미들웨어 범위 분리

- **Category:** 아키텍처
- **Description:** Connection 수준 Extension은 verify/normalize(pre-route)에 개입한다. Agent 수준 Extension은 route/dispatch(post-route)에 개입한다. 범위를 넘어서는 개입은 불가. Extension은 `api.pipeline.register("verify" | "normalize" | "route" | "dispatch", handler)`로 Ingress 미들웨어를 등록한다.
- **Scope:** 전체
- **Measurement:** Connection Extension이 dispatch에 개입하지 못하는 테스트.
- **Verification:** 유닛 테스트.

---

## 5. Interface Specification

### 5.1 Connector 계약

```ts
interface Connector {
  name: string;
  verify?(ctx: ConnectorContext): Promise<void> | void;
  normalize(ctx: ConnectorContext): Promise<InboundEnvelope | InboundEnvelope[]>;
}

interface ConnectorContext {
  connectionName: string;
  payload: unknown;
  receivedAt: string;  // ISO 8601
}
```

### 5.2 InboundEnvelope

```ts
interface InboundEnvelope {
  name: string;                    // 이벤트 이름 (예: "slack.message")
  content: InboundContentPart[];   // 이벤트 내용
  properties: Record<string, string | number | boolean>;  // 라우팅/conversationId에 사용 가능
  conversationId?: string;         // Connector가 설정 가능
  source: EventSource;             // 원본 소스 정보
  metadata?: Record<string, unknown>;  // 자유 메타데이터
}

type InboundContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; alt?: string }
  | { type: "file"; url: string; name: string; mimeType?: string };

interface EventSource {
  connector: string;       // Connector 이름
  connectionName: string;  // Connection 이름
  receivedAt: string;      // ISO 8601
}
```

### 5.3 Connection 구성

```ts
interface ConnectionConfig {
  connector: Connector;
  extensions?: Extension[];  // Connection 수준 Extension (pre-route)
  rules: RoutingRule[];
}

interface RoutingRule {
  match: RoutingMatch;
  agent: string;                       // 대상 에이전트 이름
  conversationId?: string;             // 고정 conversationId
  conversationIdProperty?: string;     // envelope.properties에서 추출할 키
  conversationIdPrefix?: string;       // property 값에 붙일 접두사
}

interface RoutingMatch {
  event?: string;                      // envelope.name과 매칭
  [key: string]: unknown;              // 추가 매칭 조건 (envelope.properties와 비교)
}
```

### 5.4 Ingress API 계약

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

interface IngressAcceptResult {
  accepted: true;
  connectionName: string;
  agentName: string;
  conversationId: string;
  eventName: string;
  turnId: string;
}
```

### 5.5 Ingress 이벤트

| 이벤트 | payload 핵심 필드 |
|--------|------------------|
| `ingress.received` | connectionName, payload |
| `ingress.accepted` | connectionName, agentName, conversationId, turnId |
| `ingress.rejected` | connectionName, reason |

---

## 6. Realization Specification

- **Module Boundaries:** Ingress 파이프라인은 코어 패키지의 독립 모듈. Connector/Connection 등록과 4단계 파이프라인 실행을 담당.
- **Data Ownership:** ConnectionConfig는 createHarness 시 등록되며 런타임 중 변경 불가. Connector 인스턴스는 Connection당 하나.
- **Concurrency Strategy:** `receive()`가 N개의 InboundEnvelope를 생성하면 각각 독립적으로 Route → Dispatch를 실행한다. Dispatch는 비동기 접수이므로 receive()는 빠르게 반환된다.
- **Failure Handling:**
  - Connector verify 예외: reject로 처리, ingress.rejected 이벤트.
  - Connector normalize 예외: reject로 처리, ingress.rejected 이벤트.
  - Route 매칭 실패: reject로 처리, ingress.rejected 이벤트.
  - Dispatch 접수 실패: reject로 처리.
  - 개별 envelope의 실패가 다른 envelope 처리에 영향을 주지 않는다 (fan-out 시).

---

## 7. Dependency Map

- **Depends On:** `@goondan/openharness-types` (Connector, InboundEnvelope, Connection 타입), execution-loop.md (dispatch 후 Turn 실행)
- **Blocks:** 없음
- **Parallelizable With:** execution-loop.md, conversation-state.md, extension-system.md

---

## 8. Acceptance Criteria

- **Given** SlackConnector와 `{ match: { event: "slack.message" }, agent: "assistant" }` 규칙이 있는 Connection에서, **When** `receive({ connectionName: "slack-main", payload: rawSlackBody })`를 호출하면, **Then** verify → normalize → route → dispatch가 순서대로 실행되고 accepted 결과가 반환된다. (AC-9)
- **Given** 규칙에 `conversationIdProperty: "channel"`이 설정되고 envelope.properties에 `channel: "C123"`이 있으면, **When** Route 단계를 실행하면, **Then** conversationId가 "C123"으로 결정된다. (AC-10)
- **Given** 규칙에 conversationId 관련 설정이 없고 Connector도 conversationId를 설정하지 않았으면, **When** Route 단계를 실행하면, **Then** reject된다. (AC-11)
- **Given** normalize가 3개의 InboundEnvelope를 반환하면, **When** receive를 실행하면, **Then** 3건의 Route → Dispatch가 각각 실행되고 IngressAcceptResult 3개가 반환된다.
- **Given** 두 규칙이 모두 매칭 가능한 envelope에서, **When** Route를 실행하면, **Then** 선언 순서상 첫 번째 규칙이 적용된다.
- **Given** receive()가 accepted를 반환한 직후, **When** Turn이 아직 실행 중이면, **Then** receive()는 이미 반환되어 있다 (비동기 접수).
- **Given** Connection 수준 Extension이 verify 미들웨어를 등록했으면, **When** receive를 실행하면, **Then** Connector.verify 전에 미들웨어가 실행된다.
- **Given** 이미 정규화된 InboundEnvelope로 `dispatch()`를 호출하면, **When** 실행하면, **Then** verify/normalize를 건너뛰고 Route → Dispatch만 실행된다.

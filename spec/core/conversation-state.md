# conversation-state — 이벤트 소싱 대화 상태

## 1. 한 줄 요약

코어가 대화 상태를 이벤트 소싱 모델로 관리하여, events(원천)에서 messages(파생)를 계산하고, Extension이 restore로 외부에서 상태를 복원할 수 있게 한다.

---

## 2. 상위 스펙 연결

- **Related Goals:** G-1 (순수한 코어), G-2 (Composable Extension), G-5 (명시적 선택)
- **Related Requirements:** FR-STATE-001~006
- **Related AC:** AC-4, AC-5, AC-6

---

## 3. Behavior Specification

### 3.1 Flow 목록

#### Flow ID: STATE-EVENT-01 — 이벤트 발생에 의한 상태 변경

- **Actor:** Extension (미들웨어를 통해)
- **Trigger:** Extension이 대화 상태에 이벤트를 발생시킨다.
- **Preconditions:**
  - Turn이 활성 상태이고 conversation 컨텍스트가 존재한다.
- **Main Flow:**
  1. Extension이 conversation API를 통해 이벤트를 발생시킨다 (append, replace, remove, truncate).
  2. 이벤트가 events 스트림에 추가된다.
  3. messages가 재계산된다 (events를 처음부터 replay하거나, 증분 적용).
- **Alternative Flow:**
  - 유효하지 않은 이벤트 (예: 존재하지 않는 메시지 ID를 참조하는 replace/remove): 에러를 던진다. events 스트림에 추가하지 않는다. events 스트림의 무결성을 보장한다.
- **Outputs:** 갱신된 events와 messages.
- **Side Effects:** 없음 (인메모리 상태 변경만).
- **Failure Modes:**
  - 유효하지 않은 이벤트 참조: 에러를 던진다 (events에 추가하지 않음).

#### Flow ID: STATE-RESTORE-01 — 외부 상태 복원

- **Actor:** Extension (Persistence Extension 등)
- **Trigger:** `conversation.restore(events)` 호출
- **Preconditions:**
  - Turn 미들웨어에서 호출된다 (Turn 시작 전, `next()` 호출 전).
  - 전달된 events가 유효한 이벤트 스트림이다.
- **Main Flow:**
  1. 기존 인메모리 상태를 초기화한다.
  2. 전달받은 events를 인메모리 events 스트림으로 설정한다.
  3. events를 replay하여 messages를 계산한다.
- **Alternative Flow:**
  - 빈 events 배열이 전달된 경우: 빈 대화 상태로 초기화된다.
  - 이미 events가 있는 상태에서 restore를 호출한 경우: 기존 상태를 완전히 덮어쓴다.
- **Outputs:** 복원된 대화 상태 (events + messages).
- **Failure Modes:**
  - 유효하지 않은 이벤트가 포함된 경우: restore 에러. 기존 상태는 변경되지 않는다.

#### Flow ID: STATE-REPLAY-01 — events → messages 계산

- **Actor:** 코어 (내부)
- **Trigger:** events 변경 시 (이벤트 발생 또는 restore)
- **Preconditions:**
  - events 스트림이 존재한다.
- **Main Flow:**
  1. 빈 메시지 목록에서 시작한다.
  2. events를 순서대로 적용한다:
     - `append`: 메시지를 목록 끝에 추가한다.
     - `replace`: 지정된 ID의 메시지를 새 내용으로 교체한다.
     - `remove`: 지정된 ID의 메시지를 목록에서 제거한다.
     - `truncate`: 지정 개수 초과분을 목록 앞에서 잘라낸다.
  3. 최종 메시지 목록을 messages로 설정한다.
- **Outputs:** 계산된 messages (읽기 전용).
- **State Transition:**
  - events: [e1, e2, e3] → messages: replay([e1, e2, e3])

---

## 4. Constraint Specification

### Constraint ID: STATE-CONST-001 — events는 원천

- **Category:** 데이터 무결성
- **Description:** events가 유일한 원천(source of truth)이다. messages는 events에서 언제든 재계산 가능한 파생 데이터다. messages를 직접 수정하는 경로는 없다.
- **Scope:** 전체
- **Measurement:** messages에 대한 직접 쓰기 API가 없음을 확인.
- **Verification:** 타입 시스템에서 messages가 readonly임을 확인.

### Constraint ID: STATE-CONST-002 — events 불변성

- **Category:** 데이터 무결성
- **Description:** 한 번 추가된 이벤트는 수정되거나 삭제되지 않는다. 새 이벤트만 추가된다 (append-only). restore는 전체 교체이므로 예외.
- **Scope:** STATE-EVENT-01
- **Measurement:** events 스트림에서 기존 이벤트를 수정/삭제하는 API가 없음.
- **Verification:** 유닛 테스트.

### Constraint ID: STATE-CONST-003 — 코어는 Persistence를 제공하지 않는다

- **Category:** 아키텍처
- **Description:** 코어는 대화 상태의 인메모리 관리와 직렬화 표면(events, messages, restore)만 제공한다. 외부 저장소 연동은 코어의 관심사가 아니다.
- **Scope:** 전체
- **Measurement:** 코어 패키지에 파일시스템/DB/네트워크 I/O 관련 코드가 없음.
- **Verification:** 코어 패키지의 import 분석.

### Constraint ID: STATE-CONST-004 — replay 결정성

- **Category:** 동작 보장
- **Description:** 같은 events를 replay하면 항상 같은 messages가 나온다. replay는 결정적(deterministic)이다.
- **Scope:** STATE-REPLAY-01
- **Measurement:** 동일 events에 대한 반복 replay 결과 비교.
- **Verification:** 유닛 테스트.

---

## 5. Interface Specification

### 5.1 대화 상태 계약

```ts
interface ConversationState {
  // 원천: 이벤트 스트림 (읽기 전용)
  readonly events: readonly MessageEvent[];

  // 파생: 현재 시점의 메시지 목록 (읽기 전용)
  readonly messages: readonly Message[];

  // 외부 복원
  restore(events: MessageEvent[]): void;

  // 이벤트 발생 (Extension이 메시지 목록을 조작하는 유일한 경로)
  // Turn 실행 중(미들웨어 컨텍스트 내부)에서만 호출 가능. 등록 시점에는 사용 불가.
  emit(event: MessageEvent): void;
}
```

### 5.2 메시지 이벤트 타입

```ts
type MessageEvent =
  | { type: "append"; message: Message }
  | { type: "replace"; messageId: string; message: Message }
  | { type: "remove"; messageId: string }
  | { type: "truncate"; keepLast: number };
```

### 5.3 메시지 구조

```ts
interface Message {
  id: string;            // 고유 식별자
  data: ModelMessage;    // Vercel AI SDK의 ModelMessage 타입
  metadata?: Record<string, unknown>;
}
```

`ModelMessage`는 Vercel AI SDK에서 제공하는 메시지 타입으로, role과 content를 포함한다. 코어는 이 타입을 직접 정의하지 않고 AI SDK의 타입을 그대로 사용한다.

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "tool-call"; toolName: string; args: JsonObject; toolCallId: string }
  | { type: "tool-result"; toolCallId: string; result: ToolResult };
```

---

## 6. Realization Specification

- **Module Boundaries:** ConversationState는 코어 패키지의 독립 모듈. 실행 루프와 인터페이스만으로 연결된다.
- **Data Ownership:** Turn당 하나의 ConversationState 인스턴스. Turn 시작 시 생성 (또는 Persistence Extension이 restore).
- **State Model:**
  - 초기 상태: events = [], messages = []
  - 이벤트 발생 시: events에 append → messages 재계산
  - restore 시: events 교체 → messages 재계산
- **Concurrency Strategy:** 하나의 Turn 내에서만 ConversationState에 접근. 동시 접근 없음 (Turn은 직렬 실행).
- **Failure Handling:**
  - 유효하지 않은 이벤트 참조 (존재하지 않는 messageId): 에러를 던진다. events에 추가하지 않는다.
  - restore 실패: 기존 상태 보존.
- **Performance 고려:**
  - 이벤트 수가 많을 때 매번 전체 replay는 비효율적. 구현에서 증분 적용(incremental apply)을 최적화할 수 있다. 다만 외부 계약(events → messages 결정성)은 유지해야 한다.

---

## 7. Dependency Map

- **Depends On:** `@goondan/openharness-types` (Message, MessageEvent 타입)
- **Blocks:** execution-loop.md (Step에서 conversation.messages를 LLM에 전달), extension-system.md (api.conversation 표면)
- **Parallelizable With:** ingress-pipeline.md

---

## 8. Acceptance Criteria

- **Given** 3개의 append 이벤트를 발생시킨 상태에서, **When** `conversation.messages`를 읽으면, **Then** 3개의 메시지가 발생 순서대로 반환된다.
- **Given** append 3개 + replace 1개(두 번째 메시지) 이벤트 후, **When** messages를 읽으면, **Then** 두 번째 메시지가 교체된 3개의 메시지가 반환된다.
- **Given** append 5개 + truncate(keepLast: 3) 이벤트 후, **When** messages를 읽으면, **Then** 마지막 3개 메시지만 반환된다.
- **Given** 대화 A에서 쌓인 events를, **When** 새 대화 B에서 `conversation.restore(events)`하면, **Then** B의 messages가 A의 messages와 동일하다. (AC-4)
- **Given** Persistence Extension이 없는 구성에서 Turn 3회 실행 후, **When** 프로세스를 재시작하면, **Then** 이전 대화 상태가 없다. (AC-6)
- **Given** Persistence Extension이 있는 구성에서 Turn 3회 실행 후, **When** 프로세스를 재시작하고 같은 conversationId로 Turn을 실행하면, **Then** 이전 대화가 복원된 상태에서 진행된다. (AC-5)
- **Given** 같은 events 배열을 두 번 replay하면, **When** 각 결과의 messages를 비교하면, **Then** 동일하다 (결정성).

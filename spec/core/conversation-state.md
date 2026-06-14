# conversation-state - 이벤트 소싱 대화 상태

## 1. 한 줄 요약

OpenHarness는 대화 상태를 메시지 배열 직접 수정이 아니라 이벤트 스트림으로 관리하고, runtime에서는 이를 `(agentName, conversationId)` 단위로 격리한다.

## 2. 상위 스펙 연결

- Related Goals: `G-1`, `G-2`, `G-6`
- Related Requirements: `FR-STATE-001` ~ `FR-STATE-007`
- Related AC: `AC-03`, `AC-05`

## 3. Behavior Specification

### 3.1 Flow: 이벤트 추가

**ID:** `STATE-APPEND-01`

- Trigger: `conversation.append(event)` 호출 (turn-active 게이팅 없음 — 언제나 허용)
- Preconditions:
  - event가 현재 메시지 상태에 대해 유효하다 (role 계약, `keepLast >= 0`)
- Main Flow:
  1. event 유효성을 검사한다 (`_events` 변형 전에 hard error를 먼저 던진다).
  2. `_events` 끝에 event를 append 한다.
  3. `_events`를 deterministic replay 하여 `_messages` 스냅샷을 재계산하고 `Object.freeze` 한다.
- Postconditions:
  - `getEventLog()`와 `getMessages()`가 동일한 의미 상태를 가리킨다.
  - `append`는 동기다 — 직후 `getMessages()`가 즉시 반영한다.
  - `append`는 EventBus(`api.on`/`emit`)를 호출하지 않는다 (상태 변경 ≠ 관측).
- Failure:
  - 음수 `keepLast`, event 종류와 맞지 않는 role, role을 바꾸는 `replace`는 hard error로 실패하고 상태를 바꾸지 않는다.
  - 존재하지 않는 메시지에 대한 `replace`/`remove`는 더 이상 throw가 아니라 멱등 no-op이다. 이벤트는 그대로 `_events`에 기록되지만 `_messages`는 변하지 않는다.

### 3.2 Flow: 상태 복원

**ID:** `STATE-RESTORE-01`

- Trigger: `conversation.restore(events)`
- Main Flow:
  1. 전달된 이벤트 배열로 replay를 먼저 수행한다.
  2. replay가 성공하면 `_events`, `_messages`를 한 번에 교체한다.
- Postconditions:
  - 복원된 상태는 replay 결과와 동일하다.
  - 0.5 로그(`metadata.__createdBy`만 있고 `createdBy` 필드 없음)도 그대로 replay 된다. `createdBy`는 파생 `getMessages()` 뷰에서만 metadata로부터 lift 되고, `getEventLog()`의 직렬화 바이트는 원본과 동일하게 보존된다.
- Failure:
  - replay 실패 시 기존 `_events`, `_messages`는 보존된다.

### 3.3 Flow: runtime 대화 조회

**ID:** `STATE-SCOPE-01`

- Trigger: `runtime.processTurn(agentName, input, { conversationId })`
- Main Flow:
  1. runtime은 내부적으로 `(agentName, conversationId)` 키를 계산한다.
  2. 기존 상태가 있으면 재사용하고, 없으면 새 `ConversationStateImpl`을 만든다.
  3. 해당 상태를 Turn 실행 컨텍스트에 연결한다.
- Result:
  - 같은 `conversationId`라도 agent가 다르면 다른 상태를 사용한다.

## 4. Constraint Specification

### STATE-CONST-001 - event log가 원천이다

- `getMessages()`는 `getEventLog()`의 파생값이다 (이벤트 소싱, replay == restore).
- 변경 유일 경로는 `append(event)`이며, `getMessages()` 스냅샷을 직접 수정하는 API는 없다.
- `getMessages()`는 `Object.freeze`된 불변 스냅샷이므로 변형 시도는 throw 한다.

### STATE-CONST-002 - append는 단일 쓰기 경로다

- `append(event)`은 conversation 상태를 바꾸는 유일한 길이다 (구 `replace`/`remove`/`truncate`/`appendSystem`/`appendMessage`는 모두 `append`에 넘기는 MessageEvent다).
- `append`은 turn-active 게이팅이 없다 — middleware/turn 실행 컨텍스트 밖에서도 언제나 허용된다.
- `append`은 동기이며 EventBus를 호출하지 않는다. 상태 변경(MessageEvent)과 관측(HarnessEvents)은 분리된 레이어다.

### STATE-CONST-003 - restore는 원자적이다

- 새 이벤트 스트림이 유효할 때만 상태를 교체한다.
- invalid replay는 half-applied 상태를 남기지 않는다.

### STATE-CONST-004 - 상태 스코프는 agent+conversationId다

- runtime의 conversation key는 `conversationId` 단독이 아니다.
- 서로 다른 agent가 동일한 문자열 ID를 써도 히스토리를 공유하지 않는다.

### STATE-CONST-005 - append 계열 이벤트는 role 계약을 강제한다

- `appendSystem`은 role=`system`만 허용한다.
- `appendMessage`는 role=`system`을 허용하지 않는다.
- 잘못된 role 조합은 조용히 보정하지 않고 예외로 실패한다.

### STATE-CONST-006 - system 메시지는 항상 선두 구간에 유지된다

- `appendSystem`으로 들어온 system 메시지는 현재 non-system 메시지 앞쪽에 배치된다.
- 이 규칙은 provider별 우회가 아니라 conversation 파생 상태의 전역 불변식이다.
- system 메시지끼리는 삽입 순서를 유지한다.

### STATE-CONST-007 - replace는 role 보존 연산이다

- `replace`는 동일 message id의 내용을 교체하는 연산이다.
- 기존 role과 새 role이 다르면 실패한다.
- role 변경이 필요하면 `remove` 후 `appendSystem` 또는 `appendMessage`를 사용해야 한다.

## 5. Interface Specification

```ts
interface ConversationState {
  // 원천: append-only event log (이벤트 소싱). 직렬화 바이트는 원본과 동일.
  getEventLog(): readonly MessageEvent[];
  // 파생: replay한 현재 상태. Object.freeze된 불변 스냅샷 (createdBy lifted).
  getMessages(): readonly Message[];
  // 변경 유일 경로. 동기 — 직후 getMessages()가 즉시 반영. EventBus 호출 안 함.
  append(event: MessageEvent): void;
  // 전체 로그(0.5 레거시 또는 신규)를 교체하고 replay.
  restore(events: MessageEvent[]): void;
}

type MessageEvent =
  | { type: "appendSystem"; message: SystemMessage }
  | { type: "appendMessage"; message: NonSystemMessage }
  | { type: "replace"; messageId: string; message: Message }
  | { type: "remove"; messageId: string }
  | { type: "truncate"; keepLast: number };
```

### 5.1 Replay 의미론

- `appendSystem`: system 메시지를 선두 system 구간 끝에 추가
- `appendMessage`: non-system 메시지를 conversation tail에 추가
- `replace`: 같은 `messageId`를 새 메시지로 치환하되 role은 바꾸지 못한다
- `remove`: 같은 `messageId`를 삭제
- `truncate`: 현재 메시지 목록에서 마지막 `keepLast`개만 남김

### 5.2 runtime에서의 사용 규칙

- 상태를 읽고 수정할 때는 핸들러 ctx의 `ctx.conversation`(읽기 `getEventLog()`/`getMessages()`, 쓰기 `append()`)을 사용한다. `register(api)` 시점에는 conversation 핸들이 없다 — 항상 미들웨어 ctx에서 받는다.
- persistence, compaction, windowing 같은 durable 변형은 turn middleware에서 `ctx.conversation.append(...)`로 구현한다.
- 모델 입력 조립처럼 영속이 아닌(non-durable) 메시지 변형은 conversation을 변형하지 말고 `api.useModelInput((messages, ctx) => messages)` projection으로 구현한다. projection은 `getMessages()` 스냅샷을 입력으로 받아 모델 호출 직전 1회 실행되는 순수 함수이며, conversation/ctx를 변형하지 않는다.

## 6. Realization Specification

- Implementation Module: [conversation-state.ts](/Users/channy/workspace/openharness/packages/core/src/conversation-state.ts:1)
- Runtime Ownership:
  - state object 생성/재사용: [harness-runtime.ts](/Users/channy/workspace/openharness/packages/core/src/harness-runtime.ts:1)
  - core append 시점: [turn.ts](/Users/channy/workspace/openharness/packages/core/src/execution/turn.ts:1), [step.ts](/Users/channy/workspace/openharness/packages/core/src/execution/step.ts:1)
- Performance:
  - `append`은 매번 `_events`를 deterministic replay 하여 frozen `_messages` 스냅샷을 재계산한다 (replay == restore의 단일 경로).
  - `getMessages()` 스냅샷은 깊은 freeze로 공유 payload(`data.content` 등) 변형을 막아 `_events`/replay 무결성을 보존한다.

## 7. Dependency Map

- Depends On: `middleware` turn lifecycle, `runtime.processTurn`
- Blocks: execution loop의 message composition, persistence extension 구현
- Parallelizable With: `extension-system`, `configuration-api`

## 8. Acceptance Criteria

- Given 메시지 3개를 `appendMessage` event로 `append` 후 하나를 `replace` 하면, When `getMessages()`를 읽으면, Then 순서는 유지되고 대상 메시지만 교체된다.
- Given role을 위반하는 `appendSystem`/`appendMessage`/`replace` 또는 음수 `keepLast`의 `truncate` 이벤트를 `append` 하면, When hard error가 발생하면, Then 기존 `getEventLog()`/`getMessages()`는 유지된다.
- Given 존재하지 않는 message id에 대한 `remove`/`replace` 이벤트를 `append` 하면, When 예외 없이 멱등 no-op으로 처리되면, Then 이벤트는 `getEventLog()`에 기록되지만 `getMessages()`는 변하지 않는다.
- Given 저장된 event stream이 있으면, When `restore(events)`를 호출하면, Then 같은 `getMessages()`가 재구성된다.
- Given `agentA`와 `agentB`가 모두 `conversationId="shared"`를 사용하면, When 각각 Turn을 실행하면, Then 서로의 메시지가 섞이지 않는다.
- Given user 메시지 뒤에 system 메시지를 `appendSystem`으로 `append` 하면, When `getMessages()`를 읽으면, Then system 메시지는 맨 앞 구간으로 이동해 있다.
- Given 기존 assistant 메시지를 system 메시지로 replace 하려고 하면, When 그 `replace` 이벤트를 `append` 하면, Then hard error가 발생하고 상태는 바뀌지 않는다.

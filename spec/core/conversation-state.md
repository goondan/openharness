# conversation-state - 이벤트 소싱 대화 상태

## 1. 한 줄 요약

OpenHarness는 대화 상태를 메시지 배열 직접 수정이 아니라 이벤트 스트림으로 관리하고, runtime에서는 이를 `(agentName, conversationId)` 단위로 격리한다.

## 2. 상위 스펙 연결

- Related Goals: `G-1`, `G-2`, `G-6`
- Related Requirements: `FR-STATE-001` ~ `FR-STATE-007`
- Related AC: `AC-03`, `AC-05`

## 3. Behavior Specification

### 3.1 Flow: 이벤트 추가

**ID:** `STATE-EMIT-01`

- Trigger: active turn 안에서 `conversation.emit(event)` 호출
- Preconditions:
  - `_turnActive === true`
  - event가 현재 메시지 상태에 대해 유효하다
- Main Flow:
  1. event 유효성을 검사한다.
  2. `_events` 끝에 event를 append 한다.
  3. `appendSystem`과 `appendMessage`는 증분 반영하고, 나머지 이벤트는 전체 replay로 `_messages`를 재계산한다.
- Postconditions:
  - `events`와 `messages`가 동일한 의미 상태를 가리킨다.
- Failure:
  - active turn이 아니면 예외를 던진다.
  - 존재하지 않는 메시지에 대한 `replace/remove`, 음수 `keepLast`, event 종류와 맞지 않는 role, role을 바꾸는 `replace`는 예외를 던지고 상태를 바꾸지 않는다.

### 3.2 Flow: 상태 복원

**ID:** `STATE-RESTORE-01`

- Trigger: `conversation.restore(events)`
- Main Flow:
  1. 전달된 이벤트 배열로 replay를 먼저 수행한다.
  2. replay가 성공하면 `_events`, `_messages`를 한 번에 교체한다.
- Postconditions:
  - 복원된 상태는 replay 결과와 동일하다.
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

### STATE-CONST-001 - events가 원천이다

- `messages`는 `events`의 파생값이다.
- `messages`를 직접 수정하는 API는 없다.

### STATE-CONST-002 - emit는 turn-scoped다

- `emit()`은 middleware/turn 실행 컨텍스트 밖에서 사용할 수 없다.
- 이 제약 덕분에 message mutation 타이밍이 Turn 수명주기 안으로 제한된다.

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
  readonly events: readonly MessageEvent[];
  readonly messages: readonly Message[];
  restore(events: MessageEvent[]): void;
  emit(event: MessageEvent): void;
}

type MessageEvent =
  | { type: "appendSystem"; message: Message<SystemModelMessage> }
  | { type: "appendMessage"; message: Message<UserModelMessage | AssistantModelMessage | ToolModelMessage> }
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

- live turn에서 상태를 읽고 수정할 때는 `ctx.conversation`을 사용한다.
- `api.conversation`은 extension 표면에 존재하지만, 특정 turn/conversation 선택 수단으로 의존하면 안 된다.
- persistence, compaction, windowing은 turn middleware에서 `ctx.conversation`을 기준으로 구현한다.

## 6. Realization Specification

- Implementation Module: [conversation-state.ts](/Users/channy/workspace/openharness/packages/core/src/conversation-state.ts:1)
- Runtime Ownership:
  - state object 생성/재사용: [harness-runtime.ts](/Users/channy/workspace/openharness/packages/core/src/harness-runtime.ts:1)
  - core append 시점: [turn.ts](/Users/channy/workspace/openharness/packages/core/src/execution/turn.ts:1), [step.ts](/Users/channy/workspace/openharness/packages/core/src/execution/step.ts:1)
- Performance:
  - `appendSystem`, `appendMessage`는 증분 반영
  - `replace/remove/truncate/restore`는 deterministic replay

## 7. Dependency Map

- Depends On: `middleware` turn lifecycle, `runtime.processTurn`
- Blocks: execution loop의 message composition, persistence extension 구현
- Parallelizable With: `extension-system`, `configuration-api`

## 8. Acceptance Criteria

- Given 메시지 3개를 `appendMessage` 후 하나를 replace 하면, When `messages`를 읽으면, Then 순서는 유지되고 대상 메시지만 교체된다.
- Given invalid `appendSystem`/`appendMessage`/`replace`/`remove`/`truncate` 이벤트를 emit 하면, When 예외가 발생하면, Then 기존 `events/messages`는 유지된다.
- Given 저장된 event stream이 있으면, When `restore(events)`를 호출하면, Then 같은 `messages`가 재구성된다.
- Given `agentA`와 `agentB`가 모두 `conversationId="shared"`를 사용하면, When 각각 Turn을 실행하면, Then 서로의 메시지가 섞이지 않는다.
- Given user 메시지 뒤에 system 메시지를 `appendSystem` 하면, When `messages`를 읽으면, Then system 메시지는 맨 앞 구간으로 이동해 있다.
- Given 기존 assistant 메시지를 system 메시지로 replace 하려고 하면, When `emit(replace)`를 호출하면, Then 예외가 발생하고 상태는 바뀌지 않는다.

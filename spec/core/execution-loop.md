# execution-loop - Turn, Step, ToolCall 실행 계약

## 1. 한 줄 요약

코어는 입력 1건을 Turn으로 받아 Step을 반복하고, 필요 시 ToolCall을 실행해 최종 텍스트나 종료 상태를 반환한다.

## 2. 상위 스펙 연결

- Related Goals: `G-1`, `G-2`, `G-5`
- Related Requirements: `FR-EXEC-001` ~ `FR-EXEC-009`
- Related AC: `AC-01`, `AC-04`, `AC-04b`, `AC-04c`

## 3. Behavior Specification

### 3.1 Flow: Turn 실행

**ID:** `EXEC-TURN-01`

- Trigger: `runtime.processTurn()` 또는 ingress dispatch
- Main Flow:
  1. `turnId`를 결정한다.
     - 직접 실행이면 코어가 생성
     - ingress 실행이면 accepted handle의 `turnId`를 재사용
  2. `conversationId`를 결정하고 해당 conversation state를 준비한다.
  3. runtime은 `(agentName, conversationId)` active turn 추적을 등록한다.
  4. input을 `InboundEnvelope`로 정규화한다.
  5. `turn.start` 이벤트를 발행한다.
  6. `_turnActive = true`로 전환하고 사용자 메시지를 `appendMessage`로 기록한다.
  7. turn middleware 체인을 실행한다.
  8. 내부 core handler가 Step loop를 수행한다.
  9. 종료 결과가 결정되면 terminal event 전에 steering 접수를 닫는다.
  10. 성공 시 `turn.done`, 실패 시 `turn.error`를 발행한다.
  11. `_turnActive = false`로 되돌리고 active turn 추적을 해제한 뒤 `TurnResult`를 반환한다.

### 3.2 Flow: Step 실행

**ID:** `EXEC-STEP-01`

- Trigger: Turn loop 내부에서 step 시작
- Main Flow:
  1. `step.start` 이벤트를 발행한다.
  2. `ctx.conversation.messages`를 LLM 입력으로 수집한다.
  3. 현재 tool registry snapshot을 읽는다.
  4. `streamChat()`이 있으면 사용하고, 없으면 `chat()`으로 폴백한다.
  5. 스트리밍 중간에 `step.textDelta`, `step.toolCallDelta` 이벤트를 발행한다.
  6. assistant 응답을 `appendMessage`로 기록한다.
  7. tool call이 있으면 모두 병렬로 ToolCall을 실행한다.
     - tool call 인자가 invalid JSON이거나 JSON object로 해석되지 않으면 실제 ToolCall 실행은 건너뛰고, provider-safe한 `{}` input의 assistant tool-call과 error tool-result를 기록해 다음 Step에서 모델이 재시도할 수 있게 한다.
     - 각 tool call의 결과는 LLM이 반환한 순서대로 `appendMessage`로 기록한다. `HumanApprovalPendingError`로 보류된 tool call은 이 step에서는 tool-result를 기록하지 않고, approval resume 경로에서 해당 tool의 결과가 append된다.
  8. 병렬 실행이 모두 settle된 뒤, `HumanApprovalPendingError`가 하나라도 있었다면 LLM이 반환한 순서상 첫 pending error를 상위 Turn 루프로 전파한다.
  9. `step.done`을 발행하고 `StepResult`를 반환한다.
- Failure:
  - LLM 오류는 `step.error`를 발행한 뒤 상위 Turn으로 전파된다.

### 3.3 Flow: ToolCall 실행

**ID:** `EXEC-TOOL-01`

- Trigger: Step에서 tool call 발견
- Main Flow:
  1. `tool.start` 이벤트를 발행한다.
  2. toolCall middleware 체인을 실행한다.
  3. core handler가 tool 존재 여부와 JSON Schema 인자를 검증한다.
  4. 검증 통과 시 handler를 호출한다.
  5. 성공 시 `tool.done`, 실패 시 `tool.error`를 발행한다.
  6. 오류는 `ToolResult { type: "error" }`로 정규화해 Step에 반환한다.

### 3.4 Flow: Step 반복 종료

**ID:** `EXEC-TURN-LOOP-01`

- 각 Step 진입 전 active Turn의 steering inbox를 drain해 steered ingress input을 사용자 메시지로 기록한다.
- 각 Step 완료 후에도 steering inbox를 drain한다.
- tool call이 없으면 Turn은 `completed`로 종료한다.
- 단, tool call 없이 완료된 Step 직후 steered input이 drain되면 Turn은 종료하지 않고 다음 Step으로 계속한다.
- tool call이 계속 나오면 다음 Step으로 진행한다.
- `maxSteps`에 도달하면 `maxStepsReached`로 종료한다.
- abort signal이 이미 중단 상태면 다음 Step 진입 전에 `aborted`로 종료한다.

## 4. Constraint Specification

### EXEC-CONST-001 - core append는 명시적이다

- 코어가 대화 상태에 직접 쓰는 내용은 사용자 입력, assistant 응답, tool 결과뿐이다.
- 코어는 이 세 종류를 모두 `appendMessage`로만 기록한다.
- 시스템 프롬프트, 요약본, truncate 같은 개입은 extension이 담당한다.

### EXEC-CONST-002 - abort는 체인 전체를 관통한다

- TurnContext의 `abortSignal`은 Step, ToolCall, Tool handler, LLM 호출에 같은 신호가 전달된다.

### EXEC-CONST-003 - Step은 순차, ToolCall은 병렬이다

- 같은 Turn 안의 Step은 병렬이 아니다.
- 한 Step 안의 tool call은 병렬로 실행된다. handler 부수효과의 동시 실행 안전성은 tool 작성자의 책임이다.
- 병렬로 실행하더라도 `StepResult.toolCalls`와 conversation에 기록되는 tool-result `appendMessage` 순서는 LLM이 반환한 tool call 순서를 그대로 유지한다.
- 어느 한 tool이 `HumanApprovalPendingError`를 던지면, 같은 step에서 함께 실행된 다른 tool들의 result는 LLM 순서대로 conversation에 append된다. 보류된 tool 자체의 tool-result는 approval resume 경로에서 추가되며, step.ts는 LLM 순서상 첫 pending error를 상위 Turn 루프로 전파한다.

### EXEC-CONST-004 - 스트리밍은 관찰용 부가기능이다

- `streamChat()`은 최종적으로 `LlmResponse`를 반환해야 한다.
- 중간 delta 이벤트는 Turn/Step 결과 구조를 바꾸지 않는다.

### EXEC-CONST-005 - ingress correlation 유지

- `disposition="started"`인 ingress accepted handle의 `turnId`는 이후 `turn.start`, `turn.done`, `turn.error`에서도 동일해야 한다.
- `disposition="steered"`인 ingress accepted handle의 `turnId`는 기존 active Turn의 식별자이며, 해당 ingress 때문에 새 `turn.start`가 발생하지 않는다.

### EXEC-CONST-006 - LLM 입력은 conversation 불변식을 그대로 따른다

- 실행 루프는 `ctx.conversation.messages` 순서를 그대로 provider adapter에 전달한다.
- system 메시지가 선두라는 보장은 execution 단계가 아니라 `appendSystem` 이벤트와 conversation 상태 불변식에서 온다.

### EXEC-CONST-007 - active turn 등록은 turn.start보다 앞선다

- runtime은 `executeTurn()`이 `turn.start`를 발행하기 전에 in-flight/active turn 추적을 등록해야 한다.
- 따라서 `turn.start` listener에서 `abortConversation()`이나 ingress steering을 수행해도 현재 Turn이 active 대상으로 잡혀야 한다.

### EXEC-CONST-008 - terminal event 중에는 steer하지 않는다

- Turn은 `turn.done`/`turn.error` 발행 전에 steering inbox를 닫는다.
- terminal event listener 안에서 들어온 같은 `(agentName, conversationId)` ingress는 종료 중인 Turn에 합류하지 않고 새 Turn으로 시작되어야 한다.

## 5. Interface Specification

```ts
interface TurnResult {
  turnId: string;
  agentName: string;
  conversationId: string;
  status: "completed" | "aborted" | "error" | "maxStepsReached";
  text?: string;
  steps: StepSummary[];
  error?: Error;
}

interface StepResult {
  text?: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: JsonObject;
    invalidReason?: string;
    result?: ToolResult;
  }>;
}

interface LlmClient {
  chat(messages, tools, signal, options?): Promise<LlmResponse>;
  streamChat?(messages, tools, signal, callbacks, options?): Promise<LlmResponse>;
}
```

### 5.1 Event 발행 순서

- Turn 성공: `turn.start` -> `step.*` / `tool.*` -> `turn.done`
- Step 스트리밍 성공: `step.start` -> zero or more delta events -> `step.done`
- ingress dispatch 경유 새 Turn: `disposition="started"`인 `ingress.accepted`와 `turn.start`는 같은 `turnId`를 사용한다.
- ingress steering: `disposition="steered"`인 `ingress.accepted`는 기존 active Turn의 `turnId`를 사용하며 새 `turn.start`를 만들지 않는다.

## 6. Realization Specification

- Entry Points:
  - [turn.ts](/Users/channy/workspace/openharness/packages/core/src/execution/turn.ts:1)
  - [step.ts](/Users/channy/workspace/openharness/packages/core/src/execution/step.ts:1)
  - [tool-call.ts](/Users/channy/workspace/openharness/packages/core/src/execution/tool-call.ts:1)
- Tool validation: [tool-registry.ts](/Users/channy/workspace/openharness/packages/core/src/tool-registry.ts:1)
- Middleware execution: [middleware-chain.ts](/Users/channy/workspace/openharness/packages/core/src/middleware-chain.ts:1)

## 7. Dependency Map

- Depends On: `conversation-state`, `extension-system`, `tool-registry`
- Blocks: CLI/programmatic execution, persistence/message management extension
- Parallelizable With: `ingress-pipeline`

## 8. Acceptance Criteria

- Given extension/tool 없이 model만 선언된 agent, When Turn을 실행하면, Then 사용자 메시지 1개만 LLM 입력으로 전달된다.
- Given LLM이 tool call을 반환하면, When Step을 실행하면, Then tool 검증/실행 후 tool result가 conversation에 `appendMessage`로 기록되고 다음 Step으로 진행한다.
- Given LLM이 같은 Step에서 N개의 tool call을 반환하면, When Step을 실행하면, Then tool handler들은 병렬로 호출되고 `StepResult.toolCalls`와 tool-result `appendMessage` 순서는 LLM이 반환한 순서를 따른다.
- Given `streamChat()`이 구현된 client, When Step을 실행하면, Then `chat()` 대신 `streamChat()`을 사용하고 delta 이벤트를 발행한다.
- Given abortConversation이 실행 중인 Turn에 호출되면, When 다음 abort 체크 시점에 도달하면, Then Turn은 `aborted`로 종료된다.
- Given `turn.start` listener가 현재 conversation에 `abortConversation()`을 호출하면, When Turn이 다음 abort 체크에 도달하면, Then 현재 Turn은 `aborted`로 종료된다.
- Given ingress `receive()` 결과가 `disposition="started", turnId=X`를 반환하면, When 해당 Turn의 `turn.start`가 발행되면, Then `turn.start.turnId === X`다.
- Given active Turn 실행 중 같은 `(agentName, conversationId)` ingress가 `disposition="steered"`로 accepted 되면, When 다음 Step이 LLM을 호출하면, Then steered input이 사용자 메시지로 포함된다.
- Given `turn.done` listener에서 같은 `(agentName, conversationId)` ingress를 호출하면, When route가 유효하면, Then 해당 ingress는 새 Turn으로 `disposition="started"` 처리된다.
- Given turn middleware가 `appendSystem`으로 system 메시지를 추가하면, When Step이 LLM을 호출하면, Then 전달되는 첫 메시지는 system 메시지다.

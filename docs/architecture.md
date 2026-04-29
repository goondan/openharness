# Architecture

OpenHarness를 이해하는 가장 쉬운 방법은 "코어는 루프만 돌리고, 나머지는 Extension이 결정한다"로 보는 것입니다.

## 1. 실행 루프

기본 실행 단위는 `Turn -> Step -> ToolCall`입니다.

- Turn: 사용자 입력 1개를 처리하는 전체 흐름
- Step: LLM을 한 번 호출하는 단위
- ToolCall: 한 Step 안에서 실행되는 개별 도구 호출

대략적인 흐름은 이렇습니다.

```text
user input
  -> turn middleware
  -> step middleware
  -> LLM 호출
  -> tool call 실행
  -> 다시 step middleware
  -> 최종 텍스트 응답
```

HITL 정책이 붙은 ToolCall은 이 흐름을 일시 중지합니다.

```text
LLM tool call
  -> HitlStore.create(pending)
  -> TurnResult.status = waitingForHuman
  -> submitHitlResult(approve/reject/form)
  -> in-runtime resume task
  -> lease 획득
  -> startExecution 또는 rejection result
  -> tool-result 기록
  -> HitlStore.complete
```

중요한 경계는 두 가지입니다.

- human result 제출은 먼저 durable store에 저장되고, submit 응답은 tool handler 완료를 기다리지 않습니다.
- 외부 tool handler가 시작되면 request는 `blocked`로 durable 표시되어 startup recovery가 자동으로 중복 실행하지 않습니다.

## 2. 미들웨어 레벨

OpenHarness는 7개 레벨의 미들웨어를 제공합니다.

- `turn`
- `step`
- `toolCall`
- `verify`
- `normalize`
- `route`
- `dispatch`

앞의 3개는 agent 실행 루프용이고, 뒤의 4개는 ingress 파이프라인용입니다.

## 3. Ingress 파이프라인

외부 이벤트는 아래 4단계를 거칩니다.

1. `verify`: 서명 검증, 중복 방지 같은 체크
2. `normalize`: 소스별 payload를 `InboundEnvelope`로 정규화
3. `route`: 어느 agent가 처리할지 결정
4. `dispatch`: 실제 turn 실행으로 넘김

즉, Slack/cron/webhook 같은 _입구의 차이_ 와 agent 실행 루프를 분리해서 다룹니다.

## 4. Conversation State

대화 상태는 메시지 배열을 직접 수정하는 식이 아니라, `MessageEvent`를 쌓아가며 관리합니다.

이벤트 종류:

- `append`
- `replace`
- `remove`
- `truncate`

이 구조 덕분에 Extension이 "오래된 메시지를 요약본으로 교체"하거나 "최근 N개만 남기기" 같은 개입을 비교적 단순하게 구현할 수 있습니다.

## 5. 코어가 하지 않는 것

OpenHarness를 쓸 때 가장 중요한 전제입니다.

- 시스템 프롬프트 자동 주입 안 함
- 기본 도구 자동 등록 안 함
- 기본 메모리 전략 자동 적용 안 함
- fallback ingress 처리 안 함
- durable HITL backend 내장 안 함. core는 `HitlStore` 계약과 in-memory test store만 제공합니다

즉, 선언하지 않은 것은 작동하지 않는다고 생각하시면 거의 맞습니다.

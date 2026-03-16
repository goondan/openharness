# Message Envelope

OpenHarness의 내부 메시지는 provider SDK 원시 객체를 그대로 여기저기 흘리는 대신, _얇은 envelope_ 로 감쌉니다.

```ts
type Message = {
  id: string;
  data: ModelMessage;
  metadata?: Record<string, unknown>;
};
```

핵심은 `data`가 AI SDK의 `ModelMessage`라는 점입니다.

## 왜 `ModelMessage`를 그대로 쓰나요?

이유는 두 가지입니다.

1. `content: unknown` 같은 느슨한 타입으로 다시 포장하지 않기 위해
2. tool-call / tool-result / multimodal 같은 모델 메시지 구조를 표준 형식으로 유지하기 위해

OpenHarness가 해야 하는 일은 provider별 메시지 포맷을 또 새로 정의하는 게 아니라, _메시지 envelope + 실행 루프 + 이벤트 기반 조작_ 을 제공하는 것입니다.

## `metadata.__createdBy`

`metadata.__createdBy`는 이 메시지를 누가 만들었는지 남기는 provenance 키입니다.

예:

- 코어가 생성한 사용자 메시지: `core`
- `ContextMessage`가 추가한 시스템 메시지: `context-message`
- `CompactionSummarize`가 만든 요약 메시지: `compaction-summarize`

이 값은 디버깅과 확장 간 협업에는 유용하지만, 코어가 의미를 해석하는 강한 계약은 아닙니다.

## 메시지 예시

### 시스템 메시지

```ts
{
  id: "sys-1",
  data: {
    role: "system",
    content: "당신은 정확한 조력자입니다.",
  },
  metadata: {
    __createdBy: "context-message",
  },
}
```

### 사용자 메시지

```ts
{
  id: "msg-1",
  data: {
    role: "user",
    content: "최근 로그를 요약해줘",
  },
  metadata: {
    __createdBy: "core",
  },
}
```

### assistant의 tool-call

```ts
{
  id: "assistant-1",
  data: {
    role: "assistant",
    content: [
      { type: "text", text: "로그를 확인해볼게요." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "ls -la" },
      },
    ],
  },
  metadata: {
    __createdBy: "core",
  },
}
```

### tool-result

```ts
{
  id: "tool-result-call-1",
  data: {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "bash",
        output: { type: "text", value: "..." },
      },
    ],
  },
  metadata: {
    __createdBy: "core",
  },
}
```

## 이벤트와 메시지 envelope의 관계

Conversation state는 메시지를 직접 mutate하기보다 이벤트를 쌓아가며 재생합니다.

- `append`: 새 메시지 추가
- `replace`: 특정 메시지를 다른 envelope로 교체
- `remove`: 메시지 제거
- `truncate`: 오래된 메시지 잘라내기

그래서 Extension은 "메시지를 어떻게 만들 것인가"와 "언제 어떤 이벤트를 발생시킬 것인가"를 같이 생각해야 합니다.


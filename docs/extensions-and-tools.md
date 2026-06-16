# Extensions And Tools

OpenHarness를 처음 쓸 때 가장 많이 헷갈리는 부분이 "이건 Extension으로 해야 하나, Tool로 해야 하나?"입니다.

## Extension은 _실행 흐름에 개입_ 합니다

이런 경우 Extension이 맞습니다.

- 시스템 프롬프트를 넣고 싶다
- 메시지 윈도우를 자르고 싶다
- 오래된 대화를 요약으로 바꾸고 싶다
- 툴 목록을 조건부로 바꾸고 싶다
- turn/step/toolCall 시작과 끝에 로깅을 넣고 싶다

즉, "LLM이 무엇을 보고 어떻게 실행되는가"를 바꾸는 건 Extension입니다.

### 간단한 Extension 예시

```ts
import {
  type Extension,
  type ExtensionApi,
  type ModelInput,
  createMessage,
} from "@goondan/openharness-types";

export function BasicSystemPrompt(text: string): Extension {
  return {
    name: "basic-system-prompt",
    register(api: ExtensionApi) {
      // 모델 입력 조립: step 직전에 한 번, 시스템 메시지를 view 맨 앞에 끼웁니다.
      // 순수 projection이라 durable 로그에는 남지 않습니다.
      api.useModelInput((view): ModelInput => {
        const system = createMessage({
          data: { role: "system", content: text },
          createdBy: "basic-system-prompt",
        });
        return [system, ...view];
      });
    },
  };
}
```

`useModelInput`은 모델 호출 직전에 한 번 실행되는 순수 함수입니다. 여기서 만든 메시지는
"이번 호출에 보낼 입력"일 뿐, 대화 로그(`conversation`)에는 기록되지 않습니다. 시스템
프롬프트나 메시지 윈도우처럼 _영속시키면 안 되는_ 변형은 이렇게 projection으로 처리합니다.

반대로, 오래된 대화를 요약으로 _영구히_ 바꾸는 것처럼 durable한 변형이 필요하면
`api.useTurn(...)` 안에서 `ctx.conversation.append(event)`로 기록합니다. 대화 상태를 바꾸는
유일한 경로는 `append`이고, 출처는 `createMessage`로 남깁니다.

```ts
api.useTurn(async (ctx, next) => {
  ctx.conversation.append({
    type: "appendSystem",
    message: createMessage({
      data: { role: "system", content: "...요약..." },
      createdBy: "compaction-summarize",
    }),
  });
  return next();
});
```

## Tool은 _모델이 호출하는 기능_ 입니다

이런 경우 Tool이 맞습니다.

- 파일 읽기/쓰기
- 셸 명령 실행
- HTTP 요청
- JSON 질의
- 텍스트 변환
- 외부 API 호출

즉, "모델이 필요할 때 실행하는 기능"이 Tool입니다.

### 간단한 Tool 예시

```ts
import type { ToolDefinition } from "@goondan/openharness-types";

export function EchoTool(): ToolDefinition {
  return {
    name: "echo",
    description: "Return the input text as-is.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    async handler(args) {
      return { type: "text", text: String(args["text"] ?? "") };
    },
  };
}
```

## Connector는 _외부 이벤트를 OpenHarness 입구로 바꿉니다_

예:

- Slack event payload를 `InboundEnvelope`로 정규화
- webhook payload에서 conversation id를 추출
- cron payload를 특정 agent 입력 형식으로 바꿈

Connector는 transport 서버가 아니라 _정규화 어댑터_ 라고 이해하시면 편합니다.

## 기본 패키지에 무엇이 들어 있나요?

`@goondan/openharness-base`에는 아래가 포함됩니다.

Extensions:

- `BasicSystemPrompt`
- `MessageWindow`
- `CompactionSummarize`
- `Logging`
- `ToolSearch`
- `RequiredToolsGuard`

Tools:

- `BashTool`
- `FileReadTool`
- `FileWriteTool`
- `FileListTool`
- `HttpFetchTool`
- `JsonQueryTool`
- `TextTransformTool`
- `WaitTool`


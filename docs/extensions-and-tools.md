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
import type { Extension, ExtensionApi } from "@goondan/openharness-types";

export function BasicSystemPrompt(text: string): Extension {
  return {
    name: "basic-system-prompt",
    register(api: ExtensionApi) {
      api.pipeline.register("turn", async (ctx, next) => {
        ctx.conversation.emit({
          type: "append",
          message: {
            id: `sys-${Date.now()}`,
            data: { role: "system", content: text },
            metadata: { __createdBy: "basic-system-prompt" },
          },
        });
        return next();
      });
    },
  };
}
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

### 사람이 확인해야 하는 Tool

Tool 실행 전에 승인이나 입력 보완이 필요하면 `hitl` 정책을 붙입니다. HITL ToolCall은 handler 실행 전에 durable request로 저장되고, Turn은 `waitingForHuman` 상태로 멈춥니다. 이후 host application이 `runtime.control.submitHitlResult()`로 approve/reject/text/form 결과를 제출하면 runtime 내부 resume task가 같은 ToolCall snapshot을 재개합니다.

```ts
import { InMemoryHitlStore, createHarness } from "@goondan/openharness";
import type { ToolDefinition } from "@goondan/openharness-types";

const deleteFile: ToolDefinition = {
  name: "delete_file",
  description: "Delete a file after human approval.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  hitl: {
    mode: "required",
    response: { type: "approval" },
  },
  async handler(args) {
    return { type: "text", text: `deleted ${String(args["path"])}` };
  },
};

const hitlStore = new InMemoryHitlStore();
const runtime = await createHarness({
  agents: {
    assistant: {
      model: { provider: "openai", model: "gpt-4", apiKey: "test-key" },
      tools: [deleteFile],
    },
  },
  hitl: { store: hitlStore },
});
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

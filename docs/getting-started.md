# Getting Started

이 문서는 OpenHarness를 _처음 실제로 실행하는 사람_ 을 위한 안내입니다.

## 1. 무엇을 설치해야 하나요?

공통:

```bash
pnpm add @goondan/openharness @goondan/openharness-types ai
```

기본 Extension/Tool까지 쓰려면:

```bash
pnpm add @goondan/openharness-base
```

CLI까지 쓰려면:

```bash
pnpm add @goondan/openharness-cli dotenv
```

Provider SDK는 쓰는 것만 설치하세요.

- OpenAI: `pnpm add openai`
- Anthropic: `pnpm add @anthropic-ai/sdk`
- Google: `pnpm add @google/generative-ai`

## 2. 최소 설정 파일

OpenHarness CLI는 기본적으로 현재 작업 디렉토리의 `harness.config.ts`를 읽습니다.

```ts
import { defineHarness, env } from "@goondan/openharness-types";
import { OpenAI } from "@goondan/openharness/models";
import { BasicSystemPrompt, MessageWindow } from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      model: OpenAI({
        model: "gpt-4o-mini",
        apiKey: env("OPENAI_API_KEY"),
      }),
      extensions: [
        BasicSystemPrompt("You are helpful."),
        MessageWindow({ maxMessages: 20 }),
      ],
    },
  },
});
```

`.env` 예시:

```bash
OPENAI_API_KEY=...
```

## 3. CLI 사용법

### 한 번 실행

```bash
oh run "오늘 해야 할 일을 정리해줘"
```

### REPL

```bash
oh repl
```

### 여러 agent 중 하나 선택

```bash
oh run "로그를 요약해줘" --agent assistant
```

### 같은 대화 이어가기

```bash
oh run "내 이름은 차니야" --conversation demo-1
oh run "내 이름이 뭐라고 했지?" --conversation demo-1
```

## 4. Programmatic API

CLI 없이 코드에서 직접 만들 수도 있습니다.

```ts
import { createHarness } from "@goondan/openharness";
import { defineHarness, env } from "@goondan/openharness-types";
import { OpenAI } from "@goondan/openharness/models";

const config = defineHarness({
  agents: {
    assistant: {
      model: OpenAI({
        model: "gpt-4o-mini",
        apiKey: env("OPENAI_API_KEY"),
      }),
    },
  },
});

const runtime = await createHarness(config);
const result = await runtime.processTurn("assistant", "안녕하세요");
console.log(result.text);
await runtime.close();
```

## 5. 보통 처음 헷갈리는 것

- 시스템 프롬프트는 코어가 자동으로 넣지 않습니다.
- 도구는 `tools`에 넣어야만 모델이 볼 수 있습니다.
- 대화 기억은 `conversationId`를 같게 줘야 이어집니다.
- ingress 없이도 `processTurn()`으로 바로 시작할 수 있습니다.


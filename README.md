# OpenHarness

OpenHarness는 _에이전트 하네스를 조립하는 사람_ 을 위한 아주 얇은 코어입니다.
프롬프트 주입, 컨텍스트 관리, 도구 선택, ingress 처리 같은 것을 코어가 대신 정해주지 않고, Extension과 Tool 조합으로 직접 구성하게 합니다.

이 프로젝트가 잘 맞는 경우:

- 시스템 프롬프트, 대화 압축, 도구 전략을 직접 바꾸며 실험하고 싶을 때
- "기본값이 뭘 하고 있는지"보다 "내가 선언한 것만 동작하길" 원할 때
- barebone runtime 위에 팀/제품에 맞는 하네스를 쌓고 싶을 때

이 프로젝트가 덜 맞는 경우:

- 설치 직후 바로 완성형 에이전트를 쓰고 싶을 때
- 프롬프트/메모리/도구 기본 세트를 프레임워크가 자동으로 챙겨주길 원할 때

## 패키지 구성

- `@goondan/openharness`: 코어 런타임
- `@goondan/openharness/models`: provider 팩토리
- `@goondan/openharness-types`: 타입 계약
- `@goondan/openharness-base`: 기본 Extension/Tool 모음
- `@goondan/openharness-cli`: `oh run`, `oh repl`

## 빠른 시작

### 1. 필요한 패키지 설치

OpenAI 예시:

```bash
pnpm add @goondan/openharness @goondan/openharness-base @goondan/openharness-types @goondan/openharness-cli ai openai dotenv
```

Anthropic을 쓰면 `openai` 대신 `@anthropic-ai/sdk`, Google을 쓰면 `@google/generative-ai`를 설치하면 됩니다.

### 2. `harness.config.ts` 작성

```ts
import { defineHarness, env } from "@goondan/openharness-types";
import { OpenAI } from "@goondan/openharness/models";
import { BasicSystemPrompt, MessageWindow, BashTool } from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      model: OpenAI({
        model: "gpt-4o-mini",
        apiKey: env("OPENAI_API_KEY"),
        project: "openharness",
      }),
      extensions: [
        BasicSystemPrompt("You are helpful."),
        MessageWindow({ maxMessages: 20 }),
      ],
      tools: [
        BashTool(),
      ],
    },
  },
});
```

`OpenAI`, `Anthropic`, `Google` 팩토리는 각 AI SDK provider의 `createOpenAI`, `createAnthropic`, `createGoogleGenerativeAI` 옵션을 그대로 받습니다. `apiKey`는 선택값이라 provider 기본 환경 변수 규칙을 그대로 써도 됩니다.

### 3. 실행

```bash
# 단일 턴 실행
oh run "현재 디렉토리 파일 목록을 알려줘"

# 대화형 REPL
oh repl
```

에이전트가 여러 개면 `--agent`, 대화를 이어가려면 `--conversation`을 추가하세요.

```bash
oh run "요약해줘" --agent assistant --conversation demo-1
```

## OpenHarness를 올바르게 이해하는 핵심

- 코어는 _실행 루프_ 만 제공합니다.
- 시스템 프롬프트도 기본 제공되지 않습니다. `BasicSystemPrompt` 같은 Extension이 있어야 들어갑니다.
- 도구도 선언해야만 보입니다. "기본 툴"은 없습니다.
- 메시지는 `Message { id, data: ModelMessage, metadata }` envelope로 다룹니다.
- `metadata.__createdBy`는 코어 예약 provenance 키입니다.

즉, OpenHarness는 "에이전트를 그냥 쓰는 프레임워크"라기보다 "에이전트 하네스를 명시적으로 조립하는 런타임"에 가깝습니다.

## 어디까지 README에서 다루는가

README는 _처음 시작하는 데 필요한 최소한_ 만 담습니다.
아래 문서에서 더 자세히 보시는 걸 권장합니다.

- [Getting Started](docs/getting-started.md): 설치, 설정 파일, CLI, programmatic 사용
- [Migration: alpha → v0.1](docs/migration-alpha-to-v0.1.md): YAML/manifest 기반 alpha에서 code-first v0.1.x로 옮기는 방법
- [Architecture](docs/architecture.md): Turn/Step/ToolCall, ingress, conversation state
- [Extensions And Tools](docs/extensions-and-tools.md): 언제 Extension을 쓰고 언제 Tool을 쓰는지
- [Message Envelope](docs/message-envelope.md): `ModelMessage`, `metadata.__createdBy`, 이벤트 기반 메시지 조작
- [CONCEPTS.md](CONCEPTS.md): 왜 이런 구조인지에 대한 긴 설명

## 현재 상태

아직 alpha 단계입니다.
기본 철학은 꽤 분명하지만, API는 사용성 피드백을 받아 계속 다듬는 중입니다.

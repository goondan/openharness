# Migration Guide: `0.0.1-alpha4` → `0.1.x`

이 문서는 _alpha4를 이미 쓰고 있는 사람_ 이 `0.1.x`로 옮길 때 필요한 변경만 정리합니다.

결론부터 말하면, `0.1.x`는 **사실상 v2 line** 이라서 "몇 군데 고치면 끝" 수준이 아닙니다.
특히 `harness.yaml` / manifest 기반 구성을 쓰고 있었다면 _설정을 code-first로 다시 쓰는 작업_ 이 필요합니다.

## 먼저 요약

가장 큰 breaking change는 아래 4개입니다.

1. `harness.yaml` 기반 구성이 사라지고 `harness.config.ts` 기반으로 바뀌었습니다.
2. `createHarnessRuntimeFromYaml()` / `createRunnerFromHarnessYaml()` 같은 YAML 런타임 API가 사라졌습니다.
3. `Extension/basic-system-prompt`, `Tool/bash` 같은 manifest ref 대신, 실제 JS/TS 값을 import 해서 넣어야 합니다.
4. ingress / connection 설정 구조가 YAML 리소스 그래프가 아니라 plain object config로 바뀌었습니다.

즉, alpha4 → 0.1.x는 _설정 번역_ 이 핵심이고, 대부분의 경우 점진적 패치보다 한 번에 옮기는 편이 낫습니다.

## 무엇이 그대로고, 무엇이 바뀌었나요?

### 그대로인 것

- Turn → Step → ToolCall 실행 모델
- ingress를 `verify → normalize → route → dispatch`로 다루는 개념
- `Message.data`가 AI SDK `ModelMessage`라는 큰 방향
- `metadata.__createdBy` provenance 컨벤션

### 크게 바뀐 것

- 설정 방식: YAML → TypeScript
- runtime 생성 방식: YAML loader → `createHarness(config)`
- extension/tool 등록 방식: manifest ref → direct import
- package 구조: alpha4의 manifest/integrations 중심 구조 → 0.1.x의 code-first 패키지 구조

## 1. 설정 파일: `harness.yaml` → `harness.config.ts`

### alpha4

```yaml
apiVersion: goondan.ai/v1
kind: Model
metadata:
  name: claude
spec:
  provider: anthropic
  model: claude-sonnet-4-20250514
  apiKey:
    valueFrom:
      env: ANTHROPIC_API_KEY
---
apiVersion: goondan.ai/v1
kind: Agent
metadata:
  name: assistant
spec:
  modelConfig:
    modelRef: Model/claude
  extensions:
    - Extension/basic-system-prompt
```

### 0.1.x

```ts
import { defineHarness, env } from "@goondan/openharness-types";
import { Anthropic } from "@goondan/openharness/models";
import { BasicSystemPrompt } from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      model: Anthropic({
        model: "claude-sonnet-4-20250514",
        apiKey: env("ANTHROPIC_API_KEY"),
        headers: {
          "x-app-name": "openharness",
        },
      }),
      extensions: [
        BasicSystemPrompt("You are helpful."),
      ],
    },
  },
});
```

핵심 차이:

- 리소스 참조(`Model/claude`) 대신 JS 값 자체를 넣습니다.
- env 참조는 YAML `valueFrom.env` 대신 `env("...")`를 씁니다.
- 설정의 "해석 단계"가 줄고, import 시점에 구조가 더 명확해집니다.
- AI SDK provider 옵션(`baseURL`, `project`, `authToken`, `headers` 등)을 모델 팩토리에 그대로 넘길 수 있습니다.

## 2. Runtime API 변경

### alpha4

```ts
import {
  createHarnessRuntimeFromYaml,
  createRunnerFromHarnessYaml,
} from "@goondan/openharness";

const runtime = await createHarnessRuntimeFromYaml({
  workdir: process.cwd(),
  env: process.env,
});

const runner = await createRunnerFromHarnessYaml({
  workdir: process.cwd(),
  env: process.env,
});
```

### 0.1.x

```ts
import { createHarness } from "@goondan/openharness";
import config from "./harness.config.ts";

const runtime = await createHarness(config);
const result = await runtime.processTurn("assistant", "안녕하세요");
await runtime.close();
```

핵심 차이:

- YAML를 로드하는 runtime helper가 사라졌습니다.
- `processTurn()`은 이제 `agentName`을 명시적으로 받습니다.
- text input뿐 아니라 `InboundEnvelope`도 직접 넣을 수 있습니다.
- `TurnResult.status`에 `waitingForHuman`이 추가되었습니다. exhaustive switch를 쓰는 경우 이 상태를 처리해야 합니다.
- `runtime.control`에는 HITL request 조회, human result 제출, resume, cancel API가 추가되었습니다.

## 3. Extension / Tool 등록 방식 변경

### alpha4

manifest ref를 YAML에 적었습니다.

```yaml
extensions:
  - Extension/basic-system-prompt
tools:
  - Tool/bash
```

### 0.1.x

실제 구현을 import 해서 config에 넣습니다.

```ts
import { BasicSystemPrompt, BashTool } from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      // ...
      extensions: [
        BasicSystemPrompt("You are helpful."),
      ],
      tools: [
        BashTool(),
      ],
    },
  },
});
```

이 변경으로 얻는 것:

- 설정 파일만 봐도 실제 코드 연결이 더 명확함
- manifest registry 없이도 로컬/서드파티 extension을 바로 꽂을 수 있음
- TypeScript 타입 도움을 바로 받을 수 있음

### HITL 정책 추가

`ToolDefinition`에는 optional `hitl` 필드가 추가되었습니다. HITL 정책을 사용하는 tool이 있으면 runtime config에 `hitl.store`를 반드시 넣어야 합니다. store가 없으면 runtime 생성 또는 tool 실행 시 명확한 config error가 발생합니다.

```ts
import { InMemoryHitlStore } from "@goondan/openharness";

export default defineHarness({
  agents: {
    assistant: {
      // ...
      tools: [
        {
          name: "dangerous_action",
          description: "Requires approval.",
          parameters: { type: "object", additionalProperties: false },
          hitl: {
            mode: "required",
            response: { type: "approval" },
          },
          async handler() {
            return { type: "text", text: "done" };
          },
        },
      ],
    },
  },
  hitl: { store: new InMemoryHitlStore() },
});
```

## 4. Ingress 설정 변경

alpha4에서는 `Connector` / `Connection` 리소스를 YAML에서 선언했습니다.
0.1.x에서는 `connections` 아래 plain object로 정의합니다.

### alpha4

```yaml
kind: Connection
metadata:
  name: slack-main
spec:
  connectorRef: Connector/slack
  ingress:
    rules:
      - match:
          event: slack.message
        route:
          agentRef: Agent/assistant
          conversationIdProperty: threadTs
          conversationIdPrefix: "slack:"
```

### 0.1.x

```ts
import type { Connector } from "@goondan/openharness-types";

const slackConnector: Connector = {
  name: "slack",
  async normalize(ctx) {
    return {
      name: "slack.message",
      content: [{ type: "text", text: "hello" }],
      properties: {
        threadTs: "1712345678.000100",
      },
      source: {
        connector: "slack",
        connectionName: ctx.connectionName,
        receivedAt: ctx.receivedAt,
      },
    };
  },
};

export default defineHarness({
  agents: {
    assistant: {
      model: /* ... */,
    },
  },
  connections: {
    slackMain: {
      connector: slackConnector,
      rules: [
        {
          match: { event: "slack.message" },
          agent: "assistant",
          conversationIdProperty: "threadTs",
          conversationIdPrefix: "slack:",
        },
      ],
    },
  },
});
```

## 5. CLI 기준 변경

### alpha4

- YAML 기반 workflow
- `workdir + harness.yaml` 중심

### 0.1.x

- `harness.config.ts`를 기본 설정 파일로 읽음
- `oh run`, `oh repl`
- `--agent`, `--conversation`, `--config`로 제어

예:

```bash
oh run "현재 상태를 요약해줘" --agent assistant --conversation demo-1
```

## 6. Message API 관련 주의점

0.1.x에서는 메시지 envelope이 실행 경로 전반의 기본 전제가 되었으므로, 아래 가정에 기대고 있던 코드는 다시 확인해야 합니다.

- `message.role`, `message.content`에 직접 접근하는 코드
- 메시지 provenance를 별도 `source` 필드로 추적하는 코드
- tool call/result 파트 이름을 자체 포맷으로 가정하는 코드

0.1.x에서는 다음 구조를 기준으로 생각하는 게 안전합니다.

```ts
type Message = {
  id: string;
  data: ModelMessage;
  metadata?: Record<string, unknown>;
};
```

## 실제 migration 순서

추천 순서는 아래입니다.

1. `harness.yaml`를 지우고 `harness.config.ts`를 새로 만듭니다.
2. `Model/Agent/Tool/Extension/Connector/Connection` 리소스를 plain object config로 번역합니다.
3. manifest ref를 실제 import로 바꿉니다.
4. `createHarnessRuntimeFromYaml()` / `createRunnerFromHarnessYaml()` 호출을 `createHarness()`로 바꿉니다.
5. `processTurn()` 호출부를 `processTurn(agentName, input, options?)` 형태로 맞춥니다.
6. ingress 설정이 있으면 `connections` 구조로 다시 옮깁니다.
7. `message.role`, `message.content`에 직접 접근하는 내부 코드가 있으면 `message.data.role`, `message.data.content` 기준으로 정리합니다.
8. `pnpm typecheck`, `pnpm test`를 다시 돌립니다.

## 사실상 "재작성"으로 보는 게 맞는 경우

아래에 해당하면 부분 patch보다 _한 번에 다시 쓰는 것_ 이 오히려 덜 위험합니다.

- YAML manifest를 많이 썼다
- custom connector/connection이 있다
- alpha4의 runtime helper를 감싼 내부 wrapper가 많다
- extension/tool loading을 ref 문자열 중심으로 추상화해뒀다

이 경우 0.1.x를 alpha4의 "다음 버전"이라기보다, **같은 문제를 더 단순한 code-first API로 다시 푼 v2 line** 으로 받아들이는 편이 현실적입니다.

## migration 후 확인 체크리스트

- `harness.config.ts`가 default export를 내보내는가
- provider SDK가 실제로 설치되어 있는가
- agent 이름을 `processTurn()` / `oh run --agent`에서 맞게 넘기는가
- `conversationId`를 이어야 하는 곳에서 명시적으로 주고 있는가
- custom extension이 `message.data` 기준으로 동작하는가
- ingress rule의 `agent` 이름과 실제 `agents` 키가 일치하는가

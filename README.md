# OpenHarness

`@goondan/openharness`는 에이전트 내부 실행 엔진을 위한 barebone harness framework입니다.

- Turn / Step / ToolCall 기반 LLM 파이프라인을 독립 라이브러리로 제공합니다.
- `harness.yaml`로 `Model`, `Agent`, `Tool`, `Extension`, `Connector`, `Connection` 리소스를 조립할 수 있습니다.
- ingress 표준화 범위는 `수신 -> 검증 -> 정규화 -> 라우팅 -> 비동기 turn 접수`까지입니다.
- Slack, Telegram, Webhook 서버 같은 transport는 퍼스트파티로 제공하지 않습니다. 외부 호스트가 payload를 받아 OpenHarness ingress API를 호출하는 구조를 전제로 합니다.
- outbound(reply/send/edit/delete/react)는 공통 포트로 만들지 않고 tool/extension 계층에 남깁니다.
- ingress hook scope는 둘로 나뉩니다.
  - `Connection.extensions`: pre-route ingress(`verify`, `normalize`)
  - `Agent.extensions`: post-route ingress(`route`, `dispatch`) + 기존 turn/step/toolCall

## 핵심 개념

### 1. `processTurn()`은 텍스트 입력용 편의 API

CLI나 테스트처럼 텍스트 한 줄을 바로 턴으로 넣고 싶을 때는 기존 `processTurn(text)`를 그대로 사용할 수 있습니다.

### 2. `ingress.receive()` / `ingress.dispatch()`는 외부 입력용 API

- `receive({ connectionName, payload })`
  - Connector adapter의 `verify -> normalize -> route -> dispatch`를 수행합니다.
  - 하나의 raw payload가 여러 개의 정규화 이벤트로 fan-out 될 수 있으므로 배열을 반환합니다.
- `dispatch({ connectionName, event })`
  - 외부 시스템이 이미 `InboundEnvelope`로 정규화한 이벤트를 바로 넣는 low-level entrypoint입니다.
  - 이 경로는 `verify`, `normalize`를 우회하고 `route -> dispatch`만 수행합니다.

두 API 모두 turn 완료를 기다리지 않고, 즉시 accepted handle을 반환합니다.

## Connector adapter 계약

Connector 리소스의 `spec.entry`는 transport listener가 아니라 정규화 어댑터 모듈을 가리킵니다.

```ts
import type { ConnectorAdapter } from "@goondan/openharness-types";

const adapter: ConnectorAdapter = {
  async verify(ctx) {
    // 서명, 토큰, 중복 검사
  },
  async normalize(ctx) {
    return {
      name: "slack.message",
      content: [{ type: "text", text: "hello" }],
      properties: {
        channelId: "C123",
        threadTs: "1712345678.000100",
      },
      source: { kind: "connector", name: "slack" },
      rawPayload: ctx.payload,
    };
  },
};

export default adapter;
```

정규화 결과는 `InboundEnvelope`이며, 입력 본문은 `content[]` 중심으로 표현합니다. `input` 문자열은 runtime 내부 호환 alias로만 유지됩니다.

## `harness.yaml` 예시

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
    - Extension/context-message
---
apiVersion: goondan.ai/v1
kind: Connector
metadata:
  name: slack
spec:
  entry: ./connectors/slack-adapter.js
  events:
    - name: slack.message
---
apiVersion: goondan.ai/v1
kind: Connection
metadata:
  name: slack-main
spec:
  connectorRef: Connector/slack
  extensions:
    - Extension/slack-ingress
  ingress:
    rules:
      - match:
          event: slack.message
        route:
          agentRef: Agent/assistant
          conversationIdProperty: threadTs
          conversationIdPrefix: "slack:"
```

## Programmatic API

```ts
import {
  createHarnessRuntimeFromYaml,
  createRunnerFromHarnessYaml,
} from "@goondan/openharness";

const runtime = await createHarnessRuntimeFromYaml({
  workdir: process.cwd(),
  env: process.env,
});

await runtime.ingress.receive({
  connectionName: "slack-main",
  payload: rawWebhookBody,
});

const runner = await createRunnerFromHarnessYaml({
  workdir: process.cwd(),
  env: process.env,
});

const output = await runner.processTurn("현재 상태를 요약해줘");
console.log(output.finalResponseText);
```

- `createHarnessRuntimeFromYaml()` 반환값: `{ processTurn, ingress, close }`
- `createHarnessRuntimeFromYaml()`는 ingress 포함 상위 runtime입니다. `processTurn()`은 기본 Agent가 결정되는 경우에만 사용합니다.
- `createRunnerFromHarnessYaml()`는 내부적으로 runtime을 만든 뒤 기본 Agent를 고정하고, 텍스트 입력용 `conversationId`를 함께 제공하는 convenience wrapper입니다.

## 문서

- [SPEC.md](./SPEC.md): `harness.yaml`, ingress adapter 계약, 상위 runtime API, acceptance criteria

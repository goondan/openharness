# OpenHarness 핵심 컨셉 가이드

> 이 문서는 OpenHarness를 처음 접하는 사람을 위한 개념 설명서입니다.
> 코드를 한 줄도 읽지 않아도 전체 구조를 파악할 수 있도록 작성했습니다.

---

## 한 문장 요약

**OpenHarness는 순수한 barebone composable harness입니다.**

"순수하다"는 것은 코어가 실행 로직만 제공한다는 뜻입니다. 시스템 프롬프트 주입, 대화 기록 관리, 컨텍스트 윈도우 제한 — 이런 것들은 코어에 없습니다. 전부 Extension으로 구현됩니다.

"composable"이라는 것은 이 Extension들을 자유롭게 조합하고 교체할 수 있다는 뜻입니다. LLM에 들어가는 메시지와 도구를 Extension 조합으로 세밀하게 제어할 수 있는 것이 OpenHarness의 가장 특징적인 지점입니다.

---

## 왜 OpenHarness를 쓰는가

### 교체 한 줄로 끝나는 실험

에이전트 하네스를 다양하게 실험하는 사람에게 가장 중요한 것은, **나머지 조건을 고정한 채 한 변수만 바꿀 수 있는 구조**입니다.

예를 들어 컨텍스트 압축 전략을 비교한다고 합시다. LLM으로 요약하는 방식, 핵심 문장만 추출하는 방식, 계층적 메모리를 쓰는 방식 — 이것들이 각각 독립된 Extension입니다. 비교하려면 import 한 줄만 바꾸면 됩니다:

```ts
import { defineHarness } from "@goondan/openharness";
import { ContextMessage } from "@goondan/openharness-base";
// import { CompactionSummarize } from "@someone/compaction-summarize";
import { CompactionExtractive } from "@someone/compaction-extractive";

export default defineHarness({
  agents: {
    assistant: {
      extensions: [
        ContextMessage(),
        CompactionExtractive({ threshold: 20 }),  // ← 이것만 교체
      ],
    },
  },
});
```

코어, 도구, 다른 Extension은 그대로입니다. 여러 사람이 동일한 문제(컨텍스트 압축, 프롬프트 관리, 도구 선택 전략 등)에 대해 각자 좋다고 생각하는 구현을 만들고, npm 패키지로 공유하고, 언제든 교체해서 비교할 수 있습니다.

### 플러그인 생태계

Extension과 Tool은 표준 포트를 따르는 npm 패키지입니다. 작성자는 코드를 쓰고 publish하면 되고, 사용자는 `pnpm add` + import로 끝입니다. 매니페스트나 별도 설정 파일 없이, Node.js 모듈 시스템이 의존성 해석을 알아서 합니다.

### 에이전트가 자기 하네스를 읽고 바꿀 수 있다

대부분의 프레임워크에서 에이전트의 설정은 소스 코드에 묻혀 있습니다. 에이전트가 "나는 지금 어떤 컨텍스트 관리 전략을 쓰고 있지?"를 알려면 복잡한 런타임 내부를 읽어야 합니다.

OpenHarness에서는 에이전트가 런타임 API로 자기 구성을 구조화된 데이터로 조회할 수 있습니다. 복잡한 소스 코드를 일일이 읽지 않아도, **포트 수준의 추상화만으로 자기 구성을 이해하고 조작**할 수 있습니다.

1. 런타임 API로 현재 구성을 파악한다 — "나는 `message-window`로 최근 20개 메시지만 보고 있다"
2. 상황에 따라 더 나은 전략을 판단한다 — "이 작업은 긴 컨텍스트가 필요하니 `compaction-extractive`가 낫겠다"
3. 설정을 수정하고 재시작하면 새 구성으로 동작한다

이것이 가능한 이유는, 코어가 순수하고 Extension이 표준 포트를 통해 꽂히기 때문입니다. 코어가 암묵적으로 하는 일이 없으므로, 설정에 적힌 것이 에이전트의 전체 구성이고 숨겨진 동작은 없습니다.

---

# Part 1: 코어 — 순수한 barebone harness

코어(`@goondan/openharness`)가 제공하는 것은 딱 세 가지입니다:

1. **실행 루프** — Turn → Step → ToolCall 사이클
2. **미들웨어 훅** — 실행 루프의 각 단계에 Extension이 꽂힐 수 있는 개입 지점
3. **표준 포트** — Tool, Extension, Connector를 등록하는 레지스트리

코어는 그 이상을 하지 않습니다. 시스템 프롬프트를 넣어주지 않고, 기본 도구를 자동 등록하지 않고, 대화 이력을 알아서 관리하지 않습니다.

---

## 실행 루프: Turn → Step → ToolCall

코어가 제공하는 실행 사이클입니다.

```
Turn (사용자 메시지 하나 → 최종 응답까지)
 │
 └─ Step 1: LLM 호출 → LLM이 도구 사용 요청
 │   ├─ ToolCall A 실행
 │   └─ ToolCall B 실행
 │
 └─ Step 2: 도구 결과 + 메시지를 LLM에 다시 전달 → LLM이 추가 도구 요청
 │   └─ ToolCall C 실행
 │
 └─ Step 3: 도구 결과를 LLM에 전달 → LLM이 텍스트 응답 반환 → Turn 종료
```

### Turn

사용자의 메시지 하나에 대한 전체 처리 과정입니다.

### Step

Turn 안에서 LLM을 한 번 호출하는 단위입니다. LLM이 도구 사용을 요청하면 → 도구 실행 → 결과를 다시 LLM에 전달하는 것이 하나의 Step이고, LLM이 더 이상 도구를 요청하지 않을 때까지 반복됩니다.

### ToolCall

하나의 Step에서 실행되는 개별 도구 호출입니다. LLM이 한 번에 여러 도구를 요청할 수 있으므로, 한 Step에 ToolCall이 여러 개 생길 수 있습니다.

**코어는 이 루프를 돌리는 것이 전부입니다.** LLM에 어떤 메시지가 들어갈지, 어떤 도구가 보일지는 코어가 결정하지 않습니다.

---

## 미들웨어 훅: Extension이 꽂히는 지점

코어는 실행 루프의 세 단계 각각에 미들웨어 훅을 노출합니다.

| 훅 레벨 | 개입 시점 | Extension이 할 수 있는 일 |
|---------|----------|------------------------|
| **Turn** | 전체 턴 실행 전/후 | 로깅, 실행 시간 측정, 에러 핸들링 |
| **Step** | LLM 호출 직전/직후 | **메시지 목록 조작**, 컨텍스트 주입, 대화 기록 압축 |
| **ToolCall** | 도구 실행 직전/직후 | 인자 검증, 결과 가공, 호출 차단, 감사 로그 |

미들웨어는 chain-of-responsibility 패턴으로 동작합니다:

```
[요청] → 미들웨어 A → 미들웨어 B → [코어 로직] → 미들웨어 B → 미들웨어 A → [응답]
```

**코어는 훅만 제공합니다.** 어떤 미들웨어가 등록되느냐는 전적으로 어떤 Extension을 활성화하느냐에 따라 달라집니다.

---

## 표준 포트: Tool, Extension, Connector 레지스트리

코어는 세 종류의 플러그를 꽂을 수 있는 레지스트리를 제공합니다.

| 포트 | 등록 대상 | 역할 |
|------|----------|------|
| **Tool Registry** | Tool 핸들러 | LLM이 호출 가능한 도구 카탈로그 관리 |
| **Pipeline Registry** | 미들웨어 | Turn/Step/ToolCall 훅에 미들웨어 등록 |
| **Ingress Registry** | Ingress 미들웨어 | Verify/Normalize/Route/Dispatch 훅에 미들웨어 등록 |

도구가 등록되면 코어는 JSON Schema에 따른 인자 검증과 에러 핸들링을 수행합니다. 하지만 **어떤 도구가 등록되느냐는 사용자가 어떤 Tool을 구성에 포함시키느냐에 따라 결정됩니다.**

---

## 명시적 선택 원칙

> **"암묵적으로 켜지는 것은 없다."**

이것은 코어의 "순수함"을 지탱하는 핵심 원칙입니다.

- 도구를 선언하지 않으면 → 도구 없음. 자동으로 추가되는 기본 도구가 없습니다.
- Extension을 선언하지 않으면 → 확장 없음. **시스템 프롬프트조차 주입되지 않습니다.**
- 코어에 fallback 시스템 메시지가 없습니다. fallback 사용자 메시지 형식도 없습니다.

선언한 것이 전부이고, 숨겨진 동작은 없습니다.

---

## Ingress: Turn을 시작시키는 입구

Ingress는 "외부 이벤트를 받아서 Turn을 시작시키는 입구"입니다. 이벤트 소스는 HTTP webhook만이 아닙니다. cron 스케줄, 파일 시스템 watch, 큐 consumer, 다른 에이전트의 출력 — Turn을 촉발하는 모든 것이 Ingress가 될 수 있습니다.

```
이벤트 소스 (Slack webhook, cron, 큐, 파일 변경, ...)
  │
  ▼
① Verify    ─ 검증 (서명 확인, 중복 체크 등)
  │
  ▼
② Normalize ─ 소스별 형식 → InboundEnvelope 표준 형식
  │
  ▼
③ Route     ─ 라우팅 규칙에 따라 대상 Agent 결정
  │
  ▼
④ Dispatch  ─ Agent 세션에 Turn 비동기 접수
```

실행 파이프라인과 마찬가지로, 4단계 각각에 미들웨어 훅이 있어서 Extension이 개입할 수 있습니다.

Connector는 transport 서버나 스케줄러가 아니라 순수한 정규화 어댑터입니다. 외부 호스트가 이벤트를 수신하고 ingress API를 호출하는 구조를 전제합니다.

---

## 대화 상태: 이벤트 소싱

코어는 대화 상태를 **기본 메시지 목록(base) + 이벤트 스트림**으로 관리합니다.

| 이벤트 | 동작 |
|--------|------|
| `append` | 메시지 추가 |
| `replace` | 특정 메시지를 다른 내용으로 교체 |
| `remove` | 특정 메시지 삭제 |
| `truncate` | 지정 개수 초과분 잘라내기 |

코어는 이 이벤트 시스템의 인프라만 제공합니다. 실제로 이벤트를 발생시켜서 메시지 목록을 조작하는 것은 Extension의 일입니다.

---

## 중단 제어: AbortSignal

코어가 제공하는 런타임 프리미티브입니다. 하나의 `AbortSignal`이 Turn → Step → ToolCall → LLM 호출까지 전체 체인을 관통합니다. 미들웨어와 도구 핸들러 모두 중단 여부를 확인할 수 있습니다.

---

# Part 2: Extension — LLM의 입력과 행동을 제어하는 계층

코어가 순수한 실행 로직만 제공하므로, 실질적으로 "LLM이 무엇을 보고, 무엇을 할 수 있는가"를 결정하는 것은 전부 Extension입니다.

Extension은 코어의 미들웨어 훅에 등록되어 동작합니다. 미들웨어를 등록해서 실행 흐름에 개입하고, 도구를 동적으로 추가할 수도 있습니다.

---

## LLM 입력 제어 — Extension이 메시지를 결정한다

코어만 있으면 LLM은 빈 메시지 목록을 받습니다. Extension이 Step 미들웨어를 통해 메시지 목록을 만들어줘야 합니다.

```
코어만 있을 때:
  LLM 입력 = (빈 메시지 목록)

Extension을 추가하면:
  LLM 입력 = base 메시지 목록
    + append(시스템 프롬프트)            ← ContextMessage
    + append(인바운드 이벤트 컨텍스트)    ← ContextMessage
    + replace(오래된 메시지 → 요약본)    ← CompactionSummarize
    + truncate(최근 N개만 유지)          ← MessageWindow
```

**시스템 프롬프트부터 Extension입니다.** `ContextMessage` Extension을 활성화하지 않으면 시스템 프롬프트에 뭘 적어도 LLM에 전달되지 않습니다. 이것이 "순수한 barebone"의 의미입니다.

### 입력 제어 Extension 예시

| Extension | 하는 일 |
|-----------|--------|
| `ContextMessage` | 시스템 프롬프트를 시스템 메시지로 주입하고, 인바운드 이벤트의 내용을 사용자 메시지로 주입 |
| `CompactionSummarize` | 대화가 길어지면 오래된 메시지를 LLM으로 요약해서 교체 |
| `MessageWindow` | 최근 N개 메시지만 남기고 나머지를 잘라냄 |

이 Extension들은 전부 `@goondan/openharness-base` 패키지에 포함되어 있지만, **코어의 일부가 아닙니다.** 별도 패키지이며, 명시적으로 선언해야 활성화됩니다.

---

## LLM 행동 제어 — Extension이 도구를 관리한다

코어의 Tool Registry에 어떤 도구가 들어가느냐에 따라 LLM이 할 수 있는 행동이 달라집니다.

### 정적 도구 선언

구성에서 Agent에 포함시킨 Tool이 카탈로그에 등록됩니다.

```ts
export default defineHarness({
  agents: {
    assistant: {
      tools: [
        FileSystem({ allowWrite: false }),  // 파일 읽기만 가능
        HttpFetch(),                        // HTTP 요청 가능
        // Bash는 포함하지 않았으므로 셸 실행 불가
      ],
    },
  },
});
```

### Extension을 통한 동적 도구 관리

| Extension | 하는 일 |
|-----------|--------|
| `ToolSearch` | 대량의 도구가 있을 때, LLM이 검색을 통해 필요한 도구를 동적으로 발견 |
| `RequiredToolsGuard` | 필수 도구가 카탈로그에 있는지 Turn 시작 전에 검증 |

ToolCall 미들웨어를 직접 작성하면 도구 호출의 인자를 검증하거나, 특정 조건에서 호출을 차단하거나, 결과를 가공할 수도 있습니다.

---

## 관측 — Extension이 실행을 감시한다

| Extension | 하는 일 |
|-----------|--------|
| `Logging` | Turn/Step/ToolCall의 시작/완료/실패 이벤트를 로그 출력 |

코어 자체도 OTel 호환 이벤트를 발생시키지만, 그 이벤트를 수신해서 실제로 뭔가 하는 것(로그 출력, 메트릭 수집 등)은 Extension의 몫입니다.

---

# Part 3: 조립 — code-first 구성

코어와 Extension이 분리되어 있으므로, 이 둘을 조합하는 방법이 필요합니다.

OpenHarness는 **code-first**를 기본 조립 방식으로 사용합니다. Extension과 Tool은 npm 패키지이고, `import`가 곧 의존성 선언입니다. 별도의 매니페스트 파일이나 리소스 해석 레이어 없이, Node.js 모듈 시스템이 의존성 해석을 처리합니다.

---

## defineHarness

Vite, Vitest, ESLint와 비슷한 패턴입니다. `harness.config.ts` 파일 하나가 에이전트의 전체 구성을 선언합니다.

```ts
// harness.config.ts
import { defineHarness } from "@goondan/openharness";
import { Anthropic } from "@goondan/openharness/models";
import {
  ContextMessage,
  MessageWindow,
  Logging,
  FileSystem,
  HttpFetch,
} from "@goondan/openharness-base";

export default defineHarness({
  agents: {
    assistant: {
      model: Anthropic({
        model: "claude-sonnet-4-20250514",
        apiKey: env("ANTHROPIC_API_KEY"),
      }),
      extensions: [
        ContextMessage(),
        MessageWindow({ maxMessages: 30 }),
        Logging({ level: "info" }),
      ],
      tools: [
        FileSystem({ allowWrite: false }),
        HttpFetch(),
      ],
    },
  },
});
```

이 파일이 있으면 `oh` CLI로 바로 실행됩니다:

```bash
oh run "안녕하세요"
```

`oh`는 현재 디렉토리의 `harness.config.ts`를 읽어서 런타임을 생성하고 Turn을 실행합니다.

이 방식의 장점:

- **TypeScript 타입 체크와 IDE 자동완성**이 바로 동작합니다
- **`import`가 곧 의존성 선언**이므로 별도의 패키지 해석 레이어가 불필요합니다
- **Extension config가 타입 안전**합니다 — `MessageWindow({ maxMessages: 30 })`의 `maxMessages`가 타입 체크됩니다
- **매니페스트 이중 관리가 없습니다** — 코드가 곧 선언입니다

### 프로그래밍 방식으로 사용하기

CLI 없이 자체 애플리케이션에 임베드할 때는 같은 설정을 코드에서 직접 사용합니다:

```ts
import { createHarness } from "@goondan/openharness";
import { ContextMessage } from "@goondan/openharness-base";

const runtime = await createHarness({
  agents: {
    assistant: {
      model: /* ... */,
      extensions: [ContextMessage()],
    },
  },
});

const output = await runtime.processTurn("assistant", "안녕하세요");
console.log(output.finalResponseText);
```

Ingress를 통한 외부 이벤트 수신이 필요하면, 같은 설정에 `connections`를 추가합니다:

```ts
const runtime = await createHarness({
  agents: { assistant: { /* ... */ } },
  connections: {
    "slack-main": {
      connector: SlackConnector(),
      rules: [
        { match: { event: "slack.message" }, agent: "assistant" },
      ],
    },
  },
});

// 외부 호스트가 이벤트를 받아서 호출
await runtime.ingress.receive({
  connectionName: "slack-main",
  payload: rawWebhookBody,
});
```

---

## Extension/Tool 만들기

Extension을 만드는 과정은 간단합니다.

```ts
// @someone/compaction-extractive 패키지의 index.ts
import type { ExtensionApi } from "@goondan/openharness-types";

interface CompactionConfig {
  threshold?: number;
  strategy?: "sentence" | "paragraph";
}

export function CompactionExtractive(config: CompactionConfig = {}) {
  return {
    name: "compaction-extractive",
    register(api: ExtensionApi) {
      api.pipeline.register("step", async (ctx, next) => {
        const messages = ctx.conversation.nextMessages;
        if (messages.length > (config.threshold ?? 20)) {
          // 핵심 문장만 추출하는 로직
        }
        await next();
      }, { priority: 100 });
    },
  };
}
```

작성자가 해야 할 일:

```
코드 작성 → tsc → npm publish
```

사용자가 해야 할 일:

```
pnpm add @someone/compaction-extractive → import → harness.config.ts에 추가
```

매니페스트, 빌드 스크립트, entry 경로 관리 — 이런 것들이 전부 사라집니다.

---

## 패키지 구조

코어와 Extension의 분리는 npm 패키지 수준에서도 반영됩니다.

```
@goondan/openharness-types       순수 타입 정의. 런타임 의존성 제로.
        ↑
@goondan/openharness             코어: 실행 루프, 레지스트리, 미들웨어 훅
        ↑
@goondan/openharness-cli         CLI 도구 (`oh` 명령어)

@goondan/openharness-types
        ↑
@goondan/openharness-base        Extension 계층: 기본 제공 Tool 6종 + Extension 6종
        ↑
@goondan/openharness-integrations   Extension 계층: Slack, Telegram 연동 도구
```

`core`와 `base`는 별도 패키지입니다. `base`의 Tool과 Extension은 편의를 위해 기본 제공될 뿐, 코어의 일부가 아닙니다.

### 기본 제공 Tool (base 패키지)

| Tool | 기능 |
|------|------|
| `Bash` | 셸 명령/스크립트 실행 |
| `FileSystem` | 파일 읽기/쓰기/목록/디렉토리 생성 |
| `HttpFetch` | HTTP GET/POST 요청 |
| `JsonQuery` | JSON 데이터 쿼리/추출 |
| `TextTransform` | 텍스트 치환/분할/결합/변환 |
| `Wait` | 지정 시간 대기 |

### 기본 제공 Extension (base 패키지)

| Extension | 하는 일 | 제어 대상 |
|-----------|--------|----------|
| `ContextMessage` | 시스템 프롬프트 및 인바운드 컨텍스트 주입 | 입력 |
| `CompactionSummarize` | 긴 대화 기록을 요약본으로 압축 | 입력 |
| `MessageWindow` | 최근 N개 메시지만 LLM에 전달 | 입력 |
| `Logging` | Turn/Step/ToolCall 이벤트 로깅 | 관측 |
| `ToolSearch` | 동적 도구 검색/발견 | 행동 |
| `RequiredToolsGuard` | 필수 도구 존재 여부 검증 | 행동 |

---

## 요약: 코어와 Extension의 경계

| | 코어가 하는 일 | Extension이 하는 일 |
|---|---|---|
| **실행** | Turn → Step → ToolCall 루프를 돌린다 | 루프의 각 단계에 미들웨어로 개입한다 |
| **메시지** | 이벤트 소싱 인프라를 제공한다 | 이벤트를 발생시켜 LLM 입력을 결정한다 |
| **도구** | Tool Registry와 JSON Schema 검증을 제공한다 | 도구 구현체를 등록하고, 호출을 감시/차단한다 |
| **프롬프트** | 아무것도 하지 않는다 | 시스템 프롬프트와 사용자 메시지를 주입한다 |
| **Ingress** | 4단계 파이프라인을 돌린다 | 각 단계에 미들웨어로 개입한다 |
| **관측** | OTel 호환 이벤트를 발생시킨다 | 이벤트를 수신해서 로깅/메트릭을 수행한다 |

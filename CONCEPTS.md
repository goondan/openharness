# OpenHarness 핵심 컨셉 가이드

> 이 문서는 OpenHarness를 처음 접하는 사람을 위한 개념 설명서입니다.
> 코드를 한 줄도 읽지 않아도 전체 구조를 파악할 수 있도록 작성했습니다.

---

## 한 문장 요약

**OpenHarness는 순수한 barebone harness 프레임워크입니다.**

"순수하다"는 것은 코어 런타임이 실행 로직만 제공한다는 뜻입니다. 시스템 프롬프트 주입, 대화 기록 관리, 컨텍스트 윈도우 제한 — 이런 것들은 코어에 없습니다. 전부 Extension으로 구현됩니다.

이 설계가 만들어내는 특징적인 지점이 있습니다: **LLM에 들어가는 메시지와 도구를 Extension을 통해 아주 세밀하게 제어할 수 있다는 것입니다.** 코어는 실행 루프와 미들웨어 훅만 제공하고, 그 훅에 꽂히는 Extension이 LLM의 입력과 행동을 실질적으로 결정합니다.

---

## 왜 OpenHarness를 쓰는가

### 교체 한 줄로 끝나는 실험

에이전트 하네스를 다양하게 실험하는 사람에게 가장 중요한 것은, **나머지 조건을 고정한 채 한 변수만 바꿀 수 있는 구조**입니다.

예를 들어 컨텍스트 압축 전략을 비교한다고 합시다. LLM으로 요약하는 방식, 핵심 문장만 추출하는 방식, 계층적 메모리를 쓰는 방식 — 이것들이 각각 독립된 Extension으로 존재합니다. 비교하려면 `harness.yaml`에서 한 줄만 바꾸면 됩니다:

```yaml
extensions:
  - Extension/context-message
  # - Extension/message-compaction-summarize    ← 이번에는 이걸 끄고
  - Extension/message-compaction-extractive      # ← 이걸 켠다
```

코어, 도구, 다른 Extension은 그대로입니다. 다른 프레임워크에서는 이 수준의 교체가 보통 코드 수준 리팩토링을 수반하지만, OpenHarness에서는 선언 한 줄입니다.

여러 사람이 동일한 문제(컨텍스트 압축, 프롬프트 관리, 도구 선택 전략 등)에 대해 각자 좋다고 생각하는 구현을 만들고, 그것을 플러그인으로 공유하고, 언제든 교체해서 비교할 수 있습니다.

### 에이전트가 자기 하네스를 읽고 바꿀 수 있다

대부분의 프레임워크에서 에이전트의 설정은 소스 코드에 묻혀 있습니다. 에이전트가 "나는 지금 어떤 컨텍스트 관리 전략을 쓰고 있지?"를 알려면 복잡한 런타임 내부를 읽어야 합니다.

OpenHarness에서는 `harness.yaml`이라는 **사람도 읽을 수 있고 에이전트도 읽을 수 있는 선언적 명세**가 있습니다. 에이전트가 할 수 있는 일:

1. 자기 `harness.yaml`을 읽고 현재 구성을 파악한다 — "나는 `message-window`로 최근 20개 메시지만 보고 있다"
2. 상황에 따라 더 나은 전략을 판단한다 — "이 작업은 긴 컨텍스트가 필요하니 `message-compaction`이 낫겠다"
3. `harness.yaml`을 수정하고 재시작하면 새 구성으로 동작한다

이것이 가능한 이유는, 코어가 순수하고 Extension이 표준 포트를 통해 꽂히기 때문입니다. 에이전트가 복잡한 소스 코드를 일일이 읽지 않아도, **포트 수준의 추상화만으로 자기 구성을 이해하고 조작**할 수 있습니다.

### harness.yaml = 현재 상태

`harness.yaml`은 단일 진실 원천입니다. 코어가 암묵적으로 하는 일이 없기 때문에, **이 파일에 적힌 것이 에이전트의 전체 구성이고, 숨겨진 동작은 없습니다.** 코드 리뷰에서 "이 에이전트가 뭘 하는지" 파악하려고 여러 파일을 뒤질 필요가 없고, 에이전트 자신도 같은 파일 하나로 자기 상태를 완전히 파악할 수 있습니다.

---

# Part 1: 코어 — 순수한 barebone harness

코어 런타임(`@goondan/openharness`)이 제공하는 것은 딱 세 가지입니다:

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

도구가 등록되면 코어는 JSON Schema에 따른 인자 검증과 에러 핸들링을 수행합니다. 하지만 **어떤 도구가 등록되느냐는 `harness.yaml`에서 Agent가 어떤 Tool을 참조하느냐에 따라 결정됩니다.**

---

## 명시적 선택 원칙

> **"암묵적으로 켜지는 것은 없다."**

이것은 코어의 "순수함"을 지탱하는 핵심 원칙입니다.

- `Agent.tools`가 비어 있으면 → 도구 없음. 자동으로 추가되는 기본 도구가 없습니다.
- `Agent.extensions`가 비어 있으면 → 확장 없음. **시스템 프롬프트조차 주입되지 않습니다.**
- 코어에 fallback 시스템 메시지가 없습니다. fallback 사용자 메시지 형식도 없습니다.

`harness.yaml`에 적힌 것이 전부이고, 숨겨진 동작은 없습니다.

---

## Ingress: 외부 입력의 표준화

외부 플랫폼(Slack, Telegram, HTTP API 등)에서 메시지가 들어올 때의 처리 파이프라인입니다. 이것도 코어가 제공하는 실행 로직입니다.

```
외부 payload
  │
  ▼
① Verify    ─ 서명/토큰 검증
  │
  ▼
② Normalize ─ 플랫폼별 형식 → InboundEnvelope 표준 형식
  │
  ▼
③ Route     ─ Connection의 규칙에 따라 대상 Agent 결정
  │
  ▼
④ Dispatch  ─ Agent 세션에 Turn 비동기 접수
```

실행 파이프라인과 마찬가지로, 4단계 각각에 미들웨어 훅이 있어서 Extension이 개입할 수 있습니다.

Connector는 transport 서버가 아니라 순수한 정규화 어댑터입니다. 외부 호스트가 payload를 수신하고 `ingress.receive()`를 호출하는 구조를 전제합니다.

---

## 중단 제어: AbortSignal

코어가 제공하는 또 하나의 런타임 프리미티브입니다.

```ts
await runtime.control.abortConversation({
  conversationId: "slack:C123:thread-1",
  reason: "user requested stop",
});
```

하나의 `AbortSignal`이 Turn → Step → ToolCall → LLM 호출까지 전체 체인을 관통합니다.

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

# Part 2: Extension — LLM의 입력과 행동을 제어하는 계층

코어가 순수한 실행 로직만 제공하므로, 실질적으로 "LLM이 무엇을 보고, 무엇을 할 수 있는가"를 결정하는 것은 전부 Extension입니다.

Extension은 코어의 미들웨어 훅에 등록되어 동작합니다. `api.pipeline.register()`로 Turn/Step/ToolCall 미들웨어를 등록하고, `api.tools.register()`로 도구를 동적으로 추가할 수도 있습니다.

---

## LLM 입력 제어 — Extension이 메시지를 결정한다

코어만 있으면 LLM은 빈 메시지 목록을 받습니다. Extension이 Step 미들웨어를 통해 메시지 목록을 만들어줘야 합니다.

```
코어만 있을 때:
  LLM 입력 = (빈 메시지 목록)

Extension을 추가하면:
  LLM 입력 = base 메시지 목록
    + append(시스템 프롬프트)            ← context-message
    + append(인바운드 이벤트 컨텍스트)    ← context-message
    + replace(오래된 메시지 → 요약본)    ← message-compaction
    + truncate(최근 N개만 유지)          ← message-window
```

**시스템 프롬프트부터 Extension입니다.** `context-message` Extension을 활성화하지 않으면 `Agent.prompt.system`에 뭘 적어도 LLM에 전달되지 않습니다. 이것이 "순수한 barebone"의 의미입니다.

### 입력 제어 Extension 예시

| Extension | 하는 일 |
|-----------|--------|
| `context-message` | `Agent.prompt.system`을 시스템 메시지로 주입하고, 인바운드 이벤트의 `content`를 사용자 메시지로 주입 |
| `message-compaction` | 대화가 길어지면 오래된 메시지를 LLM으로 요약해서 교체 |
| `message-window` | 최근 N개 메시지만 남기고 나머지를 잘라냄 |

이 Extension들은 전부 `@goondan/openharness-base` 패키지에 포함되어 있지만, **코어의 일부가 아닙니다.** 별도 패키지이며, 명시적으로 선언해야 활성화됩니다.

---

## LLM 행동 제어 — Extension이 도구를 관리한다

코어의 Tool Registry에 어떤 도구가 들어가느냐에 따라 LLM이 할 수 있는 행동이 달라집니다. 여기에도 Extension이 개입할 수 있습니다.

### 정적 도구 선언

`harness.yaml`에서 Agent가 참조하는 Tool 리소스가 카탈로그에 등록됩니다.

```yaml
kind: Agent
metadata:
  name: assistant
spec:
  tools:
    - Tool/file-system    # 파일 읽기/쓰기 가능
    - Tool/http-fetch     # HTTP 요청 가능
    # Tool/bash는 참조하지 않았으므로 셸 실행 불가
```

### Extension을 통한 동적 도구 관리

| Extension | 하는 일 |
|-----------|--------|
| `tool-search` | 대량의 도구가 있을 때, LLM이 검색을 통해 필요한 도구를 동적으로 발견 |
| `required-tools-guard` | 필수 도구가 카탈로그에 있는지 Turn 시작 전에 검증 |

ToolCall 미들웨어를 직접 작성하면 도구 호출의 인자를 검증하거나, 특정 조건에서 호출을 차단하거나, 결과를 가공할 수도 있습니다.

---

## 관측 — Extension이 실행을 감시한다

| Extension | 하는 일 |
|-----------|--------|
| `logging` | Turn/Step/ToolCall의 시작/완료/실패 이벤트를 로그 출력 |

코어 자체도 OTel 호환 이벤트를 발생시키지만, 그 이벤트를 수신해서 실제로 뭔가 하는 것(로그 출력, 메트릭 수집 등)은 Extension의 몫입니다.

---

# Part 3: 조립 — harness.yaml

코어와 Extension이 분리되어 있으므로, 이 둘을 조합하는 선언 파일이 필요합니다. 그것이 `harness.yaml`입니다.

---

## 리소스 모델

모든 구성 요소는 Kubernetes 스타일의 리소스로 선언됩니다.

```yaml
apiVersion: goondan.ai/v1
kind: Agent          # 리소스 종류
metadata:
  name: assistant    # 이름
spec:                # 상세 설정
  modelConfig:
    modelRef: Model/claude
  tools:
    - Tool/file-system
  extensions:
    - Extension/context-message
    - Extension/logging
```

### 7가지 리소스

| Kind | 계층 | 역할 |
|------|------|------|
| **Model** | 코어 | LLM 연결 정보 — 제공자, 모델명, API 키 |
| **Agent** | 코어 | 조립의 중심 — 어떤 Model, Tool, Extension을 활성화할지 |
| **Tool** | Extension | 에이전트가 호출 가능한 기능의 구현체 |
| **Extension** | Extension | 미들웨어와 도구를 등록하는 확장 모듈 |
| **Connector** | 코어 | 외부 payload를 표준 형식으로 변환하는 어댑터 |
| **Connection** | 코어 | Connector와 Agent를 잇는 라우팅 규칙 |
| **Package** | 코어 | 외부 npm 패키지에서 리소스를 로드하는 의존성 선언 |

### 리소스 간 관계

```
Package ──로드──→ Tool, Extension (npm 패키지에서)
                      │          │
Agent ──────────참조──┘──────참조─┘
  │
  └── modelRef ──→ Model

Connection ──→ Connector (어댑터 지정)
     │
     └── ingress.rules ──→ Agent (라우팅)
```

---

## 패키지 구조

코어와 Extension의 분리는 npm 패키지 수준에서도 반영됩니다.

```
@goondan/openharness-types       순수 타입 정의. 런타임 의존성 제로.
        ↑
@goondan/openharness             코어: 실행 루프, 레지스트리, 미들웨어 훅, YAML 로더
        ↑
@goondan/openharness-cli         CLI 도구 (`oh` 명령어)

@goondan/openharness-types
        ↑
@goondan/openharness-base        Extension 계층: 기본 제공 Tool 6종 + Extension 6종
        ↑
@goondan/openharness-integrations   Extension 계층: Slack, Telegram 연동 도구
```

`core`와 `base`는 별도 패키지입니다. `base`의 Tool과 Extension은 편의를 위해 기본 제공될 뿐, 코어의 일부가 아닙니다.

---

## 최소 실행 예시

### 1. harness.yaml

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
    - Extension/context-message   # 이것 없으면 시스템 프롬프트도 안 들어감
```

### 2. CLI

```bash
oh run "안녕하세요"
```

### 3. Programmatic API

```ts
import { createRunnerFromHarnessYaml } from "@goondan/openharness";

const runner = await createRunnerFromHarnessYaml({
  workdir: process.cwd(),
  env: process.env,
});

const output = await runner.processTurn("안녕하세요");
console.log(output.finalResponseText);
```

---

## 요약: 코어와 Extension의 경계

| | 코어가 하는 일 | Extension이 하는 일 |
|---|---|---|
| **실행** | Turn → Step → ToolCall 루프를 돌린다 | 루프의 각 단계에 미들웨어로 개입한다 |
| **메시지** | 이벤트 소싱 인프라를 제공한다 | 이벤트를 발생시켜 LLM 입력을 결정한다 |
| **도구** | Tool Registry와 JSON Schema 검증을 제공한다 | 도구 구현체를 등록하고, 호출을 감시/차단한다 |
| **프롬프트** | 아무것도 하지 않는다 | 시스템 프롬프트와 사용자 메시지를 주입한다 |
| **Ingress** | Verify → Normalize → Route → Dispatch 파이프라인을 돌린다 | 각 단계에 미들웨어로 개입한다 |
| **관측** | OTel 호환 이벤트를 발생시킨다 | 이벤트를 수신해서 로깅/메트릭을 수행한다 |

# Changelog

이 파일은 사용자에게 영향이 가는 변경을 기록합니다. 패키지별 세부 변경이 아니라
"확장을 짜는 사람이 무엇을 다르게 해야 하는가"를 기준으로 정리합니다.

형식은 [Keep a Changelog](https://keepachangelog.com/)를 느슨하게 따르고,
버전은 [Semantic Versioning](https://semver.org/)을 따릅니다.

## [Unreleased] — 1.0 단순화

0.5에서 실험적으로 늘어난 확장 표면을 6개의 결정으로 줄였습니다. 확장이 배워야 하는
표면이 작아졌고, 같은 일을 하는 길이 하나로 모였습니다. 0.5 이벤트 로그는 **그대로
읽힙니다** (아래 "영속 read-호환" 참고).

### 확장이 배우는 표면 (전부)

```ts
register(api) {
  api.useTurn(mw, opts)      // 양파 미들웨어 (ctx, next) — agent
  api.useStep(mw, opts)
  api.useToolCall(mw, opts)
  api.useIngress(mw, opts)   // 양파 — connection 확장만
  api.useModelInput((messages, ctx) => messages)  // 모델 입력 조립 — step 직전 1회, 순수, 영속 X
  api.on("turn.done", cb)    // 런타임 이벤트 (EventBus)
}
```

핸들러 `ctx`:

```ts
ctx.conversation.getEventLog()  // 원천: append-only MessageEvent[] (이벤트 소싱)
ctx.conversation.getMessages()  // 파생: 재생한 현재 상태. Object.freeze된 불변 스냅샷
ctx.conversation.append(event)  // 변경 유일 경로 (appendMessage/appendSystem/replace/remove/truncate)
ctx.store.get/set(key)          // 대화 스코프 영속 KV. (확장이름 × conversationId) 자동 네임스페이스
ctx.llm / ctx.conversationId / ctx.input
```

provenance: `createMessage({ data, createdBy })` / `getCreatedBy(m)` / `isSynthetic(m)`.

---

### Breaking changes & 마이그레이션

#### 1. 순서: 숫자 priority·phase 4칸 → `before`/`after`(이름) + `'*'`

숫자 `priority`와 phase 4칸(예: `phase: "pre"`)이 모두 사라졌습니다. 순서는 이제
다른 미들웨어의 **이름**을 가리키는 `before`/`after`, 또는 밴드 센티넬 `'*'`로
표현합니다. 대부분은 옵션을 생략하고 **등록 순서**에 맡기면 됩니다.

```diff
- api.useStep(mw, { priority: 100, phase: "pre" })
+ api.useStep(mw, { before: "message-window" })   // "message-window보다 먼저 진입"
+ api.useStep(mw, { before: "*" })                 // 가장 바깥 밴드 (모두보다 먼저 진입)
+ api.useStep(mw, { after: "*" })                  // 가장 안쪽 밴드 (모델 호출에 가장 가까움)
```

- `before: "A"` = "A보다 먼저 **진입**". 양파 구조라 진입이 빠르면 `next()` 이후
  코드는 A보다 **나중에** 돈다.
- 미지의 이름을 참조하거나 사이클(A before B, B before A)이 생기면 **부팅 시 하드
  에러**(`MiddlewareOrderError`)로 죽습니다. 런타임까지 끌고 가지 않습니다.
- 한 레벨에 순서 없는 mutator가 여럿이면 **부팅 경고**를 한 번 띄웁니다.

#### 2. 모델 입력: 별도 transform 등록 API → `useModelInput`

프롬프트/윈도우 같은 "모델에 들어갈 메시지 가공"은 더 이상 별도 prompt-projection
등록 API가 아니라 `useModelInput` 한 단계입니다.

```diff
- api.registerPromptProjection((messages) => withSystemPrompt(messages))
+ api.useModelInput((messages, ctx) => withSystemPrompt(messages))
```

- 양파의 **맨 끝**, 모델 호출 **직전 1회** 실행됩니다.
- 순수 `(messages, ctx) => messages | Promise<messages>` 입니다. async 허용.
- **영속되지 않습니다.** 0번 실행돼도 durable 로그는 그대로 정답이어야 합니다.
- `conversation`을 **절대 안 건드립니다.** 미들웨어 `ctx`를 직접 변형
  (`ctx.modelMessages = ...`)하는 것도 금지입니다.
- durable하게 남겨야 하는 변형(예: 압축)은 `useModelInput`이 아니라
  `conversation.append`입니다.

#### 3. 대화: 읽기는 메서드, 쓰기는 `append` 한 길

```diff
- const messages = api.conversation.messages      // getter
+ const messages = ctx.conversation.getMessages() // 메서드 (시점 의존을 정직하게 드러냄)
+ const log = ctx.conversation.getEventLog()       // append-only 원천 로그
```

- `getMessages()` 반환은 `Object.freeze`된 불변 스냅샷입니다. push/정렬 등 변형 시
  throw 됩니다. 가공이 필요하면 `useModelInput`에서 복사본을 만드세요.
- 쓰기는 `append(event)` 하나입니다. **동기**라서 직후 `getMessages()`에 즉시
  반영됩니다.
- `getMessages()`는 transform이 안 들어간 원본 로그의 재생 결과입니다 (provenance
  lifting 외에는 손대지 않음).

#### 4. 출처: `Message.createdBy` 1급 필드 + `createMessage` 팩토리

```diff
- conversation.append({ type: "appendMessage", message: {
-   id, data, metadata: { __createdBy: "my-ext" },
- }})
+ conversation.append({ type: "appendMessage",
+   message: createMessage({ data, createdBy: "my-ext" }) })
```

- `createdBy`가 1급 필드가 됐습니다 (타입은 optional — 레거시 replay 때문).
  신규 메시지는 `createMessage`로 만드세요.
- 1.x 동안 `metadata.__createdBy`로 **미러**됩니다. 충돌 시 **필드가** 우선입니다.
- `isSynthetic(m)`은 확장이 주입한 메시지인지 판정합니다. `unknown`(레거시)은
  **non-synthetic**으로 봅니다 — 안전 기본값이라 옛 로그를 실수로 버리지 않습니다.
- `CORE_CREATED_BY` / `UNKNOWN_CREATED_BY` / `CREATED_BY_METADATA_KEY` 상수를
  export 합니다.

#### 5. 이벤트 두 레이어 분리

서로 다른 두 가지를 명확히 갈랐습니다.

| | 레이어 | 용도 | replay |
| --- | --- | --- | --- |
| `conversation.append` / `getEventLog` | **MessageEvent** | 상태 변경, 이벤트 소싱 | replay == restore |
| `api.on` / `emit` / `tap` (EventBus) | **HarnessEvents** | 관측 | replay != restore |

- `conversation.append`은 EventBus를 **부르지 않습니다.** 상태 변경과 관측은 다른
  레이어입니다.
- 커스텀 이벤트는 캐스트 대신 `declare module`로 `CustomHarnessEvents`를 증강하세요.

```ts
declare module "@goondan/openharness-types" {
  interface CustomHarnessEvents {
    "myext.done": { type: "myext.done"; count: number };
  }
}
```

`CoreHarnessEvents`(고정 29종) + `CustomHarnessEvents` = `HarnessEvents`.

#### 6. store: `ctx.store`만 (register 시점 캡처 금지)

```diff
  register(api) {
-   const store = api.store               // ❌ register는 부팅 1회, store는 대화 스코프
-   api.useStep(async (ctx, next) => { await store.set(...) ; return next() })
+   api.useStep(async (ctx, next) => { await ctx.store.set("k", v); return next() })
  }
```

- `api.store`는 없습니다. store는 **대화 스코프**라 `ctx.store`로만 닿습니다.
  `register`는 부팅 때 1회 도므로 거기서 캡처하면 안 됩니다 (타입이 막습니다).
- `(확장이름 × conversationId)`로 자동 네임스페이스됩니다. 확장은 plain key만
  넘깁니다.
- 호스트가 backing(메모리/Redis/MySQL)을 주입합니다. 기본은 in-memory.

---

### 제거됨

- **phase 4칸** → `before`/`after` + `'*'` (위 #1).
- **recovery** (`recovery.claim`, `recovery-registry.ts`, `recovery.ts`) → 문서
  패턴으로 대체: "내가 안 잡는 에러는 rethrow, 바깥이 소유한다."
- **slots** (`createSlot`/`provides`/`consumes`, `slot-store.ts`, `slots.ts`) →
  순서 의존은 `before`/`after`로, 공유 상태는 `ctx.store`로.
- **별도 prompt-projection 등록 API** → `useModelInput` (위 #2).

### 견고성 (확장이 배울 것 아님)

- `remove`/`replace`의 없는 `messageId`는 throw가 아니라 **멱등 no-op**입니다.
  이벤트 자체는 로그에 기록됩니다.
- 순서 없는 다중 mutator는 **부팅 경고**.

### 비목표 (명시)

- 스트리밍 토큰 변환 (관측은 됨).
- 전역/테넌트 스토리지 (대화별까지만).
- 풀 자원 소유권.

---

### 영속 read-호환 (보장)

0.5 이벤트 로그(=`metadata.__createdBy`만 있고 `createdBy` 필드는 없는
`MessageEvent[]`)는 새 conversation-state로 그대로 replay됩니다.

- `getMessages()`(파생 뷰)에서는 `createdBy`가 metadata에서 **lift**되어 채워집니다.
- `getEventLog()`(원천 로그) 직렬화는 원본과 **바이트 동일**합니다. lifting은 파생
  메시지에만 적용되고 `_events`는 불변입니다.

이 두 가지는 회귀 테스트(`packages/core/src/__tests__/legacy-replay.test.ts` +
체크인된 fixture `fixtures/legacy-0.5-event-log.json`)로 고정돼 있습니다.

### base 확장 변화

- `BasicSystemPrompt` / `MessageWindow` → `useModelInput` projection (영속 안 함).
  레거시 `sys-basic-system-prompt` 시스템 메시지는 뷰에서 supersede되거나 1회
  청소됩니다.
- `CompactionSummarize` → `append` 유지 (durable 압축). `createMessage`로 출처를
  남기고, 압축 대상에서 system 메시지(프롬프트·이전 요약)는 제외합니다. 요약
  결과는 뷰를 계속 리드하도록 system 메시지로 기록합니다.
- `RequiredToolsGuard` → marker 상수를 export 합니다.

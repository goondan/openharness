# Changelog

이 문서는 OpenHarness의 주요 변경을 기록합니다. 형식은 [Keep a Changelog](https://keepachangelog.com/)를 따르고, 버전은 [SemVer](https://semver.org/)를 따릅니다.

## [1.0.0-rc.1] - 2026-06-13

확장 간 **계약을 문자열·숫자 관례에서 라이브러리 타입으로 승격**하는 breaking 재설계입니다. 6개 기능(F1–F6)으로 1.0.0의 내용은 충족하지만, rc로 먼저 발행해 헤비 소비자 이주 검증을 거친 뒤 1.0.0을 확정합니다.

> **영속 데이터 호환**: 0.5 이벤트 로그는 그대로 replay됩니다. `_events` 바이트는 불변이며, 신규로 추가된 출처(provenance)는 파생 메시지에만 입혀집니다. 기존 대화를 다시 읽는 데 마이그레이션이 필요하지 않습니다.

### Breaking Changes

#### F1. 숫자 `priority` 폐기 → `phase` + `before`/`after`

`MiddlewareOptions.priority`가 제거되었습니다. 순서는 이제 4단 phase 밴드와 명시적 의존 엣지로 정해집니다.

```ts
// before
api.middleware.register("turn", handler, { priority: 10 });

// after
api.middleware.register("turn", handler, {
  name: "my-mw",
  phase: "observe",            // observe → context → guard → model (바깥→안)
  before: "other-mw",          // 진입 순서: my-mw가 other-mw보다 먼저 진입
  after: ["a", "phase:context"], // phase 참조는 `phase:` 접두 필수
  beforeOptional: "maybe-mw",  // 없으면 무시 (하드 before/after는 미지 참조 시 부팅 에러)
});
```

- phase 기본값은 `context`. `model` phase는 **step 레벨 전용**(타 레벨 사용 = 부팅 에러).
- `before`/`after`의 정의 = **"진입 순서"**: "A before B ⇒ A가 B보다 먼저 진입". 양파 구조에서 A의 `post-next()` 코드는 반대로 **나중에** 실행됩니다.
- 같은 레벨에 2개 이상 등록 시 `name` 명시 필수. 이름 기본값은 확장 이름.
- 미지 참조/순환은 부팅 하드 에러(사이클 경로 + 엣지 사유 출력).

##### `priority` → `phase` 매핑 경계표

기존 `priority`는 `default 100, 낮을수록 먼저(outer)`였습니다. 아래 밴드로 옮기세요.

| 기존 priority (낮을수록 outer) | 새 phase | 용도 |
| --- | --- | --- |
| `≲ -1000` (아주 바깥) | `observe` | 로깅·메트릭·관측 (대화를 바꾸지 않음) |
| 기본값 `100` 근처 | `context` | 프롬프트·컨텍스트 주입 (대부분) |
| `≳ 9000` | `guard` | 마지막 검문 (필수 도구 가드 등) |
| `≳ 10000` | `model` | 모델 호출 직전 (step 레벨 전용) |

> ⚠️ **`phase`만 붙이면 안 됩니다.** phase 안에서의 tie-break는 **등록 순서**입니다. 기존 숫자 priority의 미세 순서를 phase가 자동으로 보존하지 **않습니다**. 코드 주석에 `// priority 50 — X보다 먼저`처럼 적어 두었던 부등식은 **전부 명시적 `before`/`after` 엣지로** 옮겨야 합니다. 옮기지 않으면 등록 순서가 바뀌는 순간 조용히 순서가 뒤집힙니다.

#### F2. 영속 로그 / 프롬프트 뷰 분리 (projection)

모델에 보낼 프롬프트를 영속 로그를 건드리지 않고 변형하는 1급 경로가 생겼습니다.

```ts
// 매 step(재시도 포함) 재실행됨 → idempotent 필수. 비싼 작업은 register 클로저에 캐시.
api.prompt.transform("hydrate-s3", async (view, stepCtx) => {
  return Promise.all(view.map(rehydrateIfPointer));
}, { after: "redact" });
```

- `PromptProjection = (view, stepCtx) => PromptView | Promise<PromptView>` — **async 필수**.
- step 밖에서 현재 투영 뷰가 필요하면 `PromptProjectionRegistry.apply(messages, ctx)` 공개 경로를 쓰세요(압축·prewarm).
- `validateView`가 중복 id 금지, system 선행, **tool-call/result 짝 불변식**(고아 tool result / 잘린 pair = `PromptProjectionError`)을 강제합니다.
- 출력은 freeze되어 영속이 불가능합니다. throw는 step 실패(loud)로 드러납니다.

**판정 규칙**: "이 변환이 0번 실행되면 영속 로그가 틀린가?" → 아니오면 projection, 예면 mutation.

##### projection 클로저 캐시 레시피

projection 함수는 매 step 재실행되므로, 비싼 준비 작업은 `transform`을 호출하는 시점(= 등록 클로저)에 한 번만 하고 결과를 클로저에 가둡니다.

```ts
function HydrateExtension() {
  return (api) => {
    const cache = new Map<string, Message>(); // 등록 1회 — step마다 공유
    api.prompt.transform("hydrate", async (view) =>
      view.map((m) => cache.get(m.id) ?? hydrateAndCache(cache, m)),
    );
  };
}
```

#### F3. 출처(provenance) 1급화

`Message.createdBy?: string`가 추가되었습니다. 메시지를 누가 만들었는지가 타입으로 드러납니다.

```ts
import { createMessage, getCreatedBy, isSynthetic, CORE_CREATED_BY } from "@goondan/openharness-types";

const m = createMessage({ data: { role: "user", content: "hi" }, createdBy: "my-ext" });
getCreatedBy(m);     // "my-ext"  (필드 우선, 없으면 metadata.__createdBy, 그래도 없으면 UNKNOWN_CREATED_BY)
isSynthetic(m);      // true      (core/unknown이 아닌 확장 출처는 synthetic)
```

- 1.x 동안 신규 쓰기는 `createdBy` 필드 + `metadata.__createdBy` 미러를 병기합니다(2.0에서 미러 제거 예정).
- 충돌 시(필드↔미러 불일치) **필드 우선 + 미러 강제 덮어쓰기 + warn** — throw하지 않습니다.
- `createMessage`는 입력 `metadata.__createdBy`를 **무시**하고 자기 `createdBy`로 미러를 기록합니다.
- 레거시(필드·미러 모두 없음) 메시지는 `UNKNOWN_CREATED_BY`로 해석되고 `isSynthetic`는 `false`(안전 기본값)입니다.

#### F4. 에러 소유권 — `api.recovery.claim`

확장이 특정 에러의 재시도/변환/포기를 **선언적으로 소유**합니다. 단일 객체 시그니처입니다.

```ts
api.recovery.claim(
  RateLimitError,                       // matcher: ErrorClass | (error, ctx) => boolean
  {
    attempts: 3,                        // 항상 보임. recover 생략 시 필수
    backoffMs: (attempt) => attempt * 1000,
    recover: (error, ctx, info) => {    // info.attempt 는 1-based
      if (info.attempt >= 3) return { action: "fail", throw: new RateLimitExhaustedError() };
      return { action: "retry", afterMs: 2000 };
    },
  },
  { name: "rate-limit-owner" },
);
```

##### RecoveryHandler 3-outcome 계약

`recover`는 4가지 결과 중 하나를 반환합니다(3개 행동 + fail의 변환 변형).

| 반환 | 의미 |
| --- | --- |
| `{ action: "retry", afterMs? }` | (대화 mutate 후) 재시도. **재시도 안전 가드를 우회**(명시적 mutate를 신뢰). |
| `{ action: "fail" }` | 소진 처리 — **원본 에러 rethrow**. |
| `{ action: "fail", throw: Error }` | 변환 에러로 전파(예: 429 → `RateLimitExhaustedError`). |
| `{ action: "unhandled" }` | 이 claim 포기 → 다음 claim, 없으면 전파. |

- 우선순위: **먼저 등록한 claim 승리** + `unhandled` 폴스루. superclass shadow는 부팅 warn.
- **재시도 안전 가드**: 디스패처의 디폴트(=`recover` 없는) 재시도는 직전 attempt에서 `conversation.events.length`가 바뀌었으면 재시도를 **거부하고 원본을 rethrow**합니다(중복 부작용 방지). `recover`가 명시적으로 mutate한 경우는 예외.
- 바이패스: `abort`/`HumanApprovalPendingError`는 claim을 거치지 않고 그대로 전파됩니다.

> **한계 (중요)**: claim은 coreHandler의 LLM/도구 루프만 커버합니다. 미들웨어가 직접 호출하는 `ctx.llm.chat`(압축 등)은 **대상이 아닙니다**. 또한 재시도는 **미들웨어를 재실행하지 않습니다**(projection은 재적용). recover가 대화를 mutate하면 그에 대한 검증도 recover 안에서 하세요.

#### F5. 확장 가능한, 레벨이 검증되는 이벤트

`CoreHarnessEvents`(고정) + `CustomHarnessEvents`(`declare module` 증강) = `HarnessEvents`.

```ts
declare module "@goondan/openharness-types" {
  interface CustomHarnessEvents {
    "myext.cacheWarmed": { type: "myext.cacheWarmed"; keys: number };
  }
}
// 이제 typed:
api.events.emit("myext.cacheWarmed", { type: "myext.cacheWarmed", keys: 7 });
api.events.on("myext.cacheWarmed", (p) => p.keys /* number */);
```

- 신규 코어 이벤트: `step.retry` `{ stepNumber, attempt, error, claimName? }`, `recovery.exhausted` `{ stepNumber, attempts, error, claimName? }`.
- 스트리밍 델타(`step.textDelta`/`step.toolCallDelta`)에 `attempt?: number`가 추가되어, 리포터가 재시도 시 델타 버퍼를 리셋할 수 있습니다.
- `EventPayload`는 deprecated alias(코어 payload 유니온)입니다. `tap`은 커스텀 포함 전체를 받으므로 `HarnessEvents[keyof HarnessEvents]`로 받으세요.
- 리스너 예외는 catch되어 `console.warn`으로 보고됩니다(turn을 깨지 않음).

##### 이벤트 scope 분할표

이벤트는 agent 스코프(per-agent 버스)와 connection 스코프(ingress/dispatch)로 나뉩니다. 두 집합은 **서로소이며 합집합이 코어 이벤트 전체(34종)를 정확히 덮습니다**. `create-harness` 배선이 이 상수 배열에 대해 검증됩니다.

| Scope | 이벤트 |
| --- | --- |
| **Agent** (27) | `turn.*` (start/done/error), `step.*` (start/done/error/retry/textDelta/toolCallDelta/toolCallsSuppressed), `recovery.exhausted`, `tool.*` (start/done/error), `inbound.delivered/consumed/failed/deadLettered`, `humanApproval.*` (created/ready/resuming/completed/failed/canceled), `humanTask.*` (created/resolved/rejected) |
| **Connection** (7) | `ingress.*` (received/accepted/rejected), `inbound.appended/duplicate/leased/blocked` |

> agent와 connection 이벤트를 모두 듣는 관측 확장은 **확장 2개로 분리**하세요. `AgentExtensionApi`에서 `on("ingress.*")`는 컴파일 에러이며, `registerExtensions`의 `scope` 파라미터가 부팅 가드로 백스톱합니다.

#### F6. 타입드 컨텍스트 슬롯

턴 스코프 공유 상태를 문자열 키 대신 타입드 슬롯으로 다룹니다.

```ts
import { createSlot } from "@goondan/openharness-types";
const AUTH = createSlot<string>("auth.token");

// provider
api.middleware.register("turn", provider, { name: "auth", provides: { slot: AUTH, always: true } });
// consumer
api.middleware.register("turn", consumer, { name: "use", consumes: AUTH });
//   handler 안에서: ctx.slots.get(AUTH)  // always 보장 → throw 없음
```

- **선언 게이트**: `get`/`tryGet`/`set`은 그 미들웨어가 `consumes`/`consumesOptional`/`provides`로 **선언한** 슬롯에만 허용됩니다(미선언 접근 = 런타임 에러).
- **보장 수준 분리**: `provides: { slot, always: true }`만 consumer가 `get()`(throw 없음). 조건부 `provides: SlotKey`는 consumer가 `tryGet()`만(undefined 가능).
- 대칭: `consumes`↔`get`, `consumesOptional`↔`tryGet`.
- 부팅 검증: required consumes의 provider 존재, slot당 provider 1개, cross-level은 outer-or-equal, ingress/route 슬롯 금지. provider→consumer 엣지가 F1 topo에 합류합니다.
- `SlotUnsetError`는 "provider가 `next()` **이후에** set하지 않는지 확인"이라는 힌트를 포함합니다(topo는 진입 순서만 보장 — set-before-get은 미보장).

##### `InboundEnvelope.properties` → `Readonly<...>` 대체 레시피

`properties`가 `Readonly`로 바뀌어 직접 변경할 수 없습니다. 턴 내 가변 상태는 슬롯으로, 원본 connector 값은 properties로 — 이중 소스 레시피를 쓰세요.

```ts
// main agent: connector 원본을 properties에서 / subagent: slot 우선
const model = ctx.slots.tryGet(MODEL_OVERRIDE) ?? envelope.properties.model;
```

### base 확장 변경

- **`BasicSystemPrompt`** → projection 전환. 마이그레이션 장치 2종:
  - (a) 턴 시작 시 durable에 레거시 `sys-basic-system-prompt`가 있으면 `remove` 이벤트로 **1회 청소**.
  - (b) 영속 system 메시지에 의존하던 소비자를 위해 **`getSystemPromptText()` 류 조회 API**를 export.
- **`CompactionSummarize`** → mutation 유지 + `phase:"context"` + `createMessage`. `toRemove`에서 **system 역할 제외**(낡은 프롬프트가 요약에 박제되던 결함 동시 수정).
- **`MessageWindow`** → projection 전환, **짝 인식 경계 절단**(고아 pair 발생 시 경계 확장 — `validateView`에 걸리지 않음).
- **`RequiredToolsGuard`** → `phase:"guard"`. marker 상수 export.

> ⚠️ **회귀: `MessageWindow`의 durable 무한 성장.** projection으로 바뀌면서 영속 로그를 잘라내던 `truncate`가 폐기되었습니다. 윈도잉은 이제 **뷰에만** 적용되고 durable 로그는 계속 자랍니다. 장기 대화에서는 **`CompactionSummarize`를 병용**해 durable 크기를 관리하세요.

### 영속 system prompt에 의존하던 소비자

`BasicSystemPrompt`가 영속 메시지에서 projection으로 바뀌었으므로, 영속 로그에서 system 텍스트를 읽던 코드(압축·prewarm·외부 호스트 등)는 더 이상 그 메시지를 찾지 못합니다. `getSystemPromptText()` 조회 API로 교체하세요. (또는 step 밖이라면 `PromptProjectionRegistry.apply(...)`로 투영 뷰를 계산해 system 메시지를 읽으세요.)

### 마이그레이션 요약

| 영역 | 기존 | 신규 |
| --- | --- | --- |
| 미들웨어 순서 | `{ priority: number }` | `{ phase, before, after }` (위 매핑표) |
| 프롬프트 변형 | 영속 메시지 mutation | `api.prompt.transform(...)` projection |
| 출처 | `metadata.__createdBy` 직접 | `createMessage({ createdBy })` + `getCreatedBy()` |
| 에러 재시도 | catch-all/관례 | `api.recovery.claim(matcher, { attempts, recover })` |
| 커스텀 이벤트 | 문자열 emit | `declare module CustomHarnessEvents` |
| 공유 상태 | 문자열 키 컨텍스트 | `createSlot<T>()` + `provides`/`consumes` |
| `InboundEnvelope.properties` | 가변 | `Readonly` (슬롯 + properties 폴백) |

[1.0.0-rc.1]: https://github.com/goondan/openharness/releases/tag/v1.0.0-rc.1

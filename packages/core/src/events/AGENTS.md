# packages/core/src/events

`events`는 RuntimeEvent의 런타임 고유 상수와 EventBus 구현체를 담당한다.

## 존재 이유

- RuntimeEvent 타입 계약은 `@goondan/openharness-types`가 SSOT로 소유하며, 이 모듈은 re-export + runtime 고유 구현만 제공한다.
- 이벤트 구독/발행 메커니즘(EventBus)을 런타임 내부에 캡슐화한다.

## 구조적 결정

1. 타입 정의는 `@goondan/openharness-types`에서 re-export만 한다 (자체 타입 정의 없음).
이유: SSOT 원칙. 이전에 runtime 내부에 별도 타입을 정의했다가 Studio/CLI가 구현에 결합되는 문제가 있었음.
2. RUNTIME_EVENT_TYPES 상수, STEP_STARTED_LLM_INPUT_MESSAGES_METADATA_KEY 등 runtime 고유 상수만 이 모듈에서 정의한다.

## 불변 규칙

- 이 모듈에서 RuntimeEvent 관련 새 타입을 정의하지 않는다. 타입 추가가 필요하면 `@goondan/openharness-types`에서 한다.

## 참조

- `packages/types/AGENTS.md`
- `docs/specs/shared-types.md` (섹션 9: RuntimeEvent)

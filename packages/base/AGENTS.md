# packages/base

`@goondan/openharness-base`는 barebone harness 프레임워크에 바로 적용할 수 있는 기본 Tool/Extension과 manifest 레퍼런스를 제공하는 기준 패키지다.
기본 번들이 최소 설정으로 동작을 검증할 수 있도록 필수 리소스를 유지한다.

## 존재 이유

- 신규 번들이 최소 설정으로 실행되도록 기본 리소스 구현을 제공한다.
- 스펙 계약의 실전 레퍼런스 구현을 한곳에서 유지한다.

## 구조적 결정

1. 배포는 `gdn package publish` 경로만 사용한다.
이유: npm 패키지가 아니라 goondan 리소스 패키지로 유통되는 자산이기 때문.
2. Tool/Extension 계약은 각 스펙 문서를 단일 기준으로 따른다.
이유: 런타임과 계약 불일치가 누적되는 것을 막기 위해.
3. 기본 메시지 정책은 tool-call/tool-result 정합성을 보존한다.
이유: 장기 실행에서 대화 상태 붕괴를 방지하기 위해.
4. 프롬프트 조립/주입 책임은 Extension에 두고, Runtime 코어 책임과 분리한다.
이유: 프롬프트 정책 변경이 런타임 엔진 변경으로 전파되지 않도록 계층 경계를 고정하기 위해.
5. Extension은 Runtime이 제공하는 `ctx.runtime.agent`/`ctx.runtime.swarm`/`ctx.runtime.inbound`/`ctx.runtime.call` 실행 컨텍스트를 활용하되, 프롬프트 본문 정책의 최종 소유권은 Extension에 둔다.
이유: 실행 기반 정보와 대화 정책의 결합을 느슨하게 유지해 확장성을 확보하기 위해.
6. `ctx.runtime.agent.prompt`는 Runtime에서 materialize된 `system` 텍스트만을 전제로 사용한다 (`systemRef` 해석/파일 I/O 금지).
이유: 확장 레이어가 리소스 해석 책임까지 흡수하면 코어-확장 경계가 무너지고 중복 구현이 생기기 때문.

## 불변 규칙

- Tool 이름 규칙 `{resource}__{export}`를 유지한다.
- Tool manifest 입력 스키마는 속성 설명(`description`)과 닫힌 스키마(`additionalProperties: false`) 원칙을 기본으로 유지한다.
- `@goondan/openharness-base`는 npm publish를 수행하지 않는다.
- `packages/base/harness.yaml`의 `spec.version`은 루트 `@goondan/*` npm 버전과 항상 동일해야 하며, 불일치 상태로 배포하지 않는다.
- 코어 텍스트 주입=0 원칙을 전제로, Extension은 시스템 프롬프트 텍스트 조립/주입 책임을 명시적으로 소유하며 이를 Runtime 코어 책임으로 되돌리지 않는다.
- Runtime이 제공하는 `ctx.runtime.agent`/`ctx.runtime.swarm`/`ctx.runtime.inbound`/`ctx.runtime.call` 정보는 실행 컨텍스트 전달값으로 취급하며, 프롬프트 정책 결정의 단일 소유자는 Extension이다.
- `context-message`를 포함한 base Extension은 `prompt.systemRef`를 직접 해석하지 않는다. `ctx.runtime.agent.prompt.system`만 사용한다.
- `context-message`의 `runtime_route` 요약은 충돌 시 `call > inbound` 우선순위를 사용한다.
- `context-message`는 inbound 원문(`ctx.inputEvent.input`)을 user 메시지로 노출할지/순서를 정책으로 소유하며, 기본값은 runtime 세그먼트 뒤(user tail) append다.

## 참조

- `../README.md`

# packages/runtime/src/workspace

`workspace`는 Goondan 런타임의 상태 저장/복원 경계를 담당하는 스토리지 계층이다.

## 존재 이유

- 프로젝트 정의와 실행 상태를 분리해 운영 안정성과 재현성을 확보한다.
- 대화 상태와 관측 이벤트를 규약에 맞게 영속화한다.

## 구조적 결정

1. 2-root 모델(Project Root / System Root)을 유지한다.
이유: Git 관리 대상과 런타임 상태를 물리적으로 분리하기 위해.
2. 메시지 저장은 `base/events` 상태 모델과 `runtime-events` 관측 모델을 분리한다.
이유: 상태 복원 정확도와 관측성 요구를 동시에 만족하기 위해.
3. workspace 식별은 instanceKey 기반 결정론적 매핑을 사용한다.
이유: 동일 인스턴스의 상태 경로를 환경에 무관하게 일관되게 찾기 위해.
4. runtime-events.jsonl 레코드에 TraceContext(traceId/spanId/parentSpanId)가 포함된다.
이유: Studio와 CLI가 trace 기반 인과 관계를 구성하는 데 필수 데이터.

## 불변 규칙

- 상태 계산은 `NextMessages = BaseMessages + SUM(Events)` 모델을 유지한다.
- append-only turn은 delta append를 우선하고, mutation이 있을 때만 rewrite를 허용한다.
- Extension 상태는 인스턴스 단위로 분리 저장한다.
- 비밀값 저장/처리는 `docs/specs/workspace.md` 보안 규칙을 따른다.

## 참조

- `docs/specs/workspace.md`
- `docs/specs/runtime.md`
- `packages/runtime/AGENTS.md`

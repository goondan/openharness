# packages/runtime/src/pipeline

`pipeline`은 turn/step/toolCall 미들웨어 체인과 RuntimeEvent 발행의 구현을 담당한다.

## 존재 이유

- Extension이 런타임 코어 수정 없이 정책/동작을 확장할 수 있는 미들웨어 체인을 제공한다.
- 각 실행 단위(Turn/Step/Tool Call)의 시작/완료/실패 이벤트를 TraceContext와 함께 발행한다.

## 구조적 결정

1. PipelineRegistryImpl이 모든 RuntimeEvent emit을 담당하며, 각 이벤트에 TraceContext(traceId/spanId/parentSpanId)와 instanceKey를 포함한다.
이유: OTel 호환 span hierarchy 구성을 위해 모든 이벤트에 추적 정보가 필수.
2. span hierarchy: Turn span -> Step span -> Tool Call span 순서로 parentSpanId를 연결한다.
이유: 인과 체인 추적의 정확성을 보장하기 위해.
3. ExecutionContext 인터페이스가 agentName, instanceKey, turnId, traceId를 공통으로 제공한다.
이유: 미들웨어가 추적 정보에 접근할 수 있어야 관측성이 보장됨.

## 불변 규칙

- 모든 RuntimeEvent에 traceId, spanId, parentSpanId, agentName, instanceKey를 포함한다.
- turn.completed.stepCount는 실제 step 수를 반영한다 (0으로 고정하지 않음).
- tokenUsage 메트릭이 있으면 step.completed/turn.completed에 포함한다.

## 참조

- `docs/specs/pipeline.md`
- `docs/specs/shared-types.md` (섹션 5: TraceContext, 섹션 9: RuntimeEvent)
- `packages/runtime/AGENTS.md`

# OpenHarness Workspace Persistence 스펙

## Problem

현재 `@goondan/openharness`의 `harness.yaml` runner는 conversation 상태와 runtime event를 기본적으로 로컬 파일(JSONL)에 저장해요. 이 기본 동작 자체는 유효하지만, runner가 파일 구현 세부를 직접 알고 있어서 저장 전략을 교체하기가 어려워요.

지금 구조에서는 아래 책임이 파일 구현체와 강하게 연결돼 있어요.

1. conversation별 message base/events 로드
2. extension state 로드/저장
3. conversation metadata 생성과 `idle/processing` 상태 전이
4. workspace/conversation runtime event 기록

OpenHarness는 barebone harness framework이므로, 특정 저장소 구현을 core contract로 고정하지 않는 편이 좋아요. 따라서 core는 conversation/runtime 영속화에 필요한 domain contract만 알고, 파일/DB/object storage 같은 구체 구현은 어댑터로 분리해야 해요.

## Goals (Committed)

1. `createHarnessRuntimeFromYaml()`와 `createRunnerFromHarnessYaml()`는 파일 구현 세부 대신 `WorkspacePersistence` 포트에 의존해야 해요.
2. conversation 상태, extension 상태, lifecycle metadata는 conversation 단위 저장 계약으로 다뤄야 해요.
3. runtime event 저장은 "어떤 이벤트가 어떤 workspace/conversation에 속하는가"까지만 core가 전달하고, 실제 materialization 방식은 구현체가 결정해야 해요.
4. `persistence` 옵션을 주지 않으면 기존 파일 기반 동작을 유지해야 해요.
5. downstream 서비스는 `FileWorkspaceStorage`나 `WorkspacePaths`를 import하지 않고도 DB 기반 persistence를 구현할 수 있어야 해요.
6. 기존 `base + events` 상태 모델과 ingress/turn/step/tool observability 표면은 유지해야 해요.

## Non-goals

- message schema 자체 변경
- runtime event schema 자체 변경
- admin/web 조회 API 표준화
- orchestrator, IPC, connector 구현을 persistence 포트에 포함
- 특정 서비스의 DB 테이블명이나 인덱스 구조를 OpenHarness core contract로 승격

## Terms

### Workspace Persistence

OpenHarness runner가 사용하는 영속화 경계예요. conversation 상태와 runtime event 저장 책임을 묶어 제공해요.

### Conversation Store

conversation 단위 상태를 다루는 저장 포트예요. message base/events, extension state, lifecycle metadata를 포함해요.

### Runtime Event Store

runtime event를 영속화하는 저장 포트예요. workspace/conversation별 물리 저장 방식은 구현체 책임이에요.

### Materialization

하나의 logical runtime event record를 파일 2개에 쓰거나, 단일 DB row로 쓰거나, 보조 인덱스를 만드는 식의 물리 저장 전략을 뜻해요. 이 정책은 core가 아니라 구현체가 결정해요.

## Public API

### `createHarnessRuntimeFromYaml(options)`

입력 옵션에 `persistence?`를 추가해요.

```ts
type CreateHarnessRuntimeOptions = {
  workdir: string;
  entrypointFileName?: string;
  agentName?: string;
  conversationId?: string;
  stateRoot?: string;
  maxSteps?: number;
  logger?: LoggerLike;
  env?: NodeJS.ProcessEnv;
  resolveSecretRef?: ResolveSecretRef;
  persistence?: WorkspacePersistence;
};
```

### `createRunnerFromHarnessYaml(options)`

`createHarnessRuntimeFromYaml()`와 같은 `persistence?` 옵션을 받아 내부 runtime 생성 시 그대로 전달해요.

## Persistence Contracts

공개 타입 계약은 `@goondan/openharness-types` 기준으로 관리해요. 기본 구현체 클래스는 `@goondan/openharness`에서 제공할 수 있어요.

### `WorkspacePersistence`

```ts
export interface WorkspacePersistence {
  conversations: ConversationStore;
  runtimeEvents: RuntimeEventStore;
}
```

### `ConversationMetadata`

```ts
export interface ConversationMetadata {
  conversationId: string;
  agentName: string;
  status: "idle" | "processing";
  createdAt: string;
  updatedAt: string;
}
```

### `LoadedConversationState`

```ts
export interface LoadedConversationState {
  baseMessages: Message[];
  events: MessageEvent[];
}
```

### `ConversationStore`

```ts
export interface ConversationStore {
  ensureConversation(input: {
    conversationId: string;
    agentName: string;
  }): Promise<ConversationMetadata>;

  loadState(input: {
    conversationId: string;
  }): Promise<LoadedConversationState>;

  appendMessageEvents(input: {
    conversationId: string;
    events: MessageEvent[];
  }): Promise<void>;

  readExtensionState(input: {
    conversationId: string;
    extensionName: string;
  }): Promise<JsonObject | null>;

  writeExtensionState(input: {
    conversationId: string;
    extensionName: string;
    value: JsonObject;
  }): Promise<void>;

  readMetadata(input: {
    conversationId: string;
  }): Promise<ConversationMetadata | null>;

  updateStatus(input: {
    conversationId: string;
    status: "idle" | "processing";
  }): Promise<void>;
}
```

### `RuntimeEventRecord`

```ts
export interface RuntimeEventRecord {
  workspaceId: string;
  conversationId?: string;
  event: RuntimeEvent;
}
```

### `RuntimeEventStore`

```ts
export interface RuntimeEventStore {
  append(input: {
    records: RuntimeEventRecord[];
  }): Promise<void>;
}
```

## Runtime Behavior

### 1. Persistence 해석

- `options.persistence`가 주어지면 runner는 그 구현체를 사용해요.
- `options.persistence`가 없으면 기본 `FileWorkspacePersistence`를 생성해요.
- 기본 구현체를 쓰는 경우에도 runner는 `FileWorkspaceStorage`나 JSONL append 함수를 직접 호출하지 않고, `WorkspacePersistence` 포트만 통해 접근해야 해요.

### 2. Conversation 생성/복원

- session 생성 전 runner는 `conversations.ensureConversation({ conversationId, agentName })`를 호출해야 해요.
- conversation 상태 복원은 `conversations.loadState({ conversationId })` 결과를 기준으로 `ConversationStateImpl`을 만들어요.
- `NextMessages = BaseMessages + SUM(Events)` 모델은 유지돼요.

### 3. Message Event 영속화

- runner는 turn 실행 전 `conversationState.events.length`를 기록해요.
- turn 종료 시 새로 생긴 `MessageEvent[]`를 모아 `appendMessageEvents()`로 저장해요.
- 저장 단위는 여러 이벤트를 한 번에 받을 수 있어야 해요.
- 이벤트 compaction이나 base fold는 이 스펙의 필수 runtime contract가 아니며, 구현체 내부 최적화로 둘 수 있어요.

### 4. Extension State

- extension state는 conversation scope예요.
- `ExtensionStateManager`는 `readExtensionState()` / `writeExtensionState()`를 사용해요.
- 저장 값은 `JsonObject`여야 해요.
- 직렬화 포맷, dedupe, dirty-check는 구현체 책임이에요.

### 5. Lifecycle Metadata

- runner는 turn 시작 직전에 `updateStatus({ status: "processing" })`를 호출해야 해요.
- runner는 turn 종료 `finally`에서 `updateStatus({ status: "idle" })`를 호출해야 해요.
- `ensureConversation()`은 최초 생성 시 metadata를 만들고, 이미 존재하면 기존 metadata를 재사용할 수 있어요.

### 6. Runtime Event 영속화

- runtime event bus에서 발생한 이벤트는 `RuntimeEventRecord`로 감싸 `runtimeEvents.append()`에 전달해요.
- `workspaceId`는 현재 runner가 계산하는 workspace 식별자를 그대로 사용해요.
- `conversationId`가 없는 이벤트도 허용해요.
- `conversationId`가 있는 이벤트를 workspace view와 conversation view에 모두 노출할지, 단일 row로 저장할지는 구현체 책임이에요.

### 7. Error Handling

- persistence 구현체 에러는 runner 에러로 surface될 수 있어요.
- 단, `RuntimeEventStore`가 내부적으로 여러 물리 저장 경로를 갖더라도 partial write 복구 전략은 구현체 책임이에요.
- core는 개별 물리 저장 경로의 재시도 규칙을 알지 않아요.

## Default File-backed Implementation

기본 구현체는 `FileWorkspacePersistence`예요.

### `FileWorkspacePersistence` 요구사항

1. 기존 `WorkspacePaths` 레이아웃을 그대로 유지할 수 있어야 해요.
2. 기존 `runtime-events.jsonl` 파일 위치와 message base/events 파일 위치를 유지할 수 있어야 해요.
3. 기존 파일 기반 테스트가 의미하는 observable behavior를 깨지 않아야 해요.

### `FileConversationStore`

- 현재 `FileWorkspaceStorage`가 담당하던 아래 책임을 대체해요.
  - metadata 생성/조회
  - message base/events 로드
  - message events append
  - extension state read/write
  - status update

### `JsonlRuntimeEventStore`

- `RuntimeEventRecord`를 받아 기존 workspace runtime log와 conversation runtime log에 materialize할 수 있어야 해요.
- `conversationId`가 비어 있으면 workspace log에만 기록해요.

## Downstream Adapter Expectations

OpenHarness 바깥의 서비스는 아래 원칙만 지키면 어떤 저장소든 구현할 수 있어요.

1. `ConversationStore`를 구현해 conversation 상태와 extension state를 conversation 단위로 복원할 수 있어야 해요.
2. `RuntimeEventStore`를 구현해 runtime event를 workspace/conversation 기준으로 조회 가능한 형태로 남길 수 있어야 해요.
3. DB 테이블명, 샤딩, 인덱스, archive 정책은 downstream 서비스가 결정해요.

예를 들어 분산 런타임은 아래처럼 구현할 수 있어요.

- conversation/message/extension 상태는 정규화된 테이블에 저장
- runtime event는 단일 event 테이블에 저장
- conversation view나 workspace view는 조회 인덱스나 materialized view로 제공

이 예시는 허용 범위를 설명하기 위한 것이고, core 스펙의 일부는 아니에요.

## Compatibility

이 변경 이후에도 아래는 유지돼야 해요.

1. `createHarnessRuntimeFromYaml()`의 상위 runtime 역할
2. `createRunnerFromHarnessYaml()`의 convenience wrapper 역할
3. ingress event가 workspace observability에 남는다는 보장
4. conversationId가 있는 runtime event를 conversation 기준으로 추적할 수 있다는 보장
5. 기존 message replay 의미론

## Acceptance Criteria

1. `createHarnessRuntimeFromYaml()`와 `createRunnerFromHarnessYaml()`가 `persistence?` 옵션을 받는다.
2. runner 내부에서 persistence 해석 이후에는 `WorkspacePersistence` 포트만 사용한다.
3. `ConversationStore`만으로 session 생성, conversation 상태 복원, extension state 저장, lifecycle status 전이가 가능하다.
4. `RuntimeEventStore`는 core가 fan-out 세부를 모르더라도 workspace/conversation observability 요구를 충족할 수 있다.
5. `persistence`를 주지 않으면 기존 파일 기반 테스트가 통과하는 수준의 observable parity를 유지한다.
6. downstream 서비스는 파일 구현체를 import하지 않고도 persistence adapter를 작성할 수 있다.
7. 공개 타입 계약은 `@goondan/openharness-types` 기준으로 노출된다.

## Migration Plan

1. 공개 타입 계약을 추가해요.
2. 파일 기반 기본 구현체를 새 포트 구조로 감싸요.
3. runner가 새 포트만 사용하도록 리팩터링해요.
4. 기존 테스트를 file-backed parity 관점으로 보강해요.
5. downstream 서비스에서 adapter를 붙여 검증해요.

## Open Questions

아래는 구현 전에 한 번 더 합의하면 좋은 항목이에요.

1. `ConversationMetadata`에 future-proof field가 더 필요한지
2. `RuntimeEventStore.append()`의 배치 크기나 호출 빈도에 대한 성능 가이드가 필요한지
3. `ConversationStore`에 compaction/fold API를 장기적으로 추가할지

이 질문들은 후속 설계 포인트예요. 이번 스펙의 committed scope는 persistence 경계 분리와 runner 의존성 정리에 있어요.

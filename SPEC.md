# harness.yaml 기반 실행(oh CLI + 상위 API) 스펙

## Problem

현재 `@goondan/openharness`는 Turn/Step/ToolCall 실행 엔진(프리미티브)을 제공하지만,
사용자가 “`harness.yaml`만 놓고 그 폴더에서 CLI로 실행하면 곧바로 에이전트가 실행”되는 경험을 만들려면
`harness.yaml` 리소스 로딩/해석 + 런타임 조립 + 기본 CLI 드라이버가 필요하다.

## Goals (Committed)

1. 폴더에 `harness.yaml`만 있으면 `oh` CLI로 즉시 실행할 수 있다.
2. `harness.yaml`은 `goondan.ai/v1` 멀티-문서 리소스 YAML이며, **Swarm 없이** 다음 kind만으로 구성 가능해야 한다:
   - `Package`, `Model`, `Agent`, `Tool`, `Extension`
3. Tool/Extension 정의는 `harness.yaml`에 전부 쓰지 않고,
   `Package.spec.dependencies`로 나열된 패키지들의 `dist/harness.yaml`에서 로드해 온 리소스를
   `Agent.tools` / `Agent.extensions`(ref/selector)로 선택하는 방식이 기본 경로가 된다.
4. 대화형 REPL과 원샷 실행을 모두 지원한다.
5. 같은 기능을 programmatic하게 사용할 수 있는 상위 API를 제공한다.

## Non-goals (이번 범위 아님)

- `Swarm`/멀티 에이전트 오케스트레이션
- `Connector`/`Connection` kind를 포함한 ingress/웹훅 등 커넥터 런타임 구현
- 원격 패키지 설치/레지스트리 다운로드(패키지는 이미 node resolution으로 설치되어 있다고 가정)

## harness.yaml 입력 형식

### 기본 규칙

- 파일명 기본값: `harness.yaml`
- 멀티 문서 YAML(`---` 구분)로 여러 리소스를 포함한다.
- `apiVersion`은 기본적으로 `goondan.ai/v1`를 기대한다(없으면 기본값으로 취급 가능).

### Package (의존 패키지 로딩)

- `kind: Package` 리소스의 `spec.dependencies[]`를 읽어 각 패키지의 `dist/harness.yaml`을 추가 로드한다.
- `dependencies[].version`은 런타임에서 강제하지 않고(이미 설치/링크되어 있다고 가정), 에러 메시지에만 활용한다.

### Model

- `kind: Model`은 `provider`, `model`, `apiKey`(ValueSource)를 가진다.
- `apiKey`는 기본적으로 `valueFrom.env`를 지원한다.
- `secretRef`가 들어오면 programmatic API에서는 resolver를 주입할 수 있고, CLI는 기본으로는 에러 처리한다(추후 확장).

### Agent

- `kind: Agent`는 `modelConfig.modelRef`로 `Model`을 참조한다.
- `Agent.tools`는 `Tool` 리소스(ref/selector)들을 선택한다. 선택된 `Tool` 리소스의 `spec.exports`는 모두 tool catalog로 확장된다.
- `Agent.extensions`는 `Extension` 리소스(ref/selector)들을 선택한다.

## Resource 선택(Ref/Selector) 규칙

- ref(string) 형식: `"Kind/name"` (예: `"Extension/context-message"`)
- selector는 `kind/name/matchLabels`를 지원한다.
- selector 결과가 여러 개인 경우 **로드된 리소스의 등장 순서**를 유지한다(특히 extension 로딩 순서 중요).

## Entry Agent 선택 규칙

- CLI에서 `--agent <name>`가 있으면 해당 Agent를 실행한다.
- 없으면:
  - Agent 리소스가 1개면 그 Agent를 실행
  - 2개 이상이면 에러 + 사용 가능한 Agent 목록 출력

## 실행 결과(엔진 조립)

- Tool:
  - 선택된 `Tool` 리소스들을 동적 import하여 `ToolRegistry`에 등록한다.
  - export handler는 `module[exportName]` 우선, 없으면 `module.handlers?.[exportName]`를 사용한다.
- Extension:
  - 선택된 `Extension` 리소스들을 `loadExtensions()`로 로드한다.
  - Extension이 tool을 등록하면 extension tool registry/executor 경로로 실행된다.
- Inbound input 처리:
  - 선택된 extension에 `context-message`가 포함되면 해당 extension이 inbound/system 주입을 담당한다.
  - 그렇지 않으면 러너가 최소 turn middleware로 system/user 메시지를 1회 주입한다.

## CLI 스펙 (oh)

### 바이너리 이름

- `oh`를 제공한다.

### 모드

- `oh` (또는 `oh repl`): 대화형 REPL
- `oh run "<text>"`: 원샷 실행(한 턴만 실행 후 종료)

### 공통 옵션(초기)

- `--workdir <path>`: harness.yaml을 찾고 tool 실행의 기준이 되는 디렉토리(기본: `process.cwd()`)
- `--entrypoint <file>`: 기본은 `harness.yaml`
- `--agent <name>`: 실행할 Agent 이름
- `--instance <key>`: instanceKey (기본: `<agentName>` 또는 `default`)
- `--state-root <path>`: 상태 저장 루트(기본값은 기존 `WorkspacePaths` 규칙 따름)
- `--max-steps <n>`: turn당 최대 step

### .env 로딩(초기)

- CLI는 `workdir/.env`가 존재하면 이를 읽어서 `process.env`와 merge한 값을 `ValueSource.env` 해석에 사용한다.
- 우선순위: `process.env`가 `.env`보다 우선한다.

## Programmatic API (상위 API)

### 최소 API

- `createRunnerFromHarnessYaml(options)`:
  - `workdir`, `entrypointFileName`, `agentName?`, `instanceKey?`, `stateRoot?`, `logger?`
  - `env?`(ValueSource env 해석용), `resolveSecretRef?`(secretRef 해석용)
  - 반환: `{ processTurn(text), close() }`

## Acceptance Criteria

1. `harness.yaml`에 `Package`(의존 패키지) + `Model` + `Agent`만 있으면 `oh`로 REPL 실행이 시작된다.
2. `oh run "hello"`가 단일 turn을 수행하고 최종 텍스트 응답을 출력한다(모델/키는 ValueSource로 해석).
3. `Agent.tools` selector로 선택된 Tool들이 tool catalog에 포함되고, tool handler가 registry에 등록된다.
4. `Agent.extensions` selector/ref로 선택된 Extension들이 로드되어 pipeline/tool registry에 반영된다.
5. Agent가 2개 이상인데 `--agent`가 없으면 에러로 종료하며, 가능한 Agent 목록을 출력한다.

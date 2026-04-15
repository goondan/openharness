# configuration-api - defineHarness, createHarness, Runtime API, CLI

## 1. 한 줄 요약

사용자는 `harness.config.ts`에 agent/connection을 선언하고, `createHarness()` 또는 `oh` CLI로 runtime을 생성해 실행한다.

## 2. 상위 스펙 연결

- Related Goals: `G-3`, `G-4`, `G-6`
- Related Requirements: `FR-CONFIG-001` ~ `FR-CONFIG-006`
- Related AC: `AC-01`, `AC-06`

## 3. Behavior Specification

### 3.1 Flow: config 선언

**ID:** `CONFIG-DEFINE-01`

- Trigger: `export default defineHarness(config)`
- Rules:
  - `defineHarness()`는 config를 그대로 반환한다.
  - env 해석, runtime 생성, 파일 I/O는 하지 않는다.

### 3.2 Flow: runtime 생성

**ID:** `CONFIG-CREATE-01`

- Trigger: `createHarness(config)`
- Main Flow:
  1. agent/connection 메타데이터를 먼저 수집한다.
  2. model config의 env ref를 실제 환경 변수 값으로 해석한다.
  3. agent별 LLM client, tool registry, middleware registry, event bus를 만든다.
  4. extension을 등록한다.
  5. 정적 tool을 등록한다.
  6. connection과 ingress pipeline을 구성한다.
  7. `HarnessRuntime`을 반환한다.
- Failure:
  - env 미설정이면 `ConfigError`
  - extension 등록 실패면 runtime 생성 실패
  - unknown provider면 `ConfigError`

### 3.3 Flow: CLI `run`

**ID:** `CONFIG-CLI-RUN-01`

- Trigger: `oh run "<text>"`
- Main Flow:
  1. `workdir/.env`를 로드하되 기존 `process.env`를 덮어쓰지 않는다.
  2. config 파일을 읽는다.
  3. agent를 선택한다.
     - `--agent` 지정 시 그 agent
     - 미지정 + agent 1개면 자동 선택
     - 미지정 + agent 2개 이상이면 usage error
  4. `--max-steps`가 있으면 선택된 agent config에만 override 한다.
  5. runtime을 생성하고 `processTurn()`을 실행한다.
  6. 텍스트 결과를 stdout에 출력하고 종료한다.

### 3.4 Flow: CLI `repl`

**ID:** `CONFIG-CLI-REPL-01`

- Trigger: `oh` 또는 `oh repl`
- Main Flow:
  1. `CONFIG-CLI-RUN-01`과 동일하게 env/config/agent를 결정한다.
  2. conversationId를 정한다.
     - `--conversation`이 있으면 그 값
     - 없으면 새 UUID 생성
  3. 입력 루프마다 같은 conversationId로 `processTurn()`을 호출한다.
  4. `exit`, `quit`, `Ctrl+C`, EOF에서 `runtime.close()`를 호출한다.

## 4. Constraint Specification

### CONFIG-CONST-001 - env는 createHarness 시점에 해석된다

- `env("OPENAI_API_KEY")`는 선언 시점이 아니라 runtime 생성 시점에 해석된다.

### CONFIG-CONST-002 - CLI override는 선택된 agent에만 적용된다

- `--max-steps`는 전체 config를 일괄 수정하지 않는다.
- multi-agent 구성에서도 선택된 agent만 변경한다.

### CONFIG-CONST-003 - `.env`보다 기존 환경 변수가 우선한다

- `dotenv.config({ override: false })` 동작을 따른다.

### CONFIG-CONST-004 - 패키지 책임 분리

- `@goondan/openharness-types`: 타입/헬퍼
- `@goondan/openharness`: core runtime + model factory export
- `@goondan/openharness-cli`: CLI
- `@goondan/openharness-base`: 예제 extension/tool 모음

## 5. Interface Specification

```ts
interface HarnessConfig {
  agents: Record<string, AgentConfig>;
  connections?: Record<string, ConnectionConfig>;
}

interface AgentConfig {
  model: ModelConfig;
  extensions?: Extension[];
  tools?: ToolDefinition[];
  maxSteps?: number;
}

interface HarnessRuntime {
  processTurn(
    agentName: string,
    input: string | InboundEnvelope,
    options?: { conversationId?: string },
  ): Promise<TurnResult>;
  ingress: IngressApi;
  control: {
    abortConversation(input: {
      conversationId: string;
      agentName?: string;
      reason?: string;
    }): Promise<AbortResult>;
  };
  close(): Promise<void>;
}
```

### 5.1 Model factory 표면

- `Anthropic(config)`
- `OpenAI(config)`
- `Google(config)`

공통 특징:

- `model`은 필수
- `apiKey`, `baseUrl/baseURL`, provider-specific option은 pass-through
- env ref를 그대로 받을 수 있고, 실제 해석은 `createHarness()`에서 수행한다

### 5.2 CLI 옵션

| 옵션 | 의미 |
| --- | --- |
| `--workdir` | `.env`, 기본 config 탐색 기준 디렉터리 |
| `--config` | config 파일 경로 |
| `--agent` | 실행할 agent 이름 |
| `--conversation` | conversation ID |
| `--max-steps` | 선택된 agent의 runtime `maxSteps` override |

## 6. Realization Specification

- Config loading: [config-loader.ts](/Users/channy/workspace/openharness/packages/cli/src/config-loader.ts:1)
- `.env` loading: [env-loader.ts](/Users/channy/workspace/openharness/packages/cli/src/env-loader.ts:1)
- CLI run: [run.ts](/Users/channy/workspace/openharness/packages/cli/src/commands/run.ts:1)
- CLI repl: [repl.ts](/Users/channy/workspace/openharness/packages/cli/src/commands/repl.ts:1)
- Runtime creation: [create-harness.ts](/Users/channy/workspace/openharness/packages/core/src/create-harness.ts:1)

## 7. Dependency Map

- Depends On: `execution-loop`, `extension-system`, `ingress-pipeline`
- Blocks: getting-started 문서, 예제 config, CLI 사용성
- Parallelizable With: 없음

## 8. Acceptance Criteria

- Given `defineHarness(config)`, When 반환값을 비교하면, Then 같은 객체 참조를 반환한다.
- Given env ref가 포함된 model config, When `createHarness()`를 호출하면, Then 그 시점의 `process.env` 값으로 해석된다.
- Given config에 agent가 하나뿐이면, When `oh run` 또는 `oh repl`을 agent 없이 실행하면, Then 해당 agent가 자동 선택된다.
- Given agent가 둘 이상인데 `--agent`가 없으면, When CLI를 실행하면, Then usage error로 종료한다.
- Given `--max-steps 7`이 전달되면, When runtime을 생성하면, Then 선택된 agent config에만 `maxSteps: 7`이 적용된다.
- Given `.env`와 기존 `process.env`가 같은 키를 가질 때, When CLI가 env를 로드하면, Then 기존 `process.env` 값이 유지된다.

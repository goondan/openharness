# opencode-harness

`anomalyco/opencode`의 하네스 구조를 `@goondan/openharness` 위에 최대한 그대로 이식하는 샘플입니다.

포팅 범위는 단순 tool set이 아니라 다음 계층 전체입니다.

- opencode anthropic system prompt 원문 기반 프롬프트 구성
- harness.yaml 직접 로딩 + agent/model/tool/extension 해석
- opencode 스타일 system prompt + environment + instruction discovery 조립
- `streamText` 기반 turn/step/tool-call session processor
- read/webfetch/truncation/instruction discovery
- snapshot/patch 추적
- conversation compaction + prune + continue

프롬프트는 opencode 원문을 최대한 유지하되, OpenHarness 샘플에서 실제로 노출되는 도구 이름(`opencode__*`, `todo__*`)에 맞춰 최소한만 치환했습니다.

## 실행

레포 루트에서:

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --workdir samples/opencode-harness
```

샘플 자체 CLI로 같은 하네스를 직접 실행할 수도 있습니다.

```bash
pnpm -C samples/opencode-harness build
node samples/opencode-harness/dist/cli.js --workdir samples/opencode-harness
```

원샷 실행:

```bash
node packages/cli/dist/bin.js run "현재 디렉토리 구조를 요약해줘" --workdir samples/opencode-harness
```

또는:

```bash
node samples/opencode-harness/dist/cli.js run "현재 디렉토리 구조를 요약해줘" --workdir samples/opencode-harness
```

## 환경 변수

`samples/opencode-harness/.env` 또는 셸 환경에 다음 키가 필요합니다.

```bash
ANTHROPIC_API_KEY=...
```

## 구성

- `harness.yaml`: `Package / Model / Tool / Extension / Agent`만 사용하며, `opencode-harness` extension이 custom turn processor를 등록
- `prompts/anthropic.txt`: opencode anthropic system prompt 원문 기반, 샘플 도구명에 맞춘 최소 치환 적용
- `src/harness/create-harness.ts`: harness.yaml을 직접 해석해 custom runner 구성
- `src/harness/runtime.ts`: tool/extension/runtime/storage를 직접 조립
- `src/harness/extension.ts`: `oh` 실행 시 같은 turn processor를 등록
- `src/session/processor.ts`: opencode 스타일 streaming step 루프, tool-call, compaction 제어
- `src/tools/opencode.ts`: opencode 도구군 포팅

## 검증 포인트

- `oh`가 `harness.yaml`만 보고 바로 실행된다.
- 샘플 CLI도 같은 `harness.yaml`을 직접 읽어 같은 동작으로 실행된다.
- assistant가 한 턴 동안 하나의 메시지를 유지하며 step/tool 상태를 누적한다.
- tool 출력이 길면 파일로 보존되고, read/webfetch가 opencode와 비슷한 형식으로 응답한다.
- history overflow 시 compaction이 발생하고 이후 turn을 이어간다.

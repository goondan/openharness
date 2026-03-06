# opencode-harness

`anomalyco/opencode`의 하네스 구조를 `@goondan/openharness` 위에 최대한 그대로 이식하는 샘플입니다.

포팅 범위는 단순 tool set이 아니라 다음 계층 전체입니다.

- opencode anthropic system prompt 원문 기반 프롬프트 구성
- harness.yaml 직접 로딩 + agent/model/tool/extension 해석
- opencode 스타일 system prompt + environment + instruction discovery 조립
- OpenHarness core turn/step/tool-call loop 위에서의 정책 주입
- read/webfetch/truncation/instruction discovery
- permission/question/skill/websearch/codesearch 계층
- base extension 기반 context-message / message-compaction 조합

프롬프트는 opencode 원문을 최대한 유지하되, OpenHarness 샘플에서 실제로 노출되는 도구 이름(`opencode__*`, `todo__*`)에 맞춰 최소한만 치환했습니다.

## 실행

레포 루트에서:

```bash
pnpm install
pnpm build
oh --workdir samples/opencode-harness
```

원샷 실행:

```bash
oh run "현재 디렉토리 구조를 요약해줘" --workdir samples/opencode-harness
```

직접 dist 바이너리로 확인하려면:

```bash
node packages/cli/dist/bin.js run "현재 디렉토리 구조를 요약해줘" --workdir samples/opencode-harness
```

## 환경 변수

`samples/opencode-harness/.env` 또는 셸 환경에 다음 키가 필요합니다.

```bash
ANTHROPIC_API_KEY=...
```

## 구성

- `harness.yaml`: `Package / Model / Tool / Extension / Agent`만 사용하며, base extension과 sample extension을 함께 조합
- `prompts/anthropic.txt`: opencode anthropic system prompt 원문 기반, 샘플 도구명에 맞춘 최소 치환 적용
- `src/extensions/opencode-harness.ts`: system prompt 조립, model별 tool filtering, permission/workdir 정책
- `src/session/permission.ts`: opencode식 allow/ask/deny + once/always/reject 저장
- `@goondan/openharness-base`의 `context-message`, `message-compaction`: core loop 위에서 메시지 주입/압축 담당
- `src/tools/opencode.ts`: opencode 도구군 포팅

## 검증 포인트

- `oh`가 `harness.yaml`만 보고 바로 실행된다.
- agent loop는 sample이 아니라 OpenHarness core가 소유한다.
- tool 출력이 길면 파일로 보존되고, read/webfetch가 opencode와 비슷한 형식으로 응답한다.
- history가 길어지면 base `message-compaction`이 개입한다.

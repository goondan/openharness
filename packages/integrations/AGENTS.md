# packages/integrations

`@goondan/openharness-integrations`는 OpenHarness에서 선택적으로 사용할 수 있는 외부 서비스 연동 Tool 번들을 제공한다.

## 원칙

- 코어 런타임(`@goondan/openharness`)에 강제 의존을 만들지 않는다.
- 특정 오케스트레이터/IPC 구현에 결합되는 Tool(예: 프로세스 스폰/재시작 등)은 포함하지 않는다.
- 네트워크/토큰이 필요한 연동은 기본(base) 번들에서 분리해 “옵션”으로 제공한다.


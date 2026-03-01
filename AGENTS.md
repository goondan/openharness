<INSTRUCTIONS>
ALWAYS respond in Korean.

이 레포는 `@goondan/openharness`(에이전트 내부 실행 엔진 = barebone harness framework)와 그 주변 패키지(예: base)를 소유합니다.

핵심 목표:
- Turn/Step/ToolCall 기반 LLM 파이프라인을 독립 라이브러리로 제공한다.
- goondan 오케스트레이터(프로세스/IPC/스폰)에는 의존하지 않는다.
- 타입 계약은 `@goondan/openharness-types`를 기준으로 한다.

주의:
- 오케스트레이터/IPC/커넥터 구현은 이 레포의 범위가 아니다.
- 동작 변경은 스펙/AC 기준으로 추적한다(0.0.x라 breaking은 허용하되 ‘의도’가 문서화돼야 한다).
</INSTRUCTIONS>

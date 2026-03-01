# packages/types

`@goondan/openharness-types`는 OpenHarness/Goondan 런타임 생태계에서 공유되는 **타입 계약(SSOT)** 과 일부 순수 유틸리티(타입 가드/파서)를 소유한다.

## 존재 이유

- 기존 `@goondan/types`의 타입 계약을 이 레포로 가져와(동일한 타입/동일한 API) 런타임 엔진(`@goondan/openharness`)과 함께 버전/배포를 관리한다.
- 오케스트레이터/IPC/커넥터 구현과는 분리된 “공유 계약” 레이어를 제공한다.

## 불변 규칙

- 계약 변경(타입 추가/변경/삭제)은 스펙/AC 기준으로 의도를 문서화한다.
- 런타임 구현 패키지(`@goondan/openharness`)에서는 계약 타입을 새로 정의하지 않고, 필요 시 이 패키지에 먼저 추가한다.

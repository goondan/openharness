/**
 * OTel 호환 추적 컨텍스트
 * 원형: docs/specs/shared-types.md 섹션 5
 */
export interface TraceContext {
  /** 최초 입력부터 전체 실행 체인 끝까지 유지되는 추적 ID (32자 hex, 128-bit) */
  readonly traceId: string;
  /** 현재 실행 단위(Turn/Step/Tool Call)의 고유 ID (16자 hex, 64-bit) */
  readonly spanId: string;
  /** 이 실행을 유발한 상위 실행 단위의 spanId. root span은 undefined */
  readonly parentSpanId?: string;
}


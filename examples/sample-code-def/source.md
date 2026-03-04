# 공통 코드 정의서

- 문서 버전: v1.0
- 최종 수정: 2026-02-27
- 작성자: 시스템관리팀

---

## 변경 이력

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| v1.0 | 2026-02-27 | 홍길동 | 초기 작성 |

## 상태 코드

### 2.1 HTTP 상태 코드

API 응답에서 사용하는 표준 HTTP 상태 코드 정의.

| 코드 | 코드명 | 설명 |
|------|--------|------|
| 200 | OK | 요청 성공 |
| 201 | Created | 리소스 생성 성공 |
| 204 | No Content | 요청 성공, 응답 본문 없음 |
| 400 | Bad Request | 잘못된 요청 파라미터 |
| 401 | Unauthorized | 인증 실패 |
| 403 | Forbidden | 권한 없음 |
| 404 | Not Found | 리소스 없음 |
| 409 | Conflict | 리소스 충돌 |
| 422 | Unprocessable Entity | 유효성 검증 실패 |
| 429 | Too Many Requests | 요청 한도 초과 |
| 500 | Internal Server Error | 서버 내부 오류 |
| 502 | Bad Gateway | 게이트웨이 오류 |
| 503 | Service Unavailable | 서비스 일시 중단 |

### 2.2 비즈니스 상태 코드

시스템 내부에서 사용하는 비즈니스 상태 코드.

| 코드 | 코드명 | 설명 |
|------|--------|------|
| BIZ_001 | PENDING | 처리 대기 |
| BIZ_002 | PROCESSING | 처리 중 |
| BIZ_003 | COMPLETED | 처리 완료 |
| BIZ_004 | CANCELLED | 취소됨 |
| BIZ_005 | FAILED | 처리 실패 |
| BIZ_006 | TIMEOUT | 처리 시간 초과 |
| BIZ_007 | PARTIAL | 부분 처리 |
| BIZ_008 | RETRY | 재처리 대기 |

## 에러 코드

### 3.1 인증 에러

| 코드 | 코드명 | 설명 | 대응 방법 |
|------|--------|------|-----------|
| AUTH_001 | TOKEN_EXPIRED | 인증 토큰 만료 | 토큰 재발급 요청 |
| AUTH_002 | TOKEN_INVALID | 유효하지 않은 토큰 | 재로그인 필요 |
| AUTH_003 | PERMISSION_DENIED | 권한 부족 | 관리자에게 권한 요청 |
| AUTH_004 | IP_BLOCKED | IP 차단됨 | 화이트리스트 등록 요청 |
| AUTH_005 | ACCOUNT_LOCKED | 계정 잠김 | 관리자에게 잠금 해제 요청 |

### 3.2 데이터 에러

| 코드 | 코드명 | 설명 | 대응 방법 |
|------|--------|------|-----------|
| DATA_001 | REQUIRED_FIELD | 필수 필드 누락 | 누락 필드 확인 후 재전송 |
| DATA_002 | INVALID_FORMAT | 데이터 형식 오류 | 필드별 규격 확인 |
| DATA_003 | DUPLICATE_KEY | 중복 키 값 | 기존 데이터 확인 |
| DATA_004 | REFERENCE_ERROR | 참조 무결성 오류 | 참조 대상 데이터 확인 |
| DATA_005 | LENGTH_EXCEEDED | 길이 초과 | 필드 최대 길이 확인 |
| DATA_006 | OUT_OF_RANGE | 값 범위 초과 | 허용 범위 확인 |

### 3.3 시스템 에러

| 코드 | 코드명 | 설명 | 대응 방법 |
|------|--------|------|-----------|
| SYS_001 | DB_CONNECTION | DB 연결 실패 | 운영팀 연락 |
| SYS_002 | TIMEOUT | 처리 시간 초과 | 재시도 또는 운영팀 연락 |
| SYS_003 | QUEUE_FULL | 큐 용량 초과 | 잠시 후 재시도 |
| SYS_004 | EXTERNAL_API | 외부 API 호출 실패 | 외부 시스템 상태 확인 |
| SYS_005 | FILE_IO | 파일 I/O 오류 | 디스크 상태 확인 |

## 국가 코드

ISO 3166-1 alpha-2 기준 주요 국가 코드.

| 코드 | 국가명(한) | 국가명(영) | 통화 코드 | 전화 코드 |
|------|-----------|-----------|-----------|-----------|
| KR | 대한민국 | South Korea | KRW | +82 |
| US | 미국 | United States | USD | +1 |
| JP | 일본 | Japan | JPY | +81 |
| CN | 중국 | China | CNY | +86 |
| GB | 영국 | United Kingdom | GBP | +44 |
| DE | 독일 | Germany | EUR | +49 |
| FR | 프랑스 | France | EUR | +33 |
| SG | 싱가포르 | Singapore | SGD | +65 |
| AU | 호주 | Australia | AUD | +61 |
| CA | 캐나다 | Canada | CAD | +1 |

## 공통 유형 코드

### 5.1 결제 유형

| 코드 | 코드명 | 설명 |
|------|--------|------|
| PAY_CARD | 카드 결제 | 신용/체크카드 결제 |
| PAY_BANK | 계좌이체 | 실시간 계좌이체 |
| PAY_VBANK | 가상계좌 | 가상계좌 입금 |
| PAY_MOBILE | 휴대폰 결제 | 통신사 소액결제 |
| PAY_POINT | 포인트 결제 | 적립 포인트 사용 |
| PAY_COUPON | 쿠폰 결제 | 할인 쿠폰 적용 |

### 5.2 회원 등급

| 코드 | 코드명 | 설명 | 할인율 |
|------|--------|------|--------|
| LV_01 | BRONZE | 브론즈 회원 | 0% |
| LV_02 | SILVER | 실버 회원 | 3% |
| LV_03 | GOLD | 골드 회원 | 5% |
| LV_04 | PLATINUM | 플래티넘 회원 | 7% |
| LV_05 | DIAMOND | 다이아몬드 회원 | 10% |
| LV_06 | VIP | VIP 회원 | 15% |

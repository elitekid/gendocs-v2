# 데이터베이스 테이블 정의서

- 문서 버전: v1.0
- 최종 수정: 2026-02-27
- 작성자: DB관리팀

---

## 변경 이력

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| v1.0 | 2026-02-27 | 김데이터 | 초기 작성 |

## 사용자 관리

### 사용자 (TB_USER)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| user_id | BIGINT | - | Y | AUTO_INCREMENT | 사용자 고유 ID (PK) |
| login_id | VARCHAR | 50 | Y | - | 로그인 아이디 (UK) |
| password_hash | VARCHAR | 256 | Y | - | BCrypt 암호화 비밀번호 |
| user_name | VARCHAR | 100 | Y | - | 사용자 이름 |
| email | VARCHAR | 200 | Y | - | 이메일 주소 (UK) |
| phone | VARCHAR | 20 | N | NULL | 휴대폰 번호 |
| user_grade | VARCHAR | 10 | Y | 'BRONZE' | 회원 등급 (LV_01~LV_06) |
| status | VARCHAR | 10 | Y | 'ACTIVE' | 계정 상태 (ACTIVE/LOCKED/DORMANT) |
| last_login_at | DATETIME | - | N | NULL | 최종 로그인 일시 |
| login_fail_cnt | INT | - | Y | 0 | 연속 로그인 실패 횟수 |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |
| updated_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 수정일시 |

### 사용자 인증 이력 (TB_USER_AUTH_LOG)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| log_id | BIGINT | - | Y | AUTO_INCREMENT | 로그 고유 ID (PK) |
| user_id | BIGINT | - | Y | - | 사용자 ID (FK → TB_USER) |
| auth_type | VARCHAR | 20 | Y | - | 인증 유형 (LOGIN/LOGOUT/FAIL/LOCK) |
| auth_ip | VARCHAR | 45 | Y | - | 접속 IP (IPv4/IPv6) |
| user_agent | VARCHAR | 500 | N | NULL | 브라우저 User-Agent |
| auth_result | VARCHAR | 10 | Y | - | 결과 (SUCCESS/FAIL) |
| fail_reason | VARCHAR | 100 | N | NULL | 실패 사유 |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |

### 사용자 동의 (TB_USER_CONSENT)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| consent_id | BIGINT | - | Y | AUTO_INCREMENT | 동의 고유 ID (PK) |
| user_id | BIGINT | - | Y | - | 사용자 ID (FK → TB_USER) |
| consent_type | VARCHAR | 30 | Y | - | 동의 유형 (TERMS/PRIVACY/MARKETING) |
| is_agreed | CHAR | 1 | Y | 'N' | 동의 여부 (Y/N) |
| agreed_at | DATETIME | - | N | NULL | 동의 일시 |
| expired_at | DATETIME | - | N | NULL | 만료 일시 |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |

## 주문 관리

### 주문 (TB_ORDER)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| order_id | BIGINT | - | Y | AUTO_INCREMENT | 주문 고유 ID (PK) |
| order_no | VARCHAR | 30 | Y | - | 주문번호 (UK, ORD-YYYYMMDD-XXXXX) |
| user_id | BIGINT | - | Y | - | 주문자 ID (FK → TB_USER) |
| order_status | VARCHAR | 15 | Y | 'PENDING' | 주문 상태 (PENDING/PAID/SHIPPED/DONE/CANCEL) |
| total_amount | DECIMAL | 12,0 | Y | 0 | 총 주문 금액 |
| discount_amount | DECIMAL | 12,0 | Y | 0 | 할인 금액 |
| pay_amount | DECIMAL | 12,0 | Y | 0 | 실결제 금액 |
| receiver_name | VARCHAR | 100 | Y | - | 수령자 이름 |
| receiver_phone | VARCHAR | 20 | Y | - | 수령자 전화번호 |
| receiver_addr | VARCHAR | 500 | Y | - | 배송 주소 |
| receiver_zip | VARCHAR | 10 | Y | - | 우편번호 |
| delivery_memo | VARCHAR | 200 | N | NULL | 배송 메모 |
| ordered_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 주문 일시 |
| paid_at | DATETIME | - | N | NULL | 결제 완료 일시 |
| shipped_at | DATETIME | - | N | NULL | 배송 시작 일시 |
| completed_at | DATETIME | - | N | NULL | 주문 완료 일시 |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |
| updated_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 수정일시 |

### 주문 상품 (TB_ORDER_ITEM)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| item_id | BIGINT | - | Y | AUTO_INCREMENT | 상품 고유 ID (PK) |
| order_id | BIGINT | - | Y | - | 주문 ID (FK → TB_ORDER) |
| product_id | BIGINT | - | Y | - | 상품 ID (FK → TB_PRODUCT) |
| product_name | VARCHAR | 200 | Y | - | 주문 시점 상품명 |
| quantity | INT | - | Y | 1 | 수량 |
| unit_price | DECIMAL | 12,0 | Y | 0 | 단가 |
| line_amount | DECIMAL | 12,0 | Y | 0 | 소계 (수량 × 단가) |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |

## 결제 관리

### 결제 (TB_PAYMENT)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| payment_id | BIGINT | - | Y | AUTO_INCREMENT | 결제 고유 ID (PK) |
| payment_no | VARCHAR | 30 | Y | - | 결제번호 (UK, PAY-YYYYMMDD-XXXXX) |
| order_id | BIGINT | - | Y | - | 주문 ID (FK → TB_ORDER) |
| pay_method | VARCHAR | 15 | Y | - | 결제 수단 (PAY_CARD/PAY_BANK/PAY_VBANK) |
| pay_status | VARCHAR | 15 | Y | 'READY' | 결제 상태 (READY/DONE/CANCEL/FAIL) |
| pay_amount | DECIMAL | 12,0 | Y | 0 | 결제 금액 |
| pg_tid | VARCHAR | 100 | N | NULL | PG사 거래 ID |
| pg_code | VARCHAR | 10 | N | NULL | PG사 응답 코드 |
| pg_message | VARCHAR | 500 | N | NULL | PG사 응답 메시지 |
| approved_at | DATETIME | - | N | NULL | 승인 일시 |
| cancelled_at | DATETIME | - | N | NULL | 취소 일시 |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |
| updated_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 수정일시 |

### 환불 (TB_REFUND)

| 컬럼명 | 타입 | 길이 | NOT NULL | 기본값 | 설명 |
|--------|------|------|----------|--------|------|
| refund_id | BIGINT | - | Y | AUTO_INCREMENT | 환불 고유 ID (PK) |
| payment_id | BIGINT | - | Y | - | 원결제 ID (FK → TB_PAYMENT) |
| refund_amount | DECIMAL | 12,0 | Y | 0 | 환불 금액 |
| refund_reason | VARCHAR | 500 | Y | - | 환불 사유 |
| refund_status | VARCHAR | 15 | Y | 'REQUESTED' | 환불 상태 (REQUESTED/DONE/REJECTED) |
| pg_refund_tid | VARCHAR | 100 | N | NULL | PG사 환불 거래 ID |
| requested_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 요청 일시 |
| processed_at | DATETIME | - | N | NULL | 처리 일시 |
| created_at | DATETIME | - | Y | CURRENT_TIMESTAMP | 생성일시 |

## 인덱스 정의

### 사용자 테이블 인덱스

| 인덱스명 | 테이블 | 컬럼 | 유형 | 설명 |
|----------|--------|------|------|------|
| PK_USER | TB_USER | user_id | PRIMARY | 기본키 |
| UK_USER_LOGIN | TB_USER | login_id | UNIQUE | 로그인 ID 유니크 |
| UK_USER_EMAIL | TB_USER | email | UNIQUE | 이메일 유니크 |
| IX_USER_GRADE | TB_USER | user_grade | INDEX | 등급별 조회 |
| IX_USER_STATUS | TB_USER | status | INDEX | 상태별 조회 |

### 주문 테이블 인덱스

| 인덱스명 | 테이블 | 컬럼 | 유형 | 설명 |
|----------|--------|------|------|------|
| PK_ORDER | TB_ORDER | order_id | PRIMARY | 기본키 |
| UK_ORDER_NO | TB_ORDER | order_no | UNIQUE | 주문번호 유니크 |
| IX_ORDER_USER | TB_ORDER | user_id | INDEX | 사용자별 주문 조회 |
| IX_ORDER_STATUS | TB_ORDER | order_status | INDEX | 상태별 조회 |
| IX_ORDER_DATE | TB_ORDER | ordered_at | INDEX | 주문일 범위 조회 |
| PK_ORDER_ITEM | TB_ORDER_ITEM | item_id | PRIMARY | 기본키 |
| IX_ITEM_ORDER | TB_ORDER_ITEM | order_id | INDEX | 주문별 상품 조회 |

### 결제 테이블 인덱스

| 인덱스명 | 테이블 | 컬럼 | 유형 | 설명 |
|----------|--------|------|------|------|
| PK_PAYMENT | TB_PAYMENT | payment_id | PRIMARY | 기본키 |
| UK_PAYMENT_NO | TB_PAYMENT | payment_no | UNIQUE | 결제번호 유니크 |
| IX_PAY_ORDER | TB_PAYMENT | order_id | INDEX | 주문별 결제 조회 |
| IX_PAY_STATUS | TB_PAYMENT | pay_status | INDEX | 상태별 조회 |
| PK_REFUND | TB_REFUND | refund_id | PRIMARY | 기본키 |
| IX_REFUND_PAY | TB_REFUND | payment_id | INDEX | 결제별 환불 조회 |

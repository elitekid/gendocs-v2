# API 엔드포인트 목록

- 문서 버전: v1.0
- 최종 수정: 2026-02-27
- 작성자: 플랫폼개발팀

---

## 변경 이력

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| v1.0 | 2026-02-27 | 이개발 | 초기 작성 |

## 인증 (Auth)

### 로그인/로그아웃

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| POST | /api/v1/auth/login | 로그인 | 불필요 | loginId, password | 200, 401, 423 |
| POST | /api/v1/auth/logout | 로그아웃 | Bearer Token | - | 200, 401 |
| POST | /api/v1/auth/refresh | 토큰 갱신 | Refresh Token | refreshToken | 200, 401 |

### 비밀번호 관리

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| POST | /api/v1/auth/password/reset | 비밀번호 초기화 요청 | 불필요 | email | 200, 404 |
| PUT | /api/v1/auth/password/reset | 비밀번호 초기화 확인 | 불필요 | token, newPassword | 200, 400, 410 |
| PUT | /api/v1/auth/password/change | 비밀번호 변경 | Bearer Token | currentPassword, newPassword | 200, 400, 401 |

## 사용자 (User)

### 사용자 CRUD

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/users | 사용자 목록 조회 | Bearer Token | page, size, sort, grade | 200, 401, 403 |
| GET | /api/v1/users/{id} | 사용자 상세 조회 | Bearer Token | - | 200, 401, 404 |
| POST | /api/v1/users | 사용자 등록 | 불필요 | loginId, password, name, email | 201, 400, 409 |
| PUT | /api/v1/users/{id} | 사용자 정보 수정 | Bearer Token | name, email, phone | 200, 400, 401, 404 |
| DELETE | /api/v1/users/{id} | 사용자 삭제 (논리) | Bearer Token + Admin | - | 204, 401, 403, 404 |

### 사용자 프로필

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/users/me | 내 정보 조회 | Bearer Token | - | 200, 401 |
| PUT | /api/v1/users/me | 내 정보 수정 | Bearer Token | name, phone | 200, 400, 401 |
| GET | /api/v1/users/me/consents | 내 동의 목록 | Bearer Token | - | 200, 401 |
| PUT | /api/v1/users/me/consents | 동의 항목 변경 | Bearer Token | consentType, isAgreed | 200, 400, 401 |

## 상품 (Product)

### 상품 CRUD

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/products | 상품 목록 조회 | 불필요 | page, size, category, keyword | 200 |
| GET | /api/v1/products/{id} | 상품 상세 조회 | 불필요 | - | 200, 404 |
| POST | /api/v1/products | 상품 등록 | Bearer Token + Admin | name, price, category, description | 201, 400, 401, 403 |
| PUT | /api/v1/products/{id} | 상품 수정 | Bearer Token + Admin | name, price, category, description | 200, 400, 401, 403, 404 |
| DELETE | /api/v1/products/{id} | 상품 삭제 | Bearer Token + Admin | - | 204, 401, 403, 404 |

### 상품 카테고리

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/categories | 카테고리 목록 | 불필요 | parentId | 200 |
| POST | /api/v1/categories | 카테고리 등록 | Bearer Token + Admin | name, parentId | 201, 400, 401, 403 |
| PUT | /api/v1/categories/{id} | 카테고리 수정 | Bearer Token + Admin | name | 200, 400, 401, 403, 404 |
| DELETE | /api/v1/categories/{id} | 카테고리 삭제 | Bearer Token + Admin | - | 204, 401, 403, 404 |

## 주문 (Order)

### 주문 관리

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/orders | 주문 목록 조회 | Bearer Token | page, size, status, from, to | 200, 401 |
| GET | /api/v1/orders/{id} | 주문 상세 조회 | Bearer Token | - | 200, 401, 403, 404 |
| POST | /api/v1/orders | 주문 생성 | Bearer Token | items[], receiverName, receiverPhone, receiverAddr | 201, 400, 401 |
| PUT | /api/v1/orders/{id}/cancel | 주문 취소 | Bearer Token | cancelReason | 200, 400, 401, 403, 404 |

### 배송 조회

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/orders/{id}/delivery | 배송 상태 조회 | Bearer Token | - | 200, 401, 404 |
| GET | /api/v1/orders/{id}/delivery/tracking | 배송 추적 상세 | Bearer Token | - | 200, 401, 404 |

## 결제 (Payment)

### 결제 처리

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| POST | /api/v1/payments | 결제 요청 | Bearer Token | orderId, payMethod, amount | 200, 400, 401 |
| POST | /api/v1/payments/confirm | 결제 승인 확인 | Bearer Token | paymentId, pgTid | 200, 400, 401 |
| GET | /api/v1/payments/{id} | 결제 상세 조회 | Bearer Token | - | 200, 401, 404 |

### 환불 처리

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| POST | /api/v1/payments/{id}/refund | 환불 요청 | Bearer Token | refundAmount, refundReason | 200, 400, 401, 404 |
| GET | /api/v1/payments/{id}/refund | 환불 상태 조회 | Bearer Token | - | 200, 401, 404 |

## 관리자 (Admin)

### 대시보드

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/admin/dashboard | 대시보드 요약 | Bearer Token + Admin | - | 200, 401, 403 |
| GET | /api/v1/admin/stats/orders | 주문 통계 | Bearer Token + Admin | from, to, groupBy | 200, 401, 403 |
| GET | /api/v1/admin/stats/users | 사용자 통계 | Bearer Token + Admin | from, to | 200, 401, 403 |
| GET | /api/v1/admin/stats/revenue | 매출 통계 | Bearer Token + Admin | from, to, groupBy | 200, 401, 403 |

### 시스템 관리

| Method | Path | 설명 | 인증 | 요청 파라미터 | 응답 코드 |
|--------|------|------|------|---------------|-----------|
| GET | /api/v1/admin/health | 시스템 상태 확인 | 불필요 | - | 200, 503 |
| GET | /api/v1/admin/config | 시스템 설정 조회 | Bearer Token + Admin | - | 200, 401, 403 |
| PUT | /api/v1/admin/config | 시스템 설정 변경 | Bearer Token + Admin | key, value | 200, 400, 401, 403 |
| POST | /api/v1/admin/cache/clear | 캐시 초기화 | Bearer Token + Admin | cacheType | 200, 401, 403 |

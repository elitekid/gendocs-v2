# Graphviz 다이어그램 테스트 문서

| 항목 | 내용 |
|------|------|
| 프로젝트 | 다이어그램 렌더링 테스트 |
| 버전 | v1.0 |
| 작성일 | 2026-02-20 |
| 작성자 | 개발팀 |

---

## 변경 이력

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| v1.0 | 2026-02-20 | 개발팀 | 초기 작성 |

## 1. 시스템 아키텍처

본 문서는 Graphviz DOT 언어로 작성된 다이어그램의 자동 렌더링을 테스트한다.

### 1.1 전체 시스템 구조

<!-- diagram: 전체 시스템 아키텍처 -->
```dot
digraph SystemArchitecture {
    rankdir=TB
    node [shape=box]

    subgraph cluster_frontend {
        label="프론트엔드"
        Web [label="웹 애플리케이션"]
        Mobile [label="모바일 앱"]
    }

    subgraph cluster_backend {
        label="백엔드"
        Gateway [label="API Gateway"]
        Auth [label="인증 서비스"]
        Order [label="주문 서비스"]
        Payment [label="결제 서비스"]
    }

    subgraph cluster_data {
        label="데이터 계층"
        DB [label="PostgreSQL"]
        Cache [label="Redis"]
        MQ [label="RabbitMQ"]
    }

    Web -> Gateway
    Mobile -> Gateway
    Gateway -> Auth
    Gateway -> Order
    Gateway -> Payment
    Order -> DB
    Order -> MQ
    Payment -> DB
    Auth -> Cache
    Auth -> DB
}
```

### 1.2 서비스 간 통신

각 서비스는 API Gateway를 통해 라우팅되며, 비동기 처리가 필요한 경우 RabbitMQ를 활용한다.

## 2. 데이터 흐름

### 2.1 주문 처리 플로우

<!-- diagram: 주문 처리 흐름도 -->
```graphviz
digraph OrderFlow {
    rankdir=LR
    node [shape=box]

    Start [label="주문 접수" shape=ellipse]
    Validate [label="유효성 검증"]
    Stock [label="재고 확인"]
    Pay [label="결제 처리"]
    Ship [label="배송 준비"]
    Done [label="완료" shape=ellipse]
    Error [label="오류 처리" shape=diamond]

    Start -> Validate
    Validate -> Stock [label="성공"]
    Validate -> Error [label="실패"]
    Stock -> Pay [label="재고 있음"]
    Stock -> Error [label="재고 없음"]
    Pay -> Ship [label="결제 완료"]
    Pay -> Error [label="결제 실패"]
    Ship -> Done
    Error -> Start [label="재시도"]
}
```

### 2.2 데이터 모델

주문 데이터는 PostgreSQL에 저장되며, 결제 상태는 Redis로 캐싱한다.

| 항목 | 규격 |
|------|------|
| 주문 테이블 | orders |
| 결제 테이블 | payments |
| 배송 테이블 | shipments |

## 3. 결론

Graphviz DOT 언어를 활용하여 시스템 아키텍처와 데이터 흐름을 시각화하였다.

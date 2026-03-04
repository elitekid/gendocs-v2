# 환경별 설정 매트릭스

- 문서 버전: v1.0
- 최종 수정: 2026-02-27
- 작성자: 인프라팀

---

## 변경 이력

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| v1.0 | 2026-02-27 | 박인프라 | 초기 작성 |

## 데이터베이스

### RDB (PostgreSQL)

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Host | dev-db.internal | stg-db.internal | prd-db-01.internal | 운영은 이중화 |
| Port | 5432 | 5432 | 5432 | - |
| Database | myapp_dev | myapp_stg | myapp_prd | - |
| Max Pool Size | 5 | 10 | 30 | 운영 트래픽 기준 |
| Min Pool Size | 1 | 2 | 10 | - |
| Connection Timeout | 5000ms | 5000ms | 3000ms | 운영은 더 짧게 |
| Idle Timeout | 30000ms | 30000ms | 10000ms | - |
| SSL | off | on | on | 스테이징 이상 필수 |
| Read Replica | 없음 | 없음 | prd-db-02.internal | 조회 전용 |
| Backup 주기 | 없음 | 일 1회 | 일 4회 + WAL | - |

### Redis (캐시)

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Host | dev-redis.internal | stg-redis.internal | prd-redis.internal | - |
| Port | 6379 | 6379 | 6379 | - |
| Mode | Standalone | Standalone | Cluster (3 master) | 운영 HA 구성 |
| Max Memory | 256MB | 512MB | 4GB | - |
| Eviction Policy | allkeys-lru | allkeys-lru | volatile-lru | - |
| Default TTL | 300s | 300s | 600s | - |
| Password | 없음 | redis_stg_pw | Vault 관리 | 운영 시크릿 관리 |
| Persistence | off | off | AOF (everysec) | - |

## 애플리케이션

### Spring Boot 설정

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Profile | dev | stg | prd | - |
| Server Port | 8080 | 8080 | 8080 | 앞단 LB가 443 처리 |
| Log Level (ROOT) | DEBUG | INFO | WARN | - |
| Log Level (App) | DEBUG | DEBUG | INFO | - |
| Log 출력 | console + file | file | file + ELK | - |
| JVM Heap | -Xmx512m | -Xmx1g | -Xmx2g | - |
| GC | G1 | G1 | ZGC | JDK 17+ |
| Actuator Endpoints | 전체 | health, info, metrics | health, info | - |
| Graceful Shutdown | 0s | 15s | 30s | - |
| Thread Pool (Tomcat) | 10 | 50 | 200 | max-threads |

### JWT / 인증 설정

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Access Token TTL | 24h | 1h | 15m | - |
| Refresh Token TTL | 30d | 7d | 7d | - |
| JWT Secret | 고정값 (테스트) | 환경변수 | Vault 관리 | - |
| CORS Origin | * | *.staging.myapp.com | *.myapp.com | - |
| Rate Limit (Login) | 없음 | 10/min | 5/min | IP 기준 |
| Rate Limit (API) | 없음 | 100/min | 60/min | 토큰 기준 |
| Session Timeout | 없음 | 30m | 15m | - |

## 외부 연동

### PG (Payment Gateway)

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Provider | KG이니시스 | KG이니시스 | KG이니시스 | - |
| API URL | https://stgstdpay.inicis.com | https://stgstdpay.inicis.com | https://stdpay.inicis.com | 개발=스테이징 동일 |
| Merchant ID | INIpayTest | STG_MYAPP01 | PRD_MYAPP01 | - |
| API Key | 테스트키 | 환경변수 | Vault 관리 | - |
| Timeout | 10000ms | 10000ms | 5000ms | - |
| Retry | 0 | 1 | 3 | 자동 재시도 횟수 |
| Webhook URL | 없음 | https://stg-api.myapp.com/webhook/pg | https://api.myapp.com/webhook/pg | - |

### SMS / 알림

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Provider | 콘솔 로그 | NHN Cloud | NHN Cloud | 개발은 실발송 안함 |
| API URL | 없음 | https://api-sms.cloud.toast.com | https://api-sms.cloud.toast.com | - |
| App Key | 없음 | STG_APP_KEY | PRD_APP_KEY | - |
| 발신 번호 | - | 02-1234-5678 | 02-1234-5678 | - |
| 일 발송 한도 | - | 100건 | 50,000건 | - |
| 템플릿 관리 | 없음 | DB 관리 | DB + 캐시 | - |

### S3 (Object Storage)

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| Provider | MinIO (로컬) | AWS S3 | AWS S3 | - |
| Bucket | dev-myapp | stg-myapp-bucket | prd-myapp-bucket | - |
| Region | - | ap-northeast-2 | ap-northeast-2 | - |
| Access Key | minioadmin | 환경변수 | IAM Role | 운영은 EC2 Role |
| Max Upload Size | 10MB | 10MB | 50MB | - |
| CDN | 없음 | 없음 | CloudFront | d1234.cloudfront.net |
| Lifecycle | 없음 | 30일 삭제 | 90일 → Glacier | - |

## 인프라 / 배포

### 서버 사양

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| 인프라 | Docker (로컬) | AWS ECS Fargate | AWS ECS Fargate | - |
| vCPU | 1 | 1 | 2 | Task 정의 |
| Memory | 1GB | 2GB | 4GB | Task 정의 |
| 인스턴스 수 | 1 | 1 | 2~4 (Auto Scaling) | Target: CPU 60% |
| Health Check | /actuator/health | /actuator/health | /actuator/health | - |
| Health Interval | - | 30s | 10s | ALB 설정 |
| Deployment | docker-compose up | Blue/Green | Blue/Green | CodeDeploy |

### CI/CD 파이프라인

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| 트리거 | push (develop) | merge (release/*) | 수동 승인 | - |
| CI Tool | GitHub Actions | GitHub Actions | GitHub Actions | - |
| 빌드 | Gradle bootJar | Gradle bootJar | Gradle bootJar | - |
| 테스트 | Unit | Unit + Integration | Unit + Integration + E2E | - |
| 이미지 레지스트리 | 로컬 Docker | ECR (stg) | ECR (prd) | - |
| 배포 전략 | 즉시 | Blue/Green (자동) | Blue/Green (수동 승인) | - |
| Rollback | docker-compose down | 자동 (5분 이내) | 수동 1-click | - |
| 알림 | 없음 | Slack #deploy-stg | Slack #deploy-prd + PagerDuty | - |

### 모니터링

| 항목 | 개발 | 스테이징 | 운영 | 비고 |
|------|------|----------|------|------|
| APM | 없음 | 없음 | Datadog APM | - |
| Metrics | Prometheus (로컬) | CloudWatch | CloudWatch + Grafana | - |
| Logs | 콘솔 출력 | CloudWatch Logs | CloudWatch + ELK | - |
| Tracing | 없음 | 없음 | AWS X-Ray | - |
| Alerting | 없음 | Slack 알림 | PagerDuty + Slack | - |
| Dashboard | 없음 | CloudWatch | Grafana | - |
| 로그 보관 | - | 7일 | 90일 (S3 아카이브 1년) | - |

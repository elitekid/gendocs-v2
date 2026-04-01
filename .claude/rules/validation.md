---
globs:
  - "tools/validate-docx.py"
  - "tools/review-docx.py"
  - "tools/lint-md.py"
  - "tests/unit/**"
  - "tests/smoke/**"
  - "tools/score-docx.js"
  - "tools/pipeline-audit.js"
  - "lib/scoring.js"
  - "tests/**"
---

# 검증 체계 상세

## 페이지 레이아웃 시뮬레이션 (validate-docx.py)

XML에서 각 요소의 높이를 추정하여 가로 A4 기준(가용 높이 ~457pt)으로 페이지 배치를 시뮬레이션.

| 요소 | 추정 높이 |
|------|----------|
| H2 | 42pt |
| H3 | 34pt |
| 일반 단락 | 22pt x 줄 수 |
| 불릿 | 20pt |
| 테이블 | 헤더 28pt + 행당 22pt |
| 이미지 | XML extent에서 실제 크기 읽음 (EMU->pt) + 30pt |
| 빈 단락/spacer | 8pt |

## 레이아웃 권장사항 (3가지 규칙)

| 규칙 | 감지 조건 | 심각도 | 조치 |
|------|----------|--------|------|
| 이미지 독립 배치 | 이미지가 명시적 break 없이 다른 콘텐츠와 같은 페이지 | WARN | 이미지 섹션 앞에 pageBreak() 추가 |
| 고아 제목 | 제목 아래 60pt 미만 공간 (제목만 달랑 남음) | INFO | 제목 앞에 pageBreak() 추가 고려 |
| 테이블 분할 | 큰 테이블이 페이지 40% 이하 공간에서 시작 | INFO | 테이블 앞 break 또는 크기 조정 |

**오버플로우 허용 규칙**: 이미지가 시뮬레이션 상 자동 오버플로우로 다음 페이지에 배치되더라도, 이전 페이지가 명시적 break로 시작되었고 해당 이미지의 섹션 제목이 이전 페이지에 있으면 의도된 배치로 판단하여 WARN을 발생시키지 않음.

## AI 셀프리뷰 (review-docx.py)

변환된 DOCX의 콘텐츠 품질을 자동 분석 (validate-docx.py와 별도).

```bash
# 소스 비교 포함
python -X utf8 tools/review-docx.py output/문서.docx --config doc-configs/문서.json --json

# 단독
python -X utf8 tools/review-docx.py output/문서.docx --json
```

**검사 항목 (7가지)**:

| 검사 | 유형 | 심각도 | 설명 |
|------|------|--------|------|
| 콘텐츠 정합성 | CONTENT_MISSING / CONTENT_EXTRA | WARN / INFO | 소스 MD vs DOCX 요소 수 비교 |
| 컬럼 너비 불균형 | WIDTH_IMBALANCE | SUGGEST | 줄바꿈 컬럼 + 빈 인접 컬럼 -> 너비 재분배 제안 |
| 넓은 낭비 | WIDE_WASTE | INFO | 컬럼 활용률 30% 미만 |
| 테이블 가독성 | TOO_MANY_COLUMNS / CELL_OVERFLOW / EMPTY_COLUMN | INFO | 8+ 컬럼, 4줄+ 셀, 빈 컬럼 |
| 코드 무결성 | TRUNCATED_JSON / EMPTY_CODE | WARN | 잘린 JSON, 빈 코드블록 |
| 제목 구조 | DUPLICATE_HEADING / LONG_SECTION | WARN / INFO | 연속 동일 제목, H3 없는 긴 섹션 |
| 이미지 비율 | NARROW_IMAGE / FLAT_IMAGE | WARN | 다이어그램 폭 < 30% 또는 높이 < 80pt |

## 테스트

```bash
npm test              # 단위 테스트 (순수 함수 검증, 1초)
npm run test:smoke    # 스모크 테스트 (examples 3개 변환 확인, ~15초)
npm run test:all      # 전체
```

코드 수정 후 `npm test` 반드시 실행. 큰 변경 시 `npm run test:all`.

## 성공 패턴 DB

`lib/patterns.json` — 성공한 doc-config에서 재사용 가능한 tableWidths 패턴 저장.

```bash
node tools/extract-patterns.js             # 패턴 추출
node tools/extract-patterns.js --audit     # + 다양성 감사
```

**fallback 체인** (converter-core.js `calculateTableWidths`):
1. doc-config `tableWidths` (명시적 설정)
2. `lib/patterns.json` common (3개+ 문서에서 공유)
3. `lib/patterns.json` byDocType (문서 유형별)
4. defaultTableWidths (가중치 기반)

승격 규칙: 3개 이상 doc-config에서 동일 너비로 사용 -> common 승격.

## 에피소딕 메모리 (Reflexion)

`lib/reflections.json` — 교정 경험 저장소 (FIX, ROLLBACK, SUGGEST_APPLIED, PASS).

- **기록 시점**: FIX 성공 후, ROLLBACK 후, SUGGEST 적용 후, PASS (WARN 0)
- **주입 시점**: doc-config 작성 시 reflections 1순위 조회
- **매칭 우선순위**: 동일 docType > 동일 tags > 동일 issue.type
- **크기 제한**: 200개 초과 시 오래된 PASS부터 삭제, ROLLBACK은 보존
- docType: api-spec, batch-spec, ops-guide, security-doc, architecture, migration, policy-doc, report, general

## 다차원 품질 점수

5차원 1-10 점수로 문서 품질 정량화. PASS/FIX/SKIP/ROLLBACK 판정과 병행.

| 차원 | 가중치 | 데이터 소스 |
|------|--------|-------------|
| content | 0.30 | review-docx `contentFidelity` |
| layout | 0.25 | validate-docx `issues[]` + `pages[]` + review-docx `NARROW_IMAGE/FLAT_IMAGE` |
| table | 0.20 | review-docx `tableWidths` + `tableReadability` |
| code | 0.15 | review-docx `codeIntegrity` |
| structure | 0.10 | validate `hasHeader/Footer` + review `headingStructure` |

```bash
node tools/score-docx.js doc-configs/문서.json [--save]      # 단일
node tools/score-docx.js --batch [--save] [--skip-convert]   # 전체
```

## 파이프라인 진단

MD->config->변환->DOCX 전체 체인을 5단계로 진단.

```bash
node tools/pipeline-audit.js doc-configs/문서.json [--json] [--skip-convert]
node tools/pipeline-audit.js --batch [--skip-convert]
```

5단계: lint-md -> convert -> validate -> review -> score

Health: EXCELLENT(9.5+, WARN 0) / GOOD(8.0+, WARN<=2) / NEEDS_FIX(<8.0 or WARN>2) / BROKEN(CRITICAL or 변환 실패)

## 패턴 붕괴 방지

AI 생성 doc-config -> patterns.json 피드백의 Model Collapse 방지.
- doc-config `_meta.createdBy`: `"human"` / `"ai"` / 없으면 `"unknown"`
- `_provenance` 섹션이 patterns.json에 자동 생성
- `extract-patterns.js --audit` — 출처 추적 + 다양성 메트릭

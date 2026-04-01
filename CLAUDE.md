# gendocs — Claude Code 문서 생성 툴킷

## 프로젝트 정의

gendocs는 **마크다운(MD)을 원본으로, 모든 형태의 비즈니스 문서를 자동 생성**하는 Claude Code 전용 툴킷이다.
사용자가 원본 파일과 요구사항을 제공하면, Claude Code가 변환 스크립트를 작성·실행하여 최종 산출물을 만든다.

> **핵심 원칙**: 이 프로젝트에서 Claude Code는 문서 생성 전문가다. 코드를 사람이 짜는 것이 아니라, Claude Code가 기존 템플릿과 예시를 참조하여 새로운 변환 스크립트를 작성하고 실행한다.

## 작업 규칙

1. **파일 확인 필수**: 유사한 이름의 파일이 여러 개 존재할 때, 편집·변환 전에 정확한 파일 경로를 사용자에게 확인한다. 추측하여 잘못된 파일을 편집하지 않는다.
2. **콘텐츠 범위 준수**: 소스 MD에 없는 내용을 추가·확장하지 않는다. 사용자가 "심플하게", "내용만 바꿔서" 등 범위를 제한하면 최소 산출물만 생성한다.

---

## 지원 포맷

| 포맷 | 확장자 | 기술 스택 | 상태 |
|------|--------|-----------|------|
| **Word** | .docx | Node.js + `docx` | 검증 완료 |
| **Excel** | .xlsx | Node.js + `exceljs` | 검증 완료 |
| **Mermaid** | .png | `@mermaid-js/mermaid-cli` | 검증 완료 |
| **Graphviz** | .png | `@hpcc-js/wasm-graphviz` + puppeteer | 검증 완료 |
| **PowerPoint** | .pptx | `pptxgenjs` | 예정 |
| **PDF** | .pdf | `pdf-lib` 또는 Puppeteer | 예정 |

---

## 핵심 명령어

```bash
# DOCX/XLSX 변환
node lib/convert.js doc-configs/내문서.json

# 변환 + 검증
node lib/convert.js doc-configs/내문서.json --validate

# DOCX 레이아웃 검증
python -X utf8 tools/validate-docx.py output/문서.docx --json

# AI 셀프리뷰 (콘텐츠 품질)
python -X utf8 tools/review-docx.py output/문서.docx --config doc-configs/문서.json --json

# MD 린트 (변환 전)
python -X utf8 tools/lint-md.py source/문서.md --json

# DOCX 텍스트 추출 (기존 문서 → MD)
python -X utf8 tools/extract-docx.py output/문서.docx --json

# 단위 테스트 (코드 수정 후 반드시 실행)
npm test

# 스모크 테스트 (examples 변환 확인)
npm run test:smoke

# 품질 점수
node tools/score-docx.js doc-configs/문서.json --save
```

---

## 사용자 플로우

### 스킬 실행 (권장)

```
/gendocs                        → 대화형 문서 생성 (아무 소스 → MD → DOCX)
/gendocs source/내문서.md       → 특정 MD 파일을 원본으로 바로 시작
/gendocs C:/경로/기존문서.docx  → 기존 DOCX를 읽어서 깔끔하게 재생성
/validate                       → 생성된 DOCX 검증
/validate output/내문서.docx    → 특정 파일 검증
```

### Flow A. 신규 DOCX 생성 (핵심 플로우)

```
① 소스 입력 (MD 파일 / 기존 DOCX / 텍스트 / 구두 설명 → MD 작성)
      ↓
①-1 MD 셀프리뷰 (필수 — 생략 금지)
   - lint-md.py 자동 린트 → AI 읽기 리뷰 → 수정
   ※ 이 단계를 완료하기 전에 ②로 진행하지 않는다
      ↓
② doc-configs/내문서.json 작성 (docInfo, tableWidths, pageBreaks, images)
      ↓
③ node lib/convert.js doc-configs/내문서.json
      ↓
④ python -X utf8 tools/validate-docx.py output/내문서.docx --json
      ↓
⑤ 자가개선 루프 (최대 4회, 조기 종료 포함)
   ├─ WARN 0건 → 완료 (PASS)
   ├─ WARN 있음 + 개선 중 → doc-config 수정 → 재실행 (FIX)
   ├─ INFO만 있음 → 완료 (SKIP)
   ├─ 페이지 수 10%↑ → 수정 롤백 (ROLLBACK)
   ├─ WARN 수 2회 동일 → 조기 종료 (STOP_PLATEAU)
   └─ WARN 수 증감 반복 → 조기 종료 (STOP_OSCILLATION)
```

### Flow B~F 요약

- **B. 기존 문서 수정**: source MD 수정 → 기존 doc-config 확인/갱신 → 변환
- **C. 다이어그램 포함**: `<!-- diagram: 설명 -->` + mermaid/dot 코드블록 → 자동 PNG 렌더링 → DOCX 삽입
- **D. 프로젝트 온보딩**: `npm install && pip install -r requirements.txt` → examples/ 확인
- **E. 새 포맷 확장**: templates/{format}/ 템플릿 → converter → 검증 도구 → 성공 사례
- **F. 레퍼런스 스타일 매칭**: extract-docx.py로 XML 분석 → converters/ 전용 converter 작성 → XML 수준 1:1 비교

---

## 폴더 구조

```
gendocs/
├── CLAUDE.md                        ← 이 파일
├── .claude/rules/                   ← 세부 참조 규칙 (theme, validation, diagram, xlsx)
├── .claude/skills/                  ← /gendocs, /validate 스킬
├── lib/                             ← 변환 엔진
│   ├── converter-core.js            ← 공통 DOCX 변환 (파싱, 너비 계산, 변환, 빌드)
│   ├── converter-xlsx.js            ← XLSX 변환 (시트 분할, sheets[], columnDefs)
│   ├── xlsx-utils.js                ← XLSX 유틸 (Rich Text, 의미론적 색상, 타입 변환)
│   ├── convert.js                   ← CLI 진입점 (DOCX/XLSX 자동 라우팅)
│   ├── theme-utils.js               ← 테마 색상 유틸 (12슬롯→30키 파생)
│   ├── diagram-renderer.js          ← 다이어그램 렌더링 (Mermaid/Graphviz + 테마 매핑)
│   ├── scoring.js                   ← 다차원 품질 점수 (순수 함수)
│   ├── patterns.json                ← 공유 패턴 DB (tableWidths)
│   └── reflections.json             ← 에피소딕 메모리 (교정 경험)
├── doc-configs/                     ← 문서별 설정 JSON
├── source/                          ← 원본 MD
├── output/                          ← 생성 결과물
├── themes/                          ← 테마 프리셋 JSON (5종)
├── templates/                       ← 포맷별 템플릿
│   ├── docx/ (basic.js, professional.js)
│   └── xlsx/ (basic.js, data-spec.js)
├── converters/                      ← 레거시 전용 변환 (커스텀 로직용)
├── examples/                        ← 성공 사례 (sample-api, sample-batch, sample-code-def)
├── tests/                           ← 단위 테스트 (unit/) + 스모크 테스트 (smoke/)
└── tools/                           ← 검증·유틸리티
```

---

## 템플릿 시스템

### 설계 원칙
- 각 포맷마다 독립된 템플릿 모듈 (스타일 정의 + 요소 생성 API)
- 새 문서를 만들 때 **템플릿을 수정하지 않는다**. 변환 스크립트(또는 doc-config)만 새로 작성
- 템플릿은 **factory function 패턴**: `module.exports = createTemplate` → `createTemplate(theme)` 호출

### DOCX 템플릿

**basic.js** — 세로, 심플
- API: `h1~h3`, `text`, `bullet`, `note`, `infoBox`, `warningBox`, `pageBreak`, `spacer`, `createCodeBlock`, `createSimpleTable`, `createTable`, `createCoverPage`, `createDocument`, `saveDocument`

**professional.js** — 가로, 프로페셔널
- 추가 API: `h4`, `labelText`, `flowBox`, `createImage`, `createJsonBlock`, `createSyntaxCodeBlock`
- 특징: 다크테마 코드블록, 로고 표지, 머릿글/바닥글, 이미지 삽입

**saveDocument 특수 처리**:
- EBUSY 시 Word 프로세스 자동 종료 후 최대 3회 재시도
- `word/settings.xml`에 맞춤법/문법 오류 숨기기 자동 삽입

---

## doc-config JSON 구조

### DOCX

```json
{
  "source": "source/내문서.md",
  "output": "output/내문서_{version}.docx",
  "template": "professional",
  "theme": "office-standard",
  "_meta": { "createdBy": "ai", "createdAt": "2026-01-01" },
  "style": { "colors": { "accent": "FF6B35" } },
  "h1CleanPattern": "^# 문서제목",
  "headerCleanUntil": "## 변경 이력",
  "docInfo": {
    "title": "문서 제목", "subtitle": "부제목", "version": "v1.0",
    "author": "작성자", "company": "회사", "createdDate": "2026-01-01"
  },
  "tableWidths": { "헤더1|헤더2|헤더3": [w1, w2, w3] },
  "pageBreaks": {
    "afterChangeHistory": true,
    "h2BreakBeforeSection": 4,
    "imageH3AlwaysBreak": true,
    "defaultH3Break": true,
    "h2Sections": [], "h3Sections": [], "noBreakH3Sections": []
  },
  "images": {
    "basePath": "examples/api-spec",
    "sectionMap": { "1.1": { "file": "image.png", "width": 780, "height": 486 } }
  },
  "diagrams": { "enabled": true, "width": 1024, "scale": 2 }
}
```

### XLSX

```json
{
  "source": "source/코드정의서.md",
  "output": "output/코드정의서_{version}.xlsx",
  "format": "xlsx",
  "template": "data-spec",
  "theme": "office-modern",
  "docInfo": { "title": "...", "version": "v1.0" },
  "xlsx": {
    "sheetMapping": "h2",
    "coverSheet": true,
    "freezeHeaders": true,
    "autoFilter": true,
    "semanticColors": false,
    "orientation": "landscape"
  },
  "tableWidths": { "코드|코드명|설명": [12, 20, 45] }
}
```

- `format: "xlsx"` 또는 output `.xlsx` → XLSX 변환
- `tableWidths`는 Excel 문자 폭 단위 (DOCX의 DXA 아님)
- `sheetMapping`: `"h2"` (기본), `"single"`, `"table"`, `"h3"`, `"custom"` (sheets[] 사용)
- 커스텀 sheets[] 구조: `.claude/rules/xlsx.md` 참조

---

## 테마 시스템

Word 12슬롯(dk1~folHlink)에서 30키 colors를 자동 파생하는 v2 구조.

**Fallback 체인**: `doc-config "style"` > `theme JSON (slots→colors)` > `템플릿 DEFAULT`

5개 프리셋: office-standard, office-modern(기본), blue-warm, blue-green, marquee
- 기존 테마명(`navy-professional` 등)도 THEME_ALIASES로 자동 매핑
- 상세 매핑표: `.claude/rules/theme.md` 참조

### 스타일 가이드

| 요소 | 값 (office-standard 기준) |
|------|-----|
| 기본 폰트 | Malgun Gothic |
| 코드 폰트 | Consolas |
| Primary (dk2) | #44546A |
| 테이블 헤더 | dk2 배경, lt1 글자 |
| 교대 행 (lt2) | #E7E6E6 |
| 다크 코드 배경 | #1E1E1E (모든 테마 고정) |

---

## 페이지 나누기 규칙

- **표지 → 변경이력**: 자동 (createCoverPage에 포함)
- **변경이력 → 본문**: 2번째 H2 앞에서만 명시적 pageBreak()
- **본문 내 H2 간**: 페이지 나누기 없음 (연속 흐름)
- **이미지 포함 섹션**: H3 파싱 시 look-ahead로 `![` 감지 → 해당 H3 앞에 pageBreak() (중복 break 방지)
- **H4 고아 제목**: INFO로 감지되나 일괄 break 금지 (페이지 폭증). 필요시 특정 H4만 수동 break

---

## 검증 — 자동 수정 원칙

- **WARN만 자동 수정** (이미지 배치, 콘텐츠 누락 등 명확한 문제)
- **SUGGEST** — 컬럼 너비 재분배 등 명확한 개선이면 적용
- **INFO는 수정하지 않음** (시뮬레이션 추정치와 실제 렌더링은 다를 수 있음)
- 수정 후 페이지 수 10% 이상 증가 시 과도한 수정 → 롤백
- **일괄 패턴 매칭 break 삽입 금지** — 특정 위치만 수정

## 셀프리뷰 (필수 게이트 — 생략 금지)

MD 생성/선택 후, 변환 전에 반드시 수행. 이 단계를 완료하기 전에 다음 단계로 진행하지 않는다.
1. `lint-md.py` 자동 린트 (전수 실행)
2. AI 읽기 리뷰 (배치 시 최소 3~5개 샘플)
3. 수정 → 반복될 패턴이면 프로젝트 규칙도 함께 수정

검증 상세: `.claude/rules/validation.md` 참조

---

## 다이어그램 자동 렌더링

MD 내 `<!-- diagram: 설명 -->` 주석이 있는 mermaid/dot 코드블록을 자동 PNG 렌더링.

doc-config: `"diagrams": { "enabled": true, "width": 1024, "scale": 2 }`

- Mermaid + Graphviz 지원, 테마 색상 자동 매핑
- 플로우차트/프로세스/검증 체인은 DOT 권장
- 렌더링 상세: `.claude/rules/diagram.md` 참조

---

## DOCX 텍스트 추출

기존 DOCX → MD 자동 생성 시 사용. ZIP+XML, 의존성 없음.

```bash
python -X utf8 tools/extract-docx.py output/문서.docx --json
```

요소 분류: heading, table, codeBlock(dark/light), infoBox, warningBox, listItem, paragraph (배경색 기반 자동 판별)

---

## 검증된 성공 사례

| 사례 | 위치 | 특징 |
|------|------|------|
| BookStore API 명세서 (Word) | `examples/sample-api/` | REST API, JSON 코드블록, 인증 흐름 |
| 주문처리 배치 규격서 (Word) | `examples/sample-batch/` | 고정길이 전문, S/D/E 레코드, SFTP |
| 공통 코드 정의서 (Excel) | `examples/sample-code-def/` | H2 시트 분할, 표지, 교대행, 자동 필터 |

---

## 고도화 로드맵

- **Phase 1** (완료): DOCX 워크플로우 — professional 템플릿, 검증, 이미지, 페이지 나누기
- **Phase 2** (완료): 자가 개선 루프 — Generic Converter + doc-config + 검증 피드백
- **Phase 2.5** (완료): 고도화 — 회귀 테스트, 패턴 DB, Reflexion, 조기 종료, 품질 점수
- **Phase 3** (진행): 포맷 확장 — XLSX 완료, PPTX/PDF 미완
- **Phase 4** (진행): 자동화 — 다이어그램 완료, 배치/변경감지 미완

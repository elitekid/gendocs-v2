---
globs:
  - "lib/converter-xlsx.js"
  - "lib/xlsx-utils.js"
  - "templates/xlsx/**"
  - "tools/validate-xlsx.js"
---

# XLSX 변환 상세

## 변환 엔진 (`lib/converter-xlsx.js`)

- `converter-core.js`의 유틸리티 재사용 (parseTable, resolveTheme 등)
- H2 기준 시트 분할 (`sheetMapping: "h2"`)
- `sheetMapping: "single"` -> 전체 1시트, `"table"` -> 테이블마다 시트, `"custom"` -> `xlsx.sheets[]`
- `xlsx.sheets[]` -- AI가 설계한 커스텀 시트 구조 (KPI 카드, 합계 행, 컬럼 타입 등)
- `tableWidths` 값은 Excel 문자 폭 단위 (DOCX의 DXA와 다름)

## XLSX 유틸리티 (`lib/xlsx-utils.js`)

- `parseInlineMarkdown(text, opts)` -- `**bold**`, `` `code` `` -> ExcelJS richText 배열
- `applySemanticColor(cell, value, customMap)` -- 성공/실패/경고/진행 중 -> 배경+글자 색상
- `convertCellValue(value, type)` -- number/percentage/date/formula/text 타입 변환
- `colLetter(idx)` -- 0-based -> A, B, ..., AA
- `resolveFormula(template, headers, col, row, summaryRow)` -- `{컬럼명}` -> 셀 참조 변환

## Excel 템플릿

### data-spec.js (표지 포함)

공개 API: `createWorkbook`, `saveWorkbook`, `addSheet`, `addCoverSheet`, `writeTitle`, `writeText`, `writeBullet`, `writeInfoBox`, `writeWarningBox`, `writeTable`, `writeSummaryRow`, `writeKpiCard`, `writeMergedHeader`, `writeCodeBlock`, `applyAutoFilter`, `freezeHeaderRow`, `setColumnWidths`

특징: 테마 색상 헤더, 교대행 배경, 자동 필터, 행 고정, A4 가로/세로 인쇄 설정

### basic.js (표지 없음)

data-spec과 동일 API, `addCoverSheet`는 no-op. 간단한 데이터 목록, 빠른 내보내기용.

## XLSX doc-config 커스텀 sheets[] 구조

```json
{
  "xlsx": {
    "sheetMapping": "custom",
    "semanticColors": true,
    "sheets": [
      {
        "name": "대시보드",
        "source": "## 현황",
        "sections": [
          { "type": "kpi-cards", "cards": [{ "title": "총 건수", "valueFrom": "총 건수|값", "color": "primary" }] },
          { "type": "table", "columnDefs": { "건수": { "type": "number", "summary": "sum" } }, "summaryRow": true }
        ]
      }
    ]
  }
}
```

- `columnDefs.{col}.type`: `number`, `percentage`, `date`, `status`, `code`, `text` (기본)
- `columnDefs.{col}.summary`: `sum`, `average`, `count`, `min`, `max`
- `sheets[].sections[].type`: `table`, `kpi-cards`, `title`, `text`, `merged-header`

## 검증 (`tools/validate-xlsx.js`)

```bash
node tools/validate-xlsx.js output/문서.xlsx --json
```

시트/테이블/헤더 분석, JSON 출력 지원.

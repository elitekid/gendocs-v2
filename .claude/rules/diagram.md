---
globs:
  - "lib/diagram-renderer.js"
---

# 다이어그램 렌더링 상세

## 지원 렌더러

| 렌더러 | 언어 태그 | 엔진 | 다이어그램 유형 |
|--------|-----------|------|----------------|
| Mermaid | `mermaid` | `@mermaid-js/mermaid-cli` (mmdc) | 시퀀스, 플로우차트, 상태, ER, 파이, 간트, 클래스 |
| Graphviz | `dot`, `graphviz` | `@hpcc-js/wasm-graphviz` + puppeteer(SVG->PNG) | 아키텍처, 네트워크, 의존성 그래프 |

## 테마 색상 매핑

doc-config의 `theme`이 다이어그램 색상에 자동 매핑.

- **Mermaid**: `buildMermaidConfig()` -> themeVariables JSON config -> `mmdc -c`
- **Graphviz**: `injectGraphvizTheme()` -> DOT 소스에 node/edge 속성 주입

## 다색 배색 (3가지 다이어그램 유형)

### sequenceDiagram
SVG 후처리로 참여자별 개별 색상 (mmdc->SVG->`_recolorSequenceParticipants()`->`svgToPng()`->PNG).
- 참여자 순서: 소스 코드 participant 선언에서 추출 (`_extractSequenceParticipants()`)
- 색상 생성: accent 슬롯에서 중간~진한 톤 (lightness 0.28~0.42, 흰색 텍스트 가독성)
- SVG actor rect에 inline style로 fill/stroke 설정
- 사용자 `box` 구문이 있으면 SVG 후처리 스킵

### stateDiagram
의미론적 색상 (`_classifyState()` 키워드 매칭):
- SUCCESS -> 녹색, FAILURE -> 코랄, WARNING -> 피치, NEUTRAL -> 테마 primary
- ASCII 상태명: `class` 구문, 한국어 상태명: `:::className` 인라인 구문

### flowchart
`classDef` + `class` 구문 자동 주입 (3색 교대)

## Graphviz 색상 치환

`hasUserColors` 시 전면 스킵 대신, 하드코딩 fillcolor를 색상 가족 감지 -> 테마 대응색 치환:
- 파랑 계열 -> info, 핑크/빨강 -> error, 노랑 -> warning, 녹색 -> success
- `_mapToThemeColor()` 임계값: `l > 0.65`
- 폰트/엣지 스타일은 항상 주입

## Graphviz DOT 플로우차트 스타일 가이드

플로우차트/프로세스/검증 체인은 Mermaid 대신 DOT 권장.

**자동 주입 기본값** (`injectGraphvizTheme`):

| 속성 | 기본값 | 효과 | 스킵 조건 |
|------|--------|------|-----------|
| `splines` | `ortho` | 직각 연결선 | 사용자 지정 시 |
| `style` | `"rounded,filled"` | 둥근 모서리 박스 | 사용자 지정 시 |
| `margin` | `"0.12,0.08"` | 콤팩트한 노드 패딩 | 사용자 지정 시 |
| `penwidth` (node/edge) | `1.2` | 얇은 테두리/연결선 | 사용자 지정 시 |
| `size` | orientation 기반 (`9,5` / `5,7`) | 레이아웃 크기 | 사용자 지정 시 |
| `ratio` | `compress` | 압축 비율 | 사용자 지정 시 |

**색상 컨벤션** (테마 자동 치환):

| 역할 | fillcolor | fontcolor | 비고 |
|------|-----------|-----------|------|
| 시작/종료 | colors.primary(dk2) | white | 진한색 -> 치환 안 됨 |
| 검증/판단 | 연한 파랑 (#E8EEF4 등) | 진한색 | -> 테마 info로 치환 |
| 실패/에러 | 연한 빨강 (#F5E8E8 등) | 빨강 | -> 테마 error로 치환 |
| 성공 | 연한 초록 (#D6FFD6 등) | 진한색 | -> 테마 success로 치환 |

**엣지 컨벤션**: 정상 `penwidth=2`, 실패 `style=dashed, color="<빨강>"`

## CJK 폰트 폭 보정

WASM Graphviz에 CJK 폰트 메트릭 없음:
- `CJK_FACTOR=1.2`: fontsize만 1.2배 팽창(레이아웃용) -> SVG에서 원래 크기 복원
- **Courier 치환 금지** -- 모노스페이스 폭 과대로 박스가 넓어짐

## svgToPng 개선

- `<svg>` 태그에서만 width/height 추출 (자식 요소 혼동 방지)
- viewBox fallback (Mermaid SVG `width="100%"` 대응)
- LR 다이어그램 등 5:1 초과 시 세로 패딩 추가
- puppeteer 브라우저 정리: processDiagrams() 종료 시 자동 close

## 하위 호환

- `<!-- diagram: -->` 주석이 없는 코드블록 -> 일반 코드블록으로 변환
- `diagrams.enabled: false` -> 렌더링 스킵
- `diagrams.theme` 명시 시 -> Mermaid 기본 테마 사용 (gendocs 테마 매핑 비활성)

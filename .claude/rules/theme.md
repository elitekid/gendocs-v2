---
globs:
  - "lib/theme-utils.js"
  - "themes/**"
  - "templates/**"
---

# 테마 시스템 상세

## 테마 JSON 구조 (v2)

```json
{
  "name": "office-standard",
  "displayName": "Office Standard",
  "version": 2,
  "slots": {
    "dk1": "000000", "lt1": "FFFFFF",
    "dk2": "44546A", "lt2": "E7E6E6",
    "accent1": "4472C4", "accent2": "ED7D31",
    "accent3": "A5A5A5", "accent4": "FFC000",
    "accent5": "5B9BD5", "accent6": "70AD47",
    "hlink": "0563C1", "folHlink": "954F72"
  },
  "fonts": { "default": "Malgun Gothic", "code": "Consolas" },
  "sizes": { ... },
  "syntax": { ... },
  "overrides": {}
}
```

- `slots` — Word 12슬롯이 색상의 소스 오브 트루스
- `overrides` — 파생 결과를 부분적으로 덮어쓸 수 있음 (예: `codeDarkBg` 고정)
- `version: 2` — v1(기존 `colors` 30키)과 구분

## 12슬롯 -> 30키 파생 매핑

| 파생 키 | 소스 | 변환 |
|---------|------|------|
| primary | dk2 | 직접 |
| secondary | accent1 | 직접 |
| accent | accent2 | 직접 |
| text | dk1 | 직접 |
| white | lt1 | 직접 |
| altRow | lt2 | 직접 |
| textLight | dk1 | tint 50% |
| border | dk2 | tint 70% |
| infoBox | dk2 | tint 85% |
| warningBox | accent2 | tint 88% |
| codeDarkBg | -- | 고정 1E1E1E |
| codeDarkBorder | -- | 고정 3C3C3C |

핵심 함수: `lib/theme-utils.js`의 `deriveColors(slots, overrides)`

## 프리셋 테마 (5종, Office 표준 팔레트)

| 파일 | 이름 | dk2 (primary) | 용도 |
|------|------|---------------|------|
| `themes/office-standard.json` | Office Standard | #44546A | 기본 (가장 보편적) |
| `themes/office-modern.json` | Office Modern | #0E2841 | 최신 트렌드 |
| `themes/blue-warm.json` | Blue Warm | #242852 | 로열블루, 격식 |
| `themes/blue-green.json` | Blue Green | #373545 | 틸, 기업용 |
| `themes/marquee.json` | Marquee | #5E5E5E | 스틸블루, 모던 |

## 기존 테마명 호환 (THEME_ALIASES)

- `navy-professional` -> `office-standard`
- `blue-standard` -> `office-modern`
- `teal-corporate` -> `blue-green`
- `slate-modern` -> `marquee`
- `wine-elegant` -> `blue-warm`

## 기술 구현

- `lib/theme-utils.js` — tint/shade, 12->30 파생, v1 마이그레이션 (순수 함수 모듈)
- 템플릿(`professional.js`, `basic.js`)은 **factory function 패턴**: `module.exports = createTemplate`
- `converter-core.js`의 `resolveTheme()` -> v2 감지 -> `deriveColors()` -> style 오버라이드 머지
- `converter-core.js`의 `THEME_ALIASES` -> 기존 테마명 자동 매핑
- `loadTemplate(templateName, themeConfig)` -> factory 호출
- 검증 도구 -> `tools/theme_colors.py`에서 동적으로 테마 색상 세트 로드

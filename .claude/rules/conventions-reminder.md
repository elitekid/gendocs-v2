# Compact 후 필수 리마인드

- 소스 MD에 없는 내용 추가·확장 금지 (콘텐츠 범위 준수)
- 유사 파일명 여러 개 시 편집 전 사용자에게 정확한 경로 확인
- WARN만 자동 수정, INFO는 수정 금지 (일괄 break 삽입 금지)
- 셀프리뷰(lint-md + AI 리뷰) 완료 전 변환 단계 진행 금지
- 템플릿 수정 금지 — doc-config만 새로 작성
- 수정 후 페이지 수 10%↑ 시 롤백
- 세부 규칙: `.claude/rules/` 참조 (theme, validation, diagram, xlsx)

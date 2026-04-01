#!/bin/bash
# PostToolUse(Write/Edit): lib/ 또는 templates/ 수정 시 회귀 테스트 리마인드
JQ="/c/Users/USER/AppData/Local/Microsoft/WinGet/Packages/jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe"
INPUT=$(cat)
FILE=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // ""')

# lib/*.js 또는 templates/**/*.js 파일만 대상
if ! echo "$FILE" | grep -qE '(lib/[^/]+\.js|templates/.+\.js)$'; then
  exit 0
fi

# doc-configs, patterns.json, reflections.json 등은 제외
if echo "$FILE" | grep -qE '(patterns\.json|reflections\.json|scoring\.js)$'; then
  exit 0
fi

BASENAME=$(basename "$FILE")
echo "[test] ${BASENAME} 수정됨 — 작업 완료 후 테스트 필요: npm test"

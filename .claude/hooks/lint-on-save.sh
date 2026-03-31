#!/bin/bash
# PostToolUse: source/*.md 저장 시 자동 lint
JQ="/c/Users/USER/AppData/Local/Microsoft/WinGet/Packages/jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe"
INPUT=$(cat)
FILE=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // ""')

# source/*.md 파일만 대상
if ! echo "$FILE" | grep -qE 'source/.*\.md$'; then
  exit 0
fi

# 파일 존재 확인
if [ ! -f "$FILE" ]; then
  exit 0
fi

# lint 실행
cd "$CLAUDE_PROJECT_DIR"
RESULT=$(python -X utf8 tools/lint-md.py "$FILE" --json 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

CRITICAL=$(echo "$RESULT" | "$JQ" -r '[.issues[] | select(.severity == "CRITICAL")] | length')
WARN=$(echo "$RESULT" | "$JQ" -r '[.issues[] | select(.severity == "WARN")] | length')

if [ "$CRITICAL" -gt 0 ]; then
  echo "[auto-lint] CRITICAL ${CRITICAL}건 발견 — 변환 전 반드시 수정 필요"
  echo "$RESULT" | "$JQ" -r '.issues[] | select(.severity == "CRITICAL") | "  - \(.check): \(.message)"'
elif [ "$WARN" -gt 0 ]; then
  echo "[auto-lint] WARN ${WARN}건 — 변환 전 검토 권장"
  echo "$RESULT" | "$JQ" -r '.issues[] | select(.severity == "WARN") | "  - \(.check): \(.message)"'
fi

#!/bin/bash
# PostToolUse(Write/Edit): doc-configs/*.json 저장 시 필수 필드 검증
JQ="/c/Users/USER/AppData/Local/Microsoft/WinGet/Packages/jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe"
INPUT=$(cat)
FILE=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // ""')

# doc-configs/*.json 파일만 대상
if ! echo "$FILE" | grep -qE 'doc-configs/.*\.json$'; then
  exit 0
fi

if [ ! -f "$FILE" ]; then
  exit 0
fi

ERRORS=""

# 필수 필드 검증
SOURCE=$(cat "$FILE" | "$JQ" -r '.source // empty')
OUTPUT_PATH=$(cat "$FILE" | "$JQ" -r '.output // empty')
TITLE=$(cat "$FILE" | "$JQ" -r '.docInfo.title // empty')

if [ -z "$SOURCE" ]; then
  ERRORS="${ERRORS}\n  - source 필드 누락"
fi
if [ -z "$OUTPUT_PATH" ]; then
  ERRORS="${ERRORS}\n  - output 필드 누락"
fi
if [ -z "$TITLE" ]; then
  ERRORS="${ERRORS}\n  - docInfo.title 누락"
fi

# source 파일 존재 확인
if [ -n "$SOURCE" ]; then
  cd "$CLAUDE_PROJECT_DIR"
  if [ ! -f "$SOURCE" ]; then
    ERRORS="${ERRORS}\n  - source 파일 없음: ${SOURCE}"
  fi
fi

if [ -n "$ERRORS" ]; then
  echo -e "[doc-config] 검증 실패:${ERRORS}"
fi

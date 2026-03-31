#!/bin/bash
# PostToolUse(Bash): node lib/convert.js 실행 후 --validate 누락 시 알림
JQ="/c/Users/USER/AppData/Local/Microsoft/WinGet/Packages/jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe"
INPUT=$(cat)
CMD=$(echo "$INPUT" | "$JQ" -r '.tool_input.command // ""')

# convert.js 실행인지 확인
if ! echo "$CMD" | grep -qE 'node\s+lib/convert\.js|npm\s+run\s+convert'; then
  exit 0
fi

# --validate 이미 포함이면 스킵
if echo "$CMD" | grep -q '\-\-validate'; then
  exit 0
fi

# 변환 성공 여부 확인 (exit code는 tool_output에 반영)
OUTPUT=$(echo "$INPUT" | "$JQ" -r '.tool_output // ""')
if echo "$OUTPUT" | grep -qiE 'error|failed|ENOENT'; then
  exit 0
fi

echo "[auto-validate] 변환 완료했으나 --validate 없이 실행됨. 검증을 실행하세요."
echo "  다음부터: node lib/convert.js <config> --validate"

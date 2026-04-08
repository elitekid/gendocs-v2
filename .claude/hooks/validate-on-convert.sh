#!/bin/bash
# PostToolUse(Bash): convert.js 실행 후 생성된 DOCX를 자동 검증
# - extract-docx.py로 테이블 구조 추출
# - DOCX XML에서 tblLayout, gridCol 등 렌더링 속성 확인
JQ="/c/Users/USER/AppData/Local/Microsoft/WinGet/Packages/jqlang.jq_Microsoft.Winget.Source_8wekyb3d8bbwe/jq.exe"
INPUT=$(cat)
CMD=$(echo "$INPUT" | "$JQ" -r '.tool_input.command // ""')

# convert.js 실행인지 확인
if ! echo "$CMD" | grep -qE 'node\s+lib/convert\.js|npm\s+run\s+convert'; then
  exit 0
fi

# 변환 실패 시 스킵
TOOL_RESP=$(echo "$INPUT" | "$JQ" -r '.tool_response // ""')
if echo "$TOOL_RESP" | grep -qiE 'error|failed|ENOENT'; then
  exit 0
fi

# 출력 DOCX 경로 추출 (Document saved: <path>)
DOCX_PATH=$(echo "$TOOL_RESP" | sed -n 's/.*Document saved: \(.*\.docx\).*/\1/p' | head -1)
if [ -z "$DOCX_PATH" ]; then
  # fallback: tool_response에서 .docx 경로 찾기
  DOCX_PATH=$(echo "$TOOL_RESP" | grep -oE '[^ ]+\.docx' | head -1)
fi

if [ -z "$DOCX_PATH" ] || [ ! -f "$DOCX_PATH" ]; then
  exit 0
fi

# DOCX 자동 검증 실행
RESULT=$(python -X utf8 -c "
import zipfile, re, json, sys

docx_path = sys.argv[1]
issues = []
info = []

# 1. XML에서 테이블 속성 검증
try:
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read('word/document.xml').decode('utf-8')

    # tblLayout 확인
    tables_count = len(re.findall(r'<w:tbl[ >]', xml))
    fixed_count = len(re.findall(r'w:tblLayout w:type=\"fixed\"', xml))
    if tables_count > 0 and fixed_count == 0:
        issues.append(f'WARN: {tables_count}개 테이블 중 tblLayout=fixed 없음 (Word가 컬럼 너비 무시)')
    elif fixed_count < tables_count:
        issues.append(f'WARN: {tables_count}개 테이블 중 {fixed_count}개만 fixed ({tables_count - fixed_count}개 autofit)')

    # gridCol 균등 분배 감지
    grids = re.findall(r'<w:tblGrid>(.*?)</w:tblGrid>', xml, re.DOTALL)
    uniform_tables = 0
    for g in grids:
        cols = re.findall(r'w:w=\"(\d+)\"', g)
        if len(cols) >= 2 and len(set(cols)) == 1:
            uniform_tables += 1
    if uniform_tables > 0:
        issues.append(f'WARN: {uniform_tables}개 테이블 컬럼 너비 균등분배 (원본과 다를 수 있음)')

    info.append(f'테이블 {tables_count}개, fixed={fixed_count}')

except Exception as e:
    issues.append(f'ERROR: DOCX XML 검증 실패: {e}')

# 결과 출력
output = {}
if issues:
    msg = '[DOCX 자동검증] ' + docx_path + '\n'
    for iss in issues:
        msg += '  ' + iss + '\n'
    for inf in info:
        msg += '  ' + inf + '\n'
    msg += '  → 반드시 Word에서 열어 테이블 레이아웃을 육안 확인하세요.'
    output['hookSpecificOutput'] = {
        'hookEventName': 'PostToolUse',
        'additionalContext': msg
    }
else:
    msg = '[DOCX 자동검증] ' + docx_path + ' — '
    msg += ', '.join(info) + ' (이상 없음)'
    output['hookSpecificOutput'] = {
        'hookEventName': 'PostToolUse',
        'additionalContext': msg
    }

print(json.dumps(output, ensure_ascii=False))
" "$DOCX_PATH" 2>/dev/null)

if [ -n "$RESULT" ]; then
  echo "$RESULT"
fi

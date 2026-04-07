/**
 * lib/fix/fix-rules.js — suggestion 기반 doc-config 자동 수정
 *
 * suggestion 필드가 있는 WARN만 자동 수정. 나머지는 Claude Code 수동.
 * doc-config JSON 파일을 직접 수정하고 저장하여 다음 실행에서 IR에 반영.
 */
'use strict';

const fs = require('fs');

/**
 * suggestion 있는 WARN에 대해 doc-config를 자동 수정
 * @param {string} configPath - doc-config 파일 경로
 * @param {Object} config - 현재 config (in-memory)
 * @param {Array} fixableWarns - suggestion 있는 WARN 배열
 * @returns {{ applied: FixEntry[], config: Object }}
 */
function apply(configPath, config, fixableWarns) {
  const applied = [];

  for (const warn of fixableWarns) {
    if (!warn.suggestion) continue;
    const code = warn.code || warn.type;

    switch (code) {
      case 'WIDTH_IMBALANCE': {
        // suggestion.recommended = [너비 배열], suggestion.headers = "헤더1|헤더2|..."
        const headers = warn.suggestion.headers;
        const recommended = warn.suggestion.recommended;
        if (headers && recommended) {
          if (!config.tableWidths) config.tableWidths = {};
          const before = config.tableWidths[headers];
          config.tableWidths[headers] = recommended;
          applied.push({
            code,
            field: `tableWidths["${headers}"]`,
            before: before || null,
            after: recommended,
          });
        }
        break;
      }

      case 'NARROW_IMAGE':
      case 'FLAT_IMAGE': {
        // suggestion.width = 권장 너비
        if (warn.suggestion.width) {
          if (!config.diagrams) config.diagrams = {};
          const before = config.diagrams.width;
          config.diagrams.width = warn.suggestion.width;
          applied.push({
            code,
            field: 'diagrams.width',
            before: before || null,
            after: warn.suggestion.width,
          });
        }
        break;
      }

      default:
        // 알 수 없는 code의 suggestion은 무시
        break;
    }
  }

  // doc-config 파일 저장
  if (applied.length > 0 && configPath) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  return { applied, config };
}

/**
 * WARN 배열에서 suggestion이 있는 것만 필터
 */
function filterFixable(warns) {
  return warns.filter(w => w.suggestion && w.severity === 'WARN');
}

module.exports = { apply, filterFixable };

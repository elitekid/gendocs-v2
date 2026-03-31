/**
 * xlsx-utils.js — XLSX 공유 유틸리티
 *
 * Rich Text 파서, 의미론적 색상, 셀 값 타입 변환.
 * templates/xlsx/*.js 와 converter-xlsx.js 에서 공유.
 */

// ============================================================
// (a) Rich Text 파서
// ============================================================

/**
 * 마크다운 인라인 서식을 ExcelJS richText 배열로 변환
 *
 * 지원: **bold**, `code`, *italic*, ~~strike~~, [link](url)
 * 서식 없으면 plain string 반환 (ExcelJS 호환).
 *
 * @param {string} text - 원본 텍스트
 * @param {Object} [opts]
 * @param {string} [opts.defaultFont] - 기본 폰트 (default: 'Malgun Gothic')
 * @param {string} [opts.codeFont] - 코드 폰트 (default: 'Consolas')
 * @param {number} [opts.fontSize] - 기본 크기 (default: 10)
 * @param {Object} [opts.colors] - { text, code } ARGB 없이 6자리 hex
 * @returns {string | {richText: Array<{text: string, font: Object}>}}
 */
function parseInlineMarkdown(text, opts = {}) {
  if (!text) return '';

  const defaultFont = opts.defaultFont || 'Malgun Gothic';
  const codeFont = opts.codeFont || 'Consolas';
  const fontSize = opts.fontSize || 10;
  const textColor = (opts.colors && opts.colors.text) || '333333';

  // 서식 마커가 없으면 plain string 반환
  if (!/(\*\*|`|\*(?!\*)|~~|\[.*?\]\(.*?\))/.test(text)) {
    return text;
  }

  const parts = [];
  // 토큰화: **bold**, `code`, *italic*, ~~strike~~, [link](url), plain
  const regex = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(~~([^~]+)~~)|(\[([^\]]+)\]\(([^)]+)\))/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // match 이전의 plain text
    if (match.index > lastIndex) {
      parts.push({
        text: text.substring(lastIndex, match.index),
        font: { name: defaultFont, size: fontSize, color: { argb: 'FF' + textColor } },
      });
    }

    if (match[1]) {
      // **bold**
      parts.push({
        text: match[2],
        font: { name: defaultFont, size: fontSize, bold: true, color: { argb: 'FF' + textColor } },
      });
    } else if (match[3]) {
      // `code`
      parts.push({
        text: match[4],
        font: { name: codeFont, size: fontSize, color: { argb: 'FF' + textColor } },
      });
    } else if (match[5]) {
      // *italic*
      parts.push({
        text: match[6],
        font: { name: defaultFont, size: fontSize, italic: true, color: { argb: 'FF' + textColor } },
      });
    } else if (match[7]) {
      // ~~strike~~
      parts.push({
        text: match[8],
        font: { name: defaultFont, size: fontSize, strike: true, color: { argb: 'FF' + textColor } },
      });
    } else if (match[9]) {
      // [link](url) — 텍스트만 표시
      parts.push({
        text: match[10],
        font: { name: defaultFont, size: fontSize, color: { argb: 'FF0563C1' }, underline: true },
      });
    }

    lastIndex = regex.lastIndex;
  }

  // 남은 plain text
  if (lastIndex < text.length) {
    parts.push({
      text: text.substring(lastIndex),
      font: { name: defaultFont, size: fontSize, color: { argb: 'FF' + textColor } },
    });
  }

  if (parts.length === 0) return text;
  if (parts.length === 1 && !parts[0].font.bold && !parts[0].font.italic &&
      !parts[0].font.strike && !parts[0].font.underline &&
      parts[0].font.name === defaultFont) {
    return parts[0].text;
  }

  return { richText: parts };
}

// ============================================================
// (b) 의미론적 색상
// ============================================================

/** 기본 의미론적 색상 매핑 */
const DEFAULT_SEMANTIC_COLORS = {
  success: {
    keywords: ['성공', '완료', 'OK', '✅', 'PASS', 'Active', '정상', '활성', 'Y', 'true'],
    bg: 'E2EFDA',
    fg: '375623',
  },
  error: {
    keywords: ['실패', '오류', 'ERROR', '❌', 'FAIL', '에러', '중단', '비활성', '폐기', 'N', 'false'],
    bg: 'FCE4EC',
    fg: 'C62828',
  },
  warning: {
    keywords: ['경고', '대기', '⚠️', '⚠', 'WARNING', '보류', '주의', '만료'],
    bg: 'FFF3E0',
    fg: 'E65100',
  },
  info: {
    keywords: ['처리 중', '진행', '검토', '접수', 'Pending', '예정'],
    bg: 'E3F2FD',
    fg: '1565C0',
  },
};

/**
 * 셀 값을 분석하여 의미론적 배경/글자 색상을 적용
 *
 * @param {Object} cell - ExcelJS Cell 객체
 * @param {string} value - 셀 텍스트 값
 * @param {Object} [customMap] - 커스텀 색상 매핑 (DEFAULT와 병합)
 * @returns {boolean} 색상이 적용되었으면 true
 */
function applySemanticColor(cell, value, customMap) {
  if (!value || typeof value !== 'string') return false;

  const map = customMap
    ? mergeSemanticMaps(DEFAULT_SEMANTIC_COLORS, customMap)
    : DEFAULT_SEMANTIC_COLORS;

  const trimmed = value.trim();

  for (const [, def] of Object.entries(map)) {
    const matched = def.keywords.some(kw => {
      // 정확 일치 (짧은 키워드) 또는 포함 일치 (긴 키워드)
      if (kw.length <= 2) return trimmed === kw;
      return trimmed.includes(kw);
    });

    if (matched) {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF' + def.bg },
      };
      // 기존 font 속성 유지하면서 color만 변경
      const existingFont = cell.font || {};
      cell.font = { ...existingFont, color: { argb: 'FF' + def.fg } };
      return true;
    }
  }
  return false;
}

/**
 * 커스텀 맵을 기본 맵과 병합
 */
function mergeSemanticMaps(base, custom) {
  const merged = {};
  for (const [key, def] of Object.entries(base)) {
    merged[key] = { ...def };
  }
  for (const [key, def] of Object.entries(custom)) {
    if (merged[key]) {
      merged[key] = {
        keywords: [...(merged[key].keywords || []), ...(def.keywords || [])],
        bg: def.bg || merged[key].bg,
        fg: def.fg || merged[key].fg,
      };
    } else {
      merged[key] = def;
    }
  }
  return merged;
}

// ============================================================
// (c) 셀 값 타입 변환
// ============================================================

/**
 * 문자열 값을 지정된 타입으로 변환
 *
 * @param {string} value - 원시 문자열
 * @param {string} type - 'number' | 'percentage' | 'date' | 'formula' | 'text' | 'status' | 'code'
 * @returns {{ value: any, numFmt?: string }} 변환된 값 + 선택적 서식
 */
function convertCellValue(value, type) {
  if (!value && value !== 0) return { value: '' };
  const str = String(value).trim();

  switch (type) {
    case 'number': {
      const num = Number(str.replace(/,/g, ''));
      if (isNaN(num)) return { value: str };
      return { value: num, numFmt: '#,##0' };
    }
    case 'percentage': {
      // "85%" → 0.85 또는 "0.85" → 0.85
      let num;
      if (str.endsWith('%')) {
        num = Number(str.replace(/%$/, '').replace(/,/g, '')) / 100;
      } else {
        num = Number(str.replace(/,/g, ''));
        if (num > 1) num = num / 100; // 85 → 0.85
      }
      if (isNaN(num)) return { value: str };
      return { value: num, numFmt: '0.0%' };
    }
    case 'date': {
      const d = new Date(str);
      if (isNaN(d.getTime())) return { value: str };
      return { value: d, numFmt: 'YYYY-MM-DD' };
    }
    case 'formula': {
      if (str.startsWith('=')) {
        return { value: { formula: str.substring(1) } };
      }
      return { value: { formula: str } };
    }
    case 'status':
    case 'code':
    case 'text':
    default:
      return { value: str };
  }
}

/**
 * Excel 컬럼 레터 변환 (0-based index → A, B, ..., Z, AA, ...)
 * @param {number} idx - 0-based 컬럼 인덱스
 * @returns {string}
 */
function colLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/**
 * 수식 템플릿을 실제 Excel 수식으로 변환
 *
 * 예: "{col}/{합계}" + headers=["항목","발생 건수","비율"] + col="비율" + dataStartRow=3 + dataEndRow=10
 * → "=B3/B$10" (같은 행의 "발생 건수" / 합계행의 "발생 건수")
 *
 * @param {string} template - 수식 템플릿
 * @param {string[]} headers - 테이블 헤더
 * @param {string} currentCol - 현재 컬럼명
 * @param {number} currentRow - 현재 행 번호 (1-based)
 * @param {number} summaryRow - 합계 행 번호
 * @returns {string} Excel 수식 (= 없이)
 */
function resolveFormula(template, headers, currentCol, currentRow, summaryRow) {
  let formula = template;

  // {col} → 현재 컬럼의 같은 행 참조는 의미 없으므로, 보통 다른 컬럼 참조
  // {컬럼명} → 해당 컬럼의 같은 행 셀 참조
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim();
    const cl = colLetter(i);
    formula = formula.replace(new RegExp(`\\{${escapeRegex(h)}\\}`, 'g'), `${cl}${currentRow}`);
  }

  // {합계} → 합계 행의 같은 컬럼 참조 (절대 행)
  const currentColIdx = headers.findIndex(h => h.trim() === currentCol.trim());
  if (currentColIdx >= 0) {
    const cl = colLetter(currentColIdx);
    formula = formula.replace(/\{합계\}/g, `${cl}$${summaryRow}`);
  }

  // {col} fallback → 현재 컬럼의 같은 행
  if (currentColIdx >= 0) {
    const cl = colLetter(currentColIdx);
    formula = formula.replace(/\{col\}/g, `${cl}${currentRow}`);
  }

  return formula;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  parseInlineMarkdown,
  applySemanticColor,
  convertCellValue,
  colLetter,
  resolveFormula,
  DEFAULT_SEMANTIC_COLORS,
};

/**
 * lib/parsers/parse-utils.js — 파싱 유틸리티 (converter-core.js에서 추출)
 *
 * MD 파싱에 필요한 순수 유틸 함수 모음.
 * Phase 4에서 converter-core.js → parse-utils.js로 이동.
 * converter-core.js는 하위 호환을 위해 re-export.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// 테이블 파싱
// ============================================================

/**
 * 마크다운 테이블 라인 배열을 2D 배열로 파싱
 * @param {string[]} lines - 테이블 라인들
 * @returns {string[][]} - [headers, ...rows]
 */
function parseTable(lines) {
  const rows = [];
  for (const line of lines) {
    const isSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(line) &&
                        line.includes('-') &&
                        !line.match(/[a-zA-Z0-9가-힣]/);

    if (line.includes('|') && !isSeparator) {
      const trimmed = line.trim();
      const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
      const inner2 = inner.endsWith('|') ? inner.slice(0, -1) : inner;
      const cells = inner2.split('|').map(c => c.trim());
      if (cells.length > 0) rows.push(cells);
    }
  }
  return rows;
}

// ============================================================
// 이미지 유틸
// ============================================================

/**
 * 이미지 look-ahead: 현재 위치 이후에 이미지 마크다운이 있는지 확인
 */
function lookAheadForImage(lines, startIdx, baseDir) {
  for (let j = startIdx; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.startsWith('#')) return false;
    if (l.match(/^!\[/)) {
      if (baseDir) {
        const m = l.match(/!\[.*?\]\(([^)]+)\)/);
        if (m) {
          const imgPath = m[1].split('?')[0];
          if (fs.existsSync(path.resolve(baseDir, imgPath))) return true;
        }
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * PNG 파일에서 실제 크기를 읽어 DOCX에 맞게 비례 축소
 */
function getImageDimensions(imagePath, maxWidthPt = 780, maxHeightPt = 500) {
  try {
    const buf = fs.readFileSync(imagePath);
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      const pxWidth = buf.readUInt32BE(16);
      const pxHeight = buf.readUInt32BE(20);
      if (pxWidth > 0 && pxHeight > 0) {
        let targetWidth = Math.min(maxWidthPt, 780);
        const ratio = pxHeight / pxWidth;
        let targetHeight = Math.floor(targetWidth * ratio);
        if (targetHeight > maxHeightPt) {
          targetHeight = maxHeightPt;
          targetWidth = Math.floor(targetHeight / ratio);
        }
        return { width: targetWidth, height: targetHeight };
      }
    }
  } catch (_) {}
  return { width: Math.min(maxWidthPt, 780), height: 400 };
}

// ============================================================
// 테이블 너비 계산
// ============================================================

/**
 * 가중치 기반 테이블 너비 계산 (fallback)
 */
function defaultTableWidths(headers, totalWidth = 12960) {
  const smallHeaders = ['No', '코드', '필수', '길이', '타입', 'MTI', '값', '버전', '시작', '결과', '단계'];
  const mediumHeaders = ['날짜', '작성자', '호출 주체', 'Processing Code', '변경 내용', '참조 섹션',
                         'QR 유형', '판별 조건', '처리 방식', '결제 완료 시점', '사용 지역',
                         'Tag 01 값', '금액(Tag 54)', '금액 입력', 'trxStatus', '비고',
                         'origTxnId', 'origData', '구분', '조건', '방향', '주체', '패턴'];
  const largeHeaders = ['설명', '내용', '용도', '엔드포인트', '필드', 'API명', '항목', '규격',
                        '요건', '동작', '처리', '검증', '권한'];

  const weights = headers.map(h => {
    const header = h.trim();
    if (smallHeaders.some(s => header.includes(s))) return 1;
    if (mediumHeaders.some(m => header.includes(m))) return 2;
    if (largeHeaders.some(l => header.includes(l))) return 4;
    return 2;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(w => Math.floor((w / totalWeight) * totalWidth));
  const diff = totalWidth - widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += diff;
  return widths;
}

/**
 * patterns.json 로드 (캐시)
 */
let _patternsCache = null;
function loadPatterns() {
  if (_patternsCache !== undefined && _patternsCache !== null) return _patternsCache;
  // patterns.json은 lib/ 디렉토리에 위치
  const patternsPath = path.join(__dirname, '..', 'patterns.json');
  if (fs.existsSync(patternsPath)) {
    try {
      _patternsCache = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
    } catch {
      _patternsCache = null;
    }
  } else {
    _patternsCache = null;
  }
  return _patternsCache;
}

/**
 * 패턴 매칭 헬퍼
 */
function matchPattern(headerStr, headerCount, widthsMap) {
  for (const [pattern, widths] of Object.entries(widthsMap)) {
    const keywords = pattern.split('|').map(k => k.trim());
    const allMatch = keywords.every(k => headerStr.includes(k));
    if (allMatch && widths.length === headerCount) {
      return widths;
    }
  }
  return null;
}

/**
 * 테이블 너비 계산 — fallback 체인
 */
function calculateTableWidths(headers, tableWidthsConfig = {}, totalWidth = 12960, docType) {
  const headerStr = headers.join('|');

  function toDxa(widths) {
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum <= 100) {
      const dxa = widths.map(p => Math.round(p / sum * totalWidth));
      const diff = totalWidth - dxa.reduce((a, b) => a + b, 0);
      dxa[dxa.length - 1] += diff;
      return dxa;
    }
    return widths;
  }

  const configMatch = matchPattern(headerStr, headers.length, tableWidthsConfig);
  if (configMatch) return toDxa(configMatch);

  const patterns = loadPatterns();
  if (patterns && patterns.tableWidths) {
    if (patterns.tableWidths.common) {
      const commonMatch = matchPattern(headerStr, headers.length, patterns.tableWidths.common);
      if (commonMatch) return toDxa(commonMatch);
    }
    if (docType && patterns.tableWidths.byDocType && patterns.tableWidths.byDocType[docType]) {
      const typeMatch = matchPattern(headerStr, headers.length, patterns.tableWidths.byDocType[docType]);
      if (typeMatch) return toDxa(typeMatch);
    }
  }

  return defaultTableWidths(headers, totalWidth);
}

// ============================================================
// 마크다운 전처리
// ============================================================

/**
 * 마크다운 H1 + 메타데이터 + 목차를 제거
 */
function cleanMarkdownHeader(markdown, h1Pattern, untilPattern) {
  const until = untilPattern || '## ';
  if (!h1Pattern) {
    const regex = new RegExp('^[\\s\\S]*?(?=' + until + ')', '');
    return markdown.replace(regex, '');
  }
  const regex = new RegExp(h1Pattern + '[\\s\\S]*?(?=' + until + ')', '');
  return markdown.replace(regex, '');
}

// ============================================================
// exports
// ============================================================

module.exports = {
  parseTable,
  lookAheadForImage,
  getImageDimensions,
  defaultTableWidths,
  loadPatterns,
  matchPattern,
  calculateTableWidths,
  cleanMarkdownHeader,
};

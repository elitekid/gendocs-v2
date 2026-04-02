const assert = require('assert');
const {
  parseTable, calculateTableWidths, cleanMarkdownHeader,
  _decideH2PageBreak, _decideH3PageBreak,
  _renderBlockquote, _renderCodeBlock, _renderTable,
} = require('../../lib/converter-core');

// ============================================================
// parseTable
// ============================================================

// 기본 2열 테이블
const t1 = parseTable([
  '| 항목 | 값 |',
  '|------|-----|',
  '| A | 1 |',
  '| B | 2 |',
]);
assert.strictEqual(t1.length, 3); // headers + 2 rows
assert.deepStrictEqual(t1[0], ['항목', '값']);
assert.deepStrictEqual(t1[1], ['A', '1']);

// 5열 테이블
const t2 = parseTable([
  '| a | b | c | d | e |',
  '|---|---|---|---|---|',
  '| 1 | 2 | 3 | 4 | 5 |',
]);
assert.strictEqual(t2[0].length, 5);

// 구분선만 → 빈 배열
const t3 = parseTable(['|---|---|', '|---|---|']);
assert.strictEqual(t3.length, 0);

// 빈 입력
assert.deepStrictEqual(parseTable([]), []);

// bold/code 마크다운 보존 (professional.js parseInlineFormatting이 처리)
const t4 = parseTable([
  '| **항목** | `값` |',
  '|---|---|',
  '| a | b |',
]);
assert.deepStrictEqual(t4[0], ['**항목**', '`값`']);

// ============================================================
// calculateTableWidths
// ============================================================

// doc-config 패턴 매칭
const w1 = calculateTableWidths(['항목', '값'], { '항목|값': [3000, 9960] }, 12960);
assert.deepStrictEqual(w1, [3000, 9960]);

// 퍼센트 → DXA 변환
const w2 = calculateTableWidths(['A', 'B'], { 'A|B': [30, 70] }, 12960);
assert.strictEqual(w2[0] + w2[1], 12960);
assert.ok(Math.abs(w2[0] - 3888) < 2); // 30% of 12960

// 매칭 실패 → fallback (defaultTableWidths)
const w3 = calculateTableWidths(['X', 'Y', 'Z'], {}, 12960);
assert.strictEqual(w3.length, 3);
assert.strictEqual(w3.reduce((a, b) => a + b, 0), 12960);

// ============================================================
// cleanMarkdownHeader
// ============================================================

const md = `# 문서 제목

목차 내용

## 변경 이력

| 버전 | 내용 |

## 1. 본문`;

// h1Pattern + default untilPattern
const cleaned1 = cleanMarkdownHeader(md, '^# 문서 제목');
assert.ok(cleaned1.startsWith('## 변경 이력'));
assert.ok(!cleaned1.includes('# 문서 제목'));

// h1Pattern + custom untilPattern
const cleaned2 = cleanMarkdownHeader(md, '^# 문서 제목', '## 1\\. 본문');
assert.ok(cleaned2.startsWith('## 1. 본문'));
assert.ok(!cleaned2.includes('변경 이력'));

// h1Pattern 없이 → 첫 H2까지 제거
const cleaned3 = cleanMarkdownHeader(md, null);
assert.ok(cleaned3.startsWith('## 변경 이력'));

// ============================================================
// _decideH2PageBreak
// ============================================================

// 명시적 H2 목록
assert.strictEqual(
  _decideH2PageBreak(2, 'API 명세', { pageBreakH2Set: new Set(['API 명세']), afterChangeHistory: true, beforeStopSection: true }),
  true
);
assert.strictEqual(
  _decideH2PageBreak(2, '기타', { pageBreakH2Set: new Set(['API 명세']), afterChangeHistory: true, beforeStopSection: true }),
  false
);

// 기본: h2Count===2 → break
assert.strictEqual(
  _decideH2PageBreak(2, '본문', { pageBreakH2Set: new Set(), afterChangeHistory: true, beforeStopSection: true }),
  true
);
assert.strictEqual(
  _decideH2PageBreak(1, '변경이력', { pageBreakH2Set: new Set(), afterChangeHistory: true, beforeStopSection: true }),
  false
);

// h2Count > 2, beforeStopSection
assert.strictEqual(
  _decideH2PageBreak(3, '부록', { pageBreakH2Set: new Set(), afterChangeHistory: true, beforeStopSection: true }),
  true
);
assert.strictEqual(
  _decideH2PageBreak(5, '끝', { pageBreakH2Set: new Set(), afterChangeHistory: true, beforeStopSection: false }),
  false
);

// ============================================================
// _decideH3PageBreak
// ============================================================

const base = {
  inNoBreakList: false, inBreakList: false, isChangeDetail: false,
  changeDetailH3Break: false, hasImage: false, imageH3AlwaysBreak: true,
  defaultH3Break: true, beforeStopSection: true,
  isFirstH3AfterH2: false, lastH2Broke: false,
};

assert.strictEqual(_decideH3PageBreak({ ...base, inNoBreakList: true }), false);
assert.strictEqual(_decideH3PageBreak({ ...base, inBreakList: true }), true);
assert.strictEqual(_decideH3PageBreak({ ...base, inBreakList: true, isFirstH3AfterH2: true }), false);
assert.strictEqual(_decideH3PageBreak({ ...base, hasImage: true, isFirstH3AfterH2: true, lastH2Broke: false }), true);
assert.strictEqual(_decideH3PageBreak({ ...base, hasImage: true, isFirstH3AfterH2: true, lastH2Broke: true }), false);
assert.strictEqual(_decideH3PageBreak({ ...base }), true); // defaultH3Break + beforeStopSection + not first
assert.strictEqual(_decideH3PageBreak({ ...base, isChangeDetail: true, changeDetailH3Break: false }), false);

// ============================================================
// _renderBlockquote
// ============================================================

// 주의 → warningBox
const mockT = {
  warningBox: (text) => ({ type: 'warning', text }),
  infoBox: (text) => ({ type: 'info', text }),
  spacer: (h) => ({ type: 'spacer', h }),
};
const bq1 = _renderBlockquote(['> 주의: 위험합니다', '> 조심하세요'], 0, mockT);
assert.strictEqual(bq1.nextIndex, 2);
assert.strictEqual(bq1.elements[0].type, 'warning');
assert.ok(bq1.elements[0].text.includes('위험합니다'));
assert.ok(bq1.elements[0].text.includes('조심하세요'));

// 일반 → infoBox
const bq2 = _renderBlockquote(['> 참고 사항입니다'], 0, mockT);
assert.strictEqual(bq2.elements[0].type, 'info');

// ============================================================
// _renderCodeBlock
// ============================================================

const codeMockT = {
  createJsonBlock: (lines) => ({ type: 'json', lines }),
  createSyntaxCodeBlock: (lines) => ({ type: 'syntax', lines }),
  spacer: (h) => ({ type: 'spacer', h }),
};
const cb1 = _renderCodeBlock(['```json', '{"a": 1}', '```'], 0, codeMockT);
assert.strictEqual(cb1.nextIndex, 3);
assert.strictEqual(cb1.elements[0].type, 'json');

const cb2 = _renderCodeBlock(['```bash', 'echo hello', '```'], 0, codeMockT);
assert.strictEqual(cb2.elements[0].type, 'syntax');

// 빈 코드블록
const cb3 = _renderCodeBlock(['```', '```'], 0, codeMockT);
assert.strictEqual(cb3.elements.length, 0);

// ============================================================
// _renderTable
// ============================================================

const tableMockT = {
  createTable: (h, w, r) => ({ type: 'table', headers: h, widths: w, rows: r }),
  spacer: (h) => ({ type: 'spacer', h }),
};
const rt1 = _renderTable(
  ['| A | B |', '|---|---|', '| 1 | 2 |'], 0,
  {}, 12960, undefined, tableMockT
);
assert.strictEqual(rt1.nextIndex, 3);
assert.strictEqual(rt1.elements[0].type, 'table');
assert.deepStrictEqual(rt1.elements[0].headers, ['A', 'B']);

// 헤더만 (2행 미만) → 빈 elements
const rt2 = _renderTable(['| A | B |'], 0, {}, 12960, undefined, tableMockT);
assert.strictEqual(rt2.elements.length, 0);

console.log('converter-core tests: ALL PASSED');

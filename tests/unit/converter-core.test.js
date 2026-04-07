const assert = require('assert');
const {
  parseTable, calculateTableWidths, cleanMarkdownHeader,
} = require('../../lib/converter-core');

// ============================================================
// parseTable
// ============================================================

const t1 = parseTable([
  '| 항목 | 값 |',
  '|------|-----|',
  '| A | 1 |',
  '| B | 2 |',
]);
assert.strictEqual(t1.length, 3);
assert.deepStrictEqual(t1[0], ['항목', '값']);
assert.deepStrictEqual(t1[1], ['A', '1']);

const t2 = parseTable([
  '| a | b | c | d | e |',
  '|---|---|---|---|---|',
  '| 1 | 2 | 3 | 4 | 5 |',
]);
assert.strictEqual(t2[0].length, 5);

const t3 = parseTable(['|---|---|', '|---|---|']);
assert.strictEqual(t3.length, 0);

assert.deepStrictEqual(parseTable([]), []);

const t4 = parseTable([
  '| **항목** | `값` |',
  '|---|---|',
  '| a | b |',
]);
assert.deepStrictEqual(t4[0], ['**항목**', '`값`']);

// ============================================================
// calculateTableWidths
// ============================================================

const w1 = calculateTableWidths(['항목', '값'], { '항목|값': [3000, 9960] }, 12960);
assert.deepStrictEqual(w1, [3000, 9960]);

const w2 = calculateTableWidths(['A', 'B'], { 'A|B': [30, 70] }, 12960);
assert.strictEqual(w2[0] + w2[1], 12960);
assert.ok(Math.abs(w2[0] - 3888) < 2);

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

const cleaned1 = cleanMarkdownHeader(md, '^# 문서 제목');
assert.ok(cleaned1.startsWith('## 변경 이력'));
assert.ok(!cleaned1.includes('# 문서 제목'));

const cleaned2 = cleanMarkdownHeader(md, '^# 문서 제목', '## 1\\. 본문');
assert.ok(cleaned2.startsWith('## 1. 본문'));
assert.ok(!cleaned2.includes('변경 이력'));

const cleaned3 = cleanMarkdownHeader(md, null);
assert.ok(cleaned3.startsWith('## 변경 이력'));

console.log('converter-core tests: ALL PASSED');

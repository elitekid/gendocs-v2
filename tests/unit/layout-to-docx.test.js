const assert = require('assert');
const IR = require('../../lib/ir/schema');
const { layoutToDocx } = require('../../lib/ir/layout-to-docx');

// 간단한 mock 템플릿
function createMockTemplate() {
  const calls = [];
  const mock = (name) => (...args) => {
    calls.push({ fn: name, args });
    return { _mock: name, args };
  };
  return {
    calls,
    h1: mock('h1'),
    h2: mock('h2'),
    h3: mock('h3'),
    h4: mock('h4'),
    text: mock('text'),
    bullet: mock('bullet'),
    numberedItem: mock('numberedItem'),
    labelText: mock('labelText'),
    infoBox: mock('infoBox'),
    warningBox: mock('warningBox'),
    flowBox: mock('flowBox'),
    pageBreak: mock('pageBreak'),
    spacer: mock('spacer'),
    createImage: mock('createImage'),
    createCodeBlock: mock('createCodeBlock'),
    createJsonBlock: mock('createJsonBlock'),
    createSyntaxCodeBlock: mock('createSyntaxCodeBlock'),
    createTable: mock('createTable'),
  };
}

// ============================================================
// 1. heading 매핑 (H1~H5)
// ============================================================

{
  const t = createMockTemplate();
  const content = [
    IR.heading(1, 'H1'), IR.heading(2, 'H2'), IR.heading(3, 'H3'),
    IR.heading(4, 'H4'), IR.heading(5, 'H5'),
  ];
  layoutToDocx(content, t);
  assert.deepStrictEqual(t.calls.map(c => c.fn), ['h1', 'h2', 'h3', 'h4', 'text']);
  assert.strictEqual(t.calls[4].args[1]?.bold, true); // H5 → bold text
}

// ============================================================
// 2. paragraph → t.text
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.paragraph('일반 텍스트')], t);
  assert.strictEqual(t.calls[0].fn, 'text');
  assert.strictEqual(t.calls[0].args[0], '일반 텍스트');
}

// ============================================================
// 3. paragraph labelText 패턴
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.paragraph([{ text: '메서드:', bold: true }, { text: ' POST' }])], t);
  assert.strictEqual(t.calls[0].fn, 'labelText');
  assert.strictEqual(t.calls[0].args[0], '메서드:');
  assert.strictEqual(t.calls[0].args[1], 'POST');
}

// ============================================================
// 4. list (unordered) → bullet
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.list(false, ['A', 'B', 'C'])], t);
  assert.strictEqual(t.calls.length, 3);
  assert.deepStrictEqual(t.calls.map(c => c.fn), ['bullet', 'bullet', 'bullet']);
}

// ============================================================
// 5. list (ordered) → numberedItem
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.list(true, ['첫째', '둘째'])], t);
  assert.strictEqual(t.calls.length, 2);
  assert.strictEqual(t.calls[0].fn, 'numberedItem');
  assert.strictEqual(t.calls[0].args[0], 1); // 번호
}

// ============================================================
// 6. table → createTable (width pt→DXA 역변환)
// ============================================================

{
  const t = createMockTemplate();
  const tbl = IR.table(
    [{ header: 'A', width: 300 }, { header: 'B', width: 348 }],
    [[{ runs: [{ text: '1' }] }, { runs: [{ text: '2' }] }]]
  );
  layoutToDocx([tbl], t);
  assert.strictEqual(t.calls[0].fn, 'createTable');
  // headers
  assert.deepStrictEqual(t.calls[0].args[0], ['A', 'B']);
  // widths: 300pt→6000DXA, 348pt→6960DXA
  assert.deepStrictEqual(t.calls[0].args[1], [6000, 6960]);
  // rows
  assert.strictEqual(t.calls[0].args[2][0][0], '1');
}

// ============================================================
// 7. codeBlock — JSON 자동 감지
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.codeBlock(['{"key": "val"}'], { language: '' })], t);
  assert.strictEqual(t.calls[0].fn, 'createJsonBlock');
}

// ============================================================
// 8. codeBlock — 일반
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.codeBlock(['console.log()'], { language: 'javascript' })], t);
  assert.strictEqual(t.calls[0].fn, 'createSyntaxCodeBlock');
}

// ============================================================
// 9. codeBlock — 빈 줄 스킵
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.codeBlock([], { language: 'js' })], t);
  assert.strictEqual(t.calls.length, 0);
}

// ============================================================
// 10. callout info → infoBox
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.callout('info', { runs: [{ text: '안내' }] })], t);
  assert.strictEqual(t.calls[0].fn, 'infoBox');
  assert.strictEqual(t.calls[0].args[0], '안내');
}

// ============================================================
// 11. callout warning → warningBox
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.callout('warning', { runs: [{ text: '주의' }] })], t);
  assert.strictEqual(t.calls[0].fn, 'warningBox');
}

// ============================================================
// 12. callout flow → flowBox
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.callout('flow', { content: [IR.list(false, ['Step 1', 'Step 2'])] })], t);
  assert.strictEqual(t.calls[0].fn, 'flowBox');
  assert.deepStrictEqual(t.calls[0].args[0], ['Step 1', 'Step 2']);
}

// ============================================================
// 13. image → createImage
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.image(780, 500, { path: '/test.png' })], t);
  assert.strictEqual(t.calls[0].fn, 'createImage');
  assert.strictEqual(t.calls[0].args[0], '/test.png');
  assert.strictEqual(t.calls[0].args[1], 780);
}

// ============================================================
// 14. pageBreak
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.pageBreak()], t);
  assert.strictEqual(t.calls[0].fn, 'pageBreak');
}

// ============================================================
// 15. spacer — pt→DXA 변환
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.spacer(7.5)], t); // 7.5pt
  assert.strictEqual(t.calls[0].fn, 'spacer');
  assert.strictEqual(t.calls[0].args[0], 150); // 7.5 * 20 = 150 DXA
}

// ============================================================
// 16. divider 스킵
// ============================================================

{
  const t = createMockTemplate();
  layoutToDocx([IR.divider()], t);
  assert.strictEqual(t.calls.length, 0);
}

// ============================================================
// 17. 빈 content
// ============================================================

{
  const t = createMockTemplate();
  const result = layoutToDocx([], t);
  assert.deepStrictEqual(result, []);
}

// ============================================================
// 18. 복합 시퀀스
// ============================================================

{
  const t = createMockTemplate();
  const content = [
    IR.heading(2, '제목'),
    IR.paragraph('텍스트'),
    IR.list(false, ['A', 'B']),
    IR.pageBreak(),
    IR.heading(3, '소제목'),
  ];
  layoutToDocx(content, t);
  assert.deepStrictEqual(t.calls.map(c => c.fn), ['h2', 'text', 'bullet', 'bullet', 'pageBreak', 'h3']);
}

console.log('  ✓ layout-to-docx.test.js (18건 통과)');

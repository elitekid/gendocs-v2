const assert = require('assert');
const s = require('../../lib/ir/schema');

// ============================================================
// 팩토리 함수 테스트 (17건)
// ============================================================

// heading
const h = s.heading(2, '제목');
assert.strictEqual(h.type, 'heading');
assert.strictEqual(h.level, 2);
assert.strictEqual(h.text, '제목');

// heading with opts
const h2 = s.heading(3, 'Hi', { runs: [{ text: 'Hi' }] });
assert.deepStrictEqual(h2.runs, [{ text: 'Hi' }]);

// paragraph — string → runs 변환
const p = s.paragraph('단순 텍스트');
assert.strictEqual(p.type, 'paragraph');
assert.deepStrictEqual(p.runs, [{ text: '단순 텍스트' }]);

// paragraph — Run 배열 그대로
const p2 = s.paragraph([{ text: 'A', bold: true }]);
assert.strictEqual(p2.runs[0].bold, true);

// table
const t = s.table(
  [{ width: 100, header: 'Col' }],
  [{ cells: [{ text: 'V' }] }]
);
assert.strictEqual(t.type, 'table');
assert.strictEqual(t.columns[0].width, 100);

// list
const l = s.list(true, [{ runs: [{ text: '1' }] }]);
assert.strictEqual(l.type, 'list');
assert.strictEqual(l.ordered, true);

// codeBlock
const cb = s.codeBlock(['line1', 'line2'], { language: 'js' });
assert.deepStrictEqual(cb.lines, ['line1', 'line2']);
assert.strictEqual(cb.language, 'js');

// image
const img = s.image(400, 300, { path: 'img.png' });
assert.strictEqual(img.width, 400);
assert.strictEqual(img.path, 'img.png');

// callout
const co = s.callout('warning');
assert.strictEqual(co.variant, 'warning');

// callout flow (flowBox용)
const coFlow = s.callout('flow', { content: [s.list(false, [{ runs: [{ text: 'Step 1' }] }])] });
assert.strictEqual(coFlow.variant, 'flow');
assert.strictEqual(coFlow.content[0].type, 'list');

// cover — string title
const cv = s.cover('제목문서');
assert.strictEqual(cv.title.text, '제목문서');

// cover — object title
const cv2 = s.cover({ text: '제목', fontSize: 24 });
assert.strictEqual(cv2.title.fontSize, 24);

// toc
const tc = s.toc({ maxLevel: 3 });
assert.strictEqual(tc.type, 'toc');
assert.strictEqual(tc.maxLevel, 3);

// pageBreak
const pb = s.pageBreak('after cover');
assert.strictEqual(pb.reason, 'after cover');

// spacer
const sp = s.spacer(20);
assert.strictEqual(sp.height, 20);

// section
const sec = s.section([s.heading(2, 'S')], { layout: { orientation: 'portrait' } });
assert.strictEqual(sec.content[0].type, 'heading');
assert.strictEqual(sec.layout.orientation, 'portrait');

// divider
const dv = s.divider();
assert.strictEqual(dv.type, 'divider');

// sheetDef
const sd = s.sheetDef('Sheet1', [s.heading(2, 'A')]);
assert.strictEqual(sd.name, 'Sheet1');
assert.strictEqual(sd.content[0].type, 'heading');

// breakRule
const br = s.breakRule({ type: 'heading', level: 2 }, 'break', 5);
assert.strictEqual(br.action, 'break');
assert.strictEqual(br.priority, 5);

// ============================================================
// validateIR — 유효 케이스 (5건)
// ============================================================

function makeMinimalIR() {
  return {
    meta: { title: '테스트' },
    layout: {
      pageSize: { width: 842, height: 595 },
      margins: { top: 54, right: 72, bottom: 54, left: 72 },
      orientation: 'landscape',
    },
    styles: {},
    content: [],
  };
}

// 최소 유효 IR
const r1 = s.validateIR(makeMinimalIR());
assert.strictEqual(r1.valid, true, 'minimal IR is valid');
assert.strictEqual(r1.errors.length, 0);

// 콘텐츠 포함 IR
const ir2 = makeMinimalIR();
ir2.content = [
  s.heading(2, '개요'),
  s.paragraph('본문'),
  s.table([{ width: 100, header: '필드' }], [{ cells: [{ text: 'val' }] }]),
  s.codeBlock(['{}'], { language: 'json', theme: 'dark', background: '1E1E1E' }),
  s.image(400, 300, { path: 'img.png' }),
  s.callout('info'),
  s.pageBreak(),
  s.spacer(10),
  s.divider(),
];
const r2 = s.validateIR(ir2);
assert.strictEqual(r2.valid, true, 'full content IR is valid');

// table width null (SemanticIR — 미확정)
const ir2b = makeMinimalIR();
ir2b.content = [s.table([{ width: null, header: '필드' }], [{ cells: [{ text: 'val' }] }])];
const r2b = s.validateIR(ir2b);
assert.strictEqual(r2b.valid, true, 'table with null width is valid (SemanticIR)');

// callout flow 포함 IR
const ir2c = makeMinimalIR();
ir2c.content = [s.callout('flow', { content: [s.list(false, [{ runs: [{ text: 'step' }] }])] })];
const r2c = s.validateIR(ir2c);
assert.strictEqual(r2c.valid, true, 'callout flow is valid');

// breakRules 포함
const ir3 = makeMinimalIR();
ir3.breakRules = [
  s.breakRule({ type: 'heading', level: 2 }, 'break'),
  s.breakRule({ type: 'heading', level: 3 }, 'noBreak', 10),
];
const r3 = s.validateIR(ir3);
assert.strictEqual(r3.valid, true, 'breakRules IR is valid');

// sheets 포함
const ir4 = makeMinimalIR();
ir4.sheets = [
  s.sheetDef('Sheet1', [s.heading(2, 'A')]),
];
const r4 = s.validateIR(ir4);
assert.strictEqual(r4.valid, true, 'sheets IR is valid');

// _source 포함
const ir5 = makeMinimalIR();
ir5._source = { format: 'docx', path: 'input/doc.docx' };
const r5 = s.validateIR(ir5);
assert.strictEqual(r5.valid, true, '_source IR is valid');

// ============================================================
// validateIR — 무효 케이스 (16건)
// ============================================================

function expectError(ir, keyword, msg) {
  const result = s.validateIR(ir);
  assert.strictEqual(result.valid, false, `${msg}: should be invalid`);
  const found = result.errors.some(e => e.includes(keyword));
  assert.ok(found, `${msg}: should contain '${keyword}' in errors, got: ${result.errors.join('; ')}`);
}

// meta 누락
expectError({ layout: makeMinimalIR().layout, styles: {}, content: [] },
  'meta', 'missing meta');

// meta.title 빈 문자열
expectError({ ...makeMinimalIR(), meta: { title: '' } },
  'meta.title', 'empty title');

// layout.pageSize.width 음수
const badLayout1 = makeMinimalIR();
badLayout1.layout.pageSize.width = -100;
expectError(badLayout1, 'pageSize.width', 'negative width');

// layout.orientation 잘못된 값
const badLayout2 = makeMinimalIR();
badLayout2.layout.orientation = 'diagonal';
expectError(badLayout2, 'orientation', 'invalid orientation');

// layout.margins.top 음수
const badLayout3 = makeMinimalIR();
badLayout3.layout.margins.top = -1;
expectError(badLayout3, 'margins.top', 'negative margin');

// content 노드 type이 'unknown'
const badNode1 = makeMinimalIR();
badNode1.content = [{ type: 'unknown' }];
expectError(badNode1, 'invalid', 'unknown node type');

// heading.level이 0
const badNode2 = makeMinimalIR();
badNode2.content = [s.heading(0, 'bad')];
expectError(badNode2, 'level', 'heading level 0');

// heading.level이 7
const badNode3 = makeMinimalIR();
badNode3.content = [s.heading(7, 'bad')];
expectError(badNode3, 'level', 'heading level 7');

// paragraph.runs가 null
const badNode4 = makeMinimalIR();
badNode4.content = [{ type: 'paragraph', runs: null }];
expectError(badNode4, 'runs', 'paragraph runs null');

// table.columns 빈 배열
const badNode5 = makeMinimalIR();
badNode5.content = [s.table([], [])];
expectError(badNode5, 'columns', 'empty columns');

// table.columns[0].width가 0
const badNode6 = makeMinimalIR();
badNode6.content = [s.table([{ width: 0, header: 'X' }], [])];
expectError(badNode6, 'width', 'zero column width');

// image에 path/data 둘 다 없음
const badNode7 = makeMinimalIR();
badNode7.content = [s.image(100, 100)];
expectError(badNode7, 'path or data', 'image no path or data');

// callout.variant가 'danger'
const badNode8 = makeMinimalIR();
badNode8.content = [s.callout('danger')];
expectError(badNode8, 'variant', 'invalid callout variant');

// spacer.height가 -5
const badNode9 = makeMinimalIR();
badNode9.content = [{ type: 'spacer', height: -5 }];
expectError(badNode9, 'height', 'negative spacer height');

// 색상 값이 'red'
const badColor = makeMinimalIR();
badColor.content = [s.heading(2, 'test', { inlineStyle: { color: 'red' } })];
expectError(badColor, 'hex', 'invalid hex color');

// breakRules[0].action이 'skip'
const badBreak = makeMinimalIR();
badBreak.breakRules = [{ match: { type: 'heading' }, action: 'skip' }];
expectError(badBreak, 'action', 'invalid break action');

// 여러 에러 동시 수집
const multiError = {
  meta: { title: '' },
  layout: { pageSize: { width: -1, height: 0 }, margins: { top: 0, right: 0, bottom: 0, left: 0 }, orientation: 'bad' },
  styles: {},
  content: [{ type: 'unknown' }],
};
const mr = s.validateIR(multiError);
assert.strictEqual(mr.valid, false);
assert.ok(mr.errors.length >= 3, `multiple errors: got ${mr.errors.length} (expected >=3)`);

console.log('ir-schema tests: ALL PASSED');

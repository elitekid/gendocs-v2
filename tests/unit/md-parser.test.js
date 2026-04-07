const assert = require('assert');
const { parse } = require('../../lib/parsers/md-parser');

// ============================================================
// 1. heading 테스트 (H1~H5)
// ============================================================

{
  const r = parse('# 제목1\n## 제목2\n### 제목3\n#### 제목4\n##### 제목5');
  assert.strictEqual(r.content.length, 5);
  assert.deepStrictEqual(r.content.map(n => n.type), ['heading','heading','heading','heading','heading']);
  assert.deepStrictEqual(r.content.map(n => n.level), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(r.content.map(n => n.text), ['제목1','제목2','제목3','제목4','제목5']);
  // headings 수집 확인
  assert.strictEqual(r.headings.length, 5);
  assert.deepStrictEqual(r.headings[0], { level: 1, text: '제목1' });
}

// ============================================================
// 2. H4 bold 제거
// ============================================================

{
  const r = parse('#### **볼드 제목**');
  assert.strictEqual(r.content[0].text, '볼드 제목');
}

// ============================================================
// 3. paragraph — 일반 텍스트
// ============================================================

{
  const r = parse('일반 텍스트 줄입니다.');
  assert.strictEqual(r.content.length, 1);
  assert.strictEqual(r.content[0].type, 'paragraph');
  assert.deepStrictEqual(r.content[0].runs, [{ text: '일반 텍스트 줄입니다.' }]);
}

// ============================================================
// 4. divider
// ============================================================

{
  const r = parse('---');
  assert.strictEqual(r.content.length, 1);
  assert.strictEqual(r.content[0].type, 'divider');
}

// ============================================================
// 5. 빈 줄 스킵
// ============================================================

{
  const r = parse('\n\n텍스트\n\n');
  assert.strictEqual(r.content.length, 1);
  assert.strictEqual(r.content[0].type, 'paragraph');
}

// ============================================================
// 6. blockquote — info
// ============================================================

{
  const r = parse('> 안내 메시지');
  assert.strictEqual(r.content.length, 2); // callout + spacer
  assert.strictEqual(r.content[0].type, 'callout');
  assert.strictEqual(r.content[0].variant, 'info');
  assert.strictEqual(r.content[0].runs[0].text, '안내 메시지');
  assert.strictEqual(r.content[1].type, 'spacer');
}

// ============================================================
// 7. blockquote — warning (주의/중요)
// ============================================================

{
  const r = parse('> 주의: 위험합니다');
  assert.strictEqual(r.content[0].variant, 'warning');
}

{
  const r = parse('> 중요: 필수 항목');
  assert.strictEqual(r.content[0].variant, 'warning');
}

// ============================================================
// 8. blockquote 연속 줄 병합
// ============================================================

{
  const r = parse('> 첫째 줄\n> 둘째 줄');
  assert.strictEqual(r.content[0].runs[0].text, '첫째 줄 둘째 줄');
}

// ============================================================
// 9. codeBlock
// ============================================================

{
  const r = parse('```json\n{"key": "val"}\n```');
  assert.strictEqual(r.content.length, 2); // codeBlock + spacer
  assert.strictEqual(r.content[0].type, 'codeBlock');
  assert.strictEqual(r.content[0].language, 'json');
  assert.deepStrictEqual(r.content[0].lines, ['{"key": "val"}']);
}

// ============================================================
// 10. codeBlock — 빈 코드블록 스킵
// ============================================================

{
  const r = parse('```\n```');
  assert.strictEqual(r.content.length, 0);
}

// ============================================================
// 11. codeBlock — JSON 자동 감지
// ============================================================

{
  const r = parse('```\n{\n  "a": 1\n}\n```');
  assert.strictEqual(r.content[0].language, 'json');
}

// ============================================================
// 12. table
// ============================================================

{
  const r = parse('| 이름 | 값 |\n|---|---|\n| A | 1 |');
  assert.strictEqual(r.content.length, 2); // table + spacer
  const t = r.content[0];
  assert.strictEqual(t.type, 'table');
  assert.strictEqual(t.columns.length, 2);
  assert.strictEqual(t.columns[0].header, '이름');
  assert.strictEqual(t.columns[1].header, '값');
  assert.strictEqual(t.rows.length, 1);
  assert.strictEqual(t.rows[0][0].runs[0].text, 'A');
}

// ============================================================
// 13. table — 너비 pt 변환
// ============================================================

{
  const r = parse('| A | B |\n|---|---|\n| 1 | 2 |', {
    tableWidths: { 'A|B': [6000, 6960] },
  });
  const t = r.content[0];
  assert.strictEqual(t.columns[0].width, 300);  // 6000/20
  assert.strictEqual(t.columns[1].width, 348);  // 6960/20
}

// ============================================================
// 14. 불릿 목록 묶음
// ============================================================

{
  const r = parse('- 항목1\n- 항목2\n- 항목3');
  assert.strictEqual(r.content.length, 1);
  const l = r.content[0];
  assert.strictEqual(l.type, 'list');
  assert.strictEqual(l.ordered, false);
  assert.deepStrictEqual(l.items, ['항목1', '항목2', '항목3']);
}

// ============================================================
// 15. 번호 목록 묶음
// ============================================================

{
  const r = parse('1. 첫째\n2. 둘째');
  assert.strictEqual(r.content.length, 1);
  const l = r.content[0];
  assert.strictEqual(l.type, 'list');
  assert.strictEqual(l.ordered, true);
  assert.deepStrictEqual(l.items, ['첫째', '둘째']);
}

// ============================================================
// 16. 불릿 후 다른 요소로 끊김
// ============================================================

{
  const r = parse('- A\n- B\n## 제목');
  assert.strictEqual(r.content.length, 2);
  assert.strictEqual(r.content[0].type, 'list');
  assert.strictEqual(r.content[0].items.length, 2);
  assert.strictEqual(r.content[1].type, 'heading');
}

// ============================================================
// 17. labelText → paragraph with bold run
// ============================================================

{
  const r = parse('**메서드:** POST');
  assert.strictEqual(r.content.length, 1);
  const p = r.content[0];
  assert.strictEqual(p.type, 'paragraph');
  assert.strictEqual(p.runs[0].text, '메서드:');
  assert.strictEqual(p.runs[0].bold, true);
  assert.strictEqual(p.runs[1].text, ' POST');
}

// ============================================================
// 18. flowBox → callout('flow')
// ============================================================

{
  const r = parse('**처리 흐름:**\n- Step 1\n- Step 2\n\n#### 다음 섹션');
  const flowNode = r.content[0];
  assert.strictEqual(flowNode.type, 'callout');
  assert.strictEqual(flowNode.variant, 'flow');
  assert.strictEqual(flowNode.content[0].type, 'list');
  assert.strictEqual(flowNode.content[0].items.length, 2);
}

// ============================================================
// 19. flowBox — 빈 항목 시 null + warning
// ============================================================

{
  const r = parse('**처리 흐름:**\n\n\n#### 끝');
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.warnings[0].element, 'flowBox');
}

// ============================================================
// 20. H2가 currentImageSection 리셋
// ============================================================

{
  const r = parse('## A\n### 1.1 섹션\n## B\n일반 텍스트');
  const types = r.content.map(n => n.type);
  assert.deepStrictEqual(types, ['heading', 'heading', 'heading', 'paragraph']);
}

// ============================================================
// 21. 복합 시퀀스 (heading → text → list → table)
// ============================================================

{
  const md = [
    '## 개요',
    '설명 텍스트',
    '- 항목A',
    '- 항목B',
    '| 헤더1 | 헤더2 |',
    '|---|---|',
    '| 값1 | 값2 |',
  ].join('\n');
  const r = parse(md);
  const types = r.content.map(n => n.type);
  assert.deepStrictEqual(types, ['heading', 'paragraph', 'list', 'table', 'spacer']);
}

// ============================================================
// 22. warnings/headings 반환 구조
// ============================================================

{
  const r = parse('## 섹션A\n### 1.1 소제목');
  assert.ok(Array.isArray(r.warnings));
  assert.ok(Array.isArray(r.headings));
  assert.strictEqual(r.headings.length, 2);
}

// ============================================================
// 23. orientation portrait 영향
// ============================================================

{
  // portrait vs landscape에서 테이블 너비가 다름
  const md = '| A | B |\n|---|---|\n| 1 | 2 |';
  const rL = parse(md, { orientation: 'landscape' });
  const rP = parse(md, { orientation: 'portrait' });
  const wL = rL.content[0].columns[0].width + rL.content[0].columns[1].width;
  const wP = rP.content[0].columns[0].width + rP.content[0].columns[1].width;
  assert.ok(wL > wP, 'landscape 테이블이 portrait보다 넓어야 함');
}

// ============================================================
// 24. spacer 삽입 위치 (blockquote 뒤, codeBlock 뒤, table 뒤)
// ============================================================

{
  const md = '> 안내\n```\ncode\n```\n| A |\n|---|\n| 1 |';
  const r = parse(md);
  const types = r.content.map(n => n.type);
  // callout, spacer, codeBlock, spacer, table, spacer
  assert.deepStrictEqual(types, ['callout', 'spacer', 'codeBlock', 'spacer', 'table', 'spacer']);
}

// ============================================================
// 25. parse 빈 입력
// ============================================================

{
  const r = parse('');
  assert.deepStrictEqual(r.content, []);
  assert.deepStrictEqual(r.headings, []);
  assert.deepStrictEqual(r.warnings, []);
}

console.log('  ✓ md-parser.test.js (25건 통과)');

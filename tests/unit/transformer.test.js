const assert = require('assert');
const IR = require('../../lib/ir/schema');
const {
  applyBreakRules,
  preCheck,
  finalizeTableWidths,
  checkRemainingDiagrams,
} = require('../../lib/ir/transformer');

// ============================================================
// breakRules 엔진 — BreakMatch 필드별 독립 테스트
// ============================================================

// 1. type + level 매칭
{
  const content = [IR.heading(2, 'A'), IR.heading(3, 'B')];
  const rules = [IR.breakRule({ type: 'heading', level: 2 }, 'break')];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result[0].type, 'pageBreak');
  assert.strictEqual(result.length, 3); // pageBreak + H2 + H3
}

// 2. type 불일치 → 매칭 안 됨
{
  const content = [IR.paragraph('text')];
  const rules = [IR.breakRule({ type: 'heading', level: 2 }, 'break')];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 1); // 그대로
}

// 3. textMatch 매칭
{
  const content = [IR.heading(2, '변경 이력'), IR.heading(2, 'API 목록')];
  const rules = [IR.breakRule({ type: 'heading', level: 2, textMatch: 'API' }, 'break')];
  const result = applyBreakRules(content, rules);
  // H2(변경이력), pageBreak, H2(API 목록)
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[1].type, 'pageBreak');
}

// 4. textMatch 불일치
{
  const content = [IR.heading(2, 'API')];
  const rules = [IR.breakRule({ type: 'heading', level: 2, textMatch: '없는텍스트' }, 'break')];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 1);
}

// 5. index gte
{
  const content = [IR.heading(2, 'A'), IR.heading(2, 'B'), IR.heading(2, 'C')];
  const rules = [IR.breakRule({ type: 'heading', level: 2, index: { gte: 2 } }, 'break')];
  const result = applyBreakRules(content, rules);
  // A, B, pageBreak, C
  assert.strictEqual(result.length, 4);
  assert.strictEqual(result[2].type, 'pageBreak');
}

// 6. index lt
{
  const content = [IR.heading(2, 'A'), IR.heading(2, 'B'), IR.heading(2, 'C')];
  const rules = [IR.breakRule({ type: 'heading', level: 2, index: { lt: 1 } }, 'break')];
  const result = applyBreakRules(content, rules);
  // pageBreak, A, B, C — 첫 번째(index 0)만 매칭
  assert.strictEqual(result.length, 4);
  assert.strictEqual(result[0].type, 'pageBreak');
}

// 7. notFirstInParent — 첫 번째 H3은 매칭 안 됨
{
  const content = [IR.heading(2, 'Parent'), IR.heading(3, 'First'), IR.heading(3, 'Second')];
  const rules = [IR.breakRule({ type: 'heading', level: 3, notFirstInParent: true }, 'break')];
  const result = applyBreakRules(content, rules);
  // H2, H3(First), pageBreak, H3(Second)
  assert.strictEqual(result.length, 4);
  assert.strictEqual(result[2].type, 'pageBreak');
}

// 8. notFirstInParent — 부모 없는 첫 번째도 매칭 안 됨
{
  const content = [IR.heading(3, 'Alone')];
  const rules = [IR.breakRule({ type: 'heading', level: 3, notFirstInParent: true }, 'break')];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 1); // 매칭 안 됨
}

// 9. hasImage — look-ahead
{
  const content = [
    IR.heading(3, 'A'),
    IR.image(100, 100, { path: '/test.png' }),
    IR.heading(3, 'B'),
  ];
  const rules = [IR.breakRule({ type: 'heading', level: 3, hasImage: true }, 'break')];
  const result = applyBreakRules(content, rules);
  // pageBreak, H3(A), image, H3(B) — A에 이미지 있으므로 매칭
  assert.strictEqual(result[0].type, 'pageBreak');
}

// 10. hasImage false — 이미지 없는 heading 매칭
{
  const content = [
    IR.heading(3, 'No Image'),
    IR.paragraph('text'),
    IR.heading(3, 'Also No Image'),
  ];
  const rules = [IR.breakRule({ type: 'heading', level: 3, hasImage: false }, 'break')];
  const result = applyBreakRules(content, rules);
  // 두 H3 모두 매칭
  assert.ok(result.filter(n => n.type === 'pageBreak').length === 2);
}

// 11. prevSameLevelHeading 매칭
{
  const content = [IR.heading(2, '변경 이력'), IR.paragraph('내용'), IR.heading(2, '본문')];
  const rules = [IR.breakRule(
    { type: 'heading', level: 2, prevSameLevelHeading: { textMatch: '변경' } },
    'break'
  )];
  const result = applyBreakRules(content, rules);
  // H2(변경이력), paragraph, pageBreak, H2(본문)
  assert.strictEqual(result.length, 4);
  assert.strictEqual(result[2].type, 'pageBreak');
}

// 12. prevSameLevelHeading — 첫 번째는 prevSameLevelHeading 없어서 매칭 안 됨
{
  const content = [IR.heading(2, '변경 이력')];
  const rules = [IR.breakRule(
    { type: 'heading', level: 2, prevSameLevelHeading: { textMatch: '변경' } },
    'break'
  )];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 1);
}

// 13. prevSibling 매칭
{
  const content = [IR.table([{header:'A',width:100}], []), IR.heading(2, 'After Table')];
  const rules = [IR.breakRule(
    { type: 'heading', level: 2, prevSibling: { type: 'table' } },
    'break'
  )];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[1].type, 'pageBreak');
}

// 14. 우선순위: noBreak(10) > break(5)
{
  const content = [IR.heading(3, '3.1 특수')];
  const rules = [
    IR.breakRule({ type: 'heading', level: 3, textMatch: '3\\.1' }, 'break', 5),
    IR.breakRule({ type: 'heading', level: 3, textMatch: '3\\.1' }, 'noBreak', 10),
  ];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 1); // noBreak 우선
}

// 15. 동순위면 noBreak 우선
{
  const content = [IR.heading(3, 'X')];
  const rules = [
    IR.breakRule({ type: 'heading', level: 3 }, 'break', 5),
    IR.breakRule({ type: 'heading', level: 3, textMatch: 'X' }, 'noBreak', 5),
  ];
  const result = applyBreakRules(content, rules);
  assert.strictEqual(result.length, 1); // noBreak 우선
}

// 16. parentIndex: 부모 H2의 index < 2일 때만 H3 break
{
  const content = [
    IR.heading(2, 'A'), IR.heading(3, 'a1'), IR.heading(3, 'a2'),  // A = H2 index 0
    IR.heading(2, 'B'), IR.heading(3, 'b1'), IR.heading(3, 'b2'),  // B = H2 index 1
    IR.heading(2, 'C'), IR.heading(3, 'c1'), IR.heading(3, 'c2'),  // C = H2 index 2
  ];
  const rules = [
    // parentIndex.lt: 2 → 부모 H2 index가 0, 1일 때만 매칭 (A, B 아래)
    IR.breakRule({ type: 'heading', level: 3, notFirstInParent: true, parentIndex: { lt: 2 } }, 'break', -1),
  ];
  const result = applyBreakRules(content, rules);
  // a2 앞에 break (A index 0 < 2), b2 앞에 break (B index 1 < 2), c2 앞에 break 없음 (C index 2 >= 2)
  const breaks = result.filter(n => n.type === 'pageBreak');
  assert.strictEqual(breaks.length, 2);
}

// 17. imageH3Legacy: isFirst여도 h2BreakOccurred=false면 매칭
{
  const content = [
    IR.heading(2, 'No Break H2'), // break 안 됨
    IR.heading(3, 'First H3 with Image'),
    IR.image(100, 100, { path: '/test.png' }),
  ];
  // imageH3 규칙: hasImage + notFirstInParent → legacy면 isFirst여도 !h2BreakOccurred일 때 매칭
  const rules = [
    IR.breakRule({ type: 'heading', level: 3, hasImage: true, notFirstInParent: true }, 'break', 1),
  ];
  const result = applyBreakRules(content, rules);
  // H2에 break 규칙 없음 → h2BreakOccurred = false
  // First H3: isFirst=true이지만 !h2BreakOccurred → legacy 매칭 → break
  const breaks = result.filter(n => n.type === 'pageBreak');
  assert.strictEqual(breaks.length, 1);
}

// 18. imageH3Legacy: isFirst이고 h2BreakOccurred=true면 매칭 안 됨
{
  const content = [
    IR.heading(2, 'Break H2'),
    IR.heading(3, 'First H3 with Image'),
    IR.image(100, 100, { path: '/test.png' }),
  ];
  const rules = [
    // H2 break 규칙 추가
    IR.breakRule({ type: 'heading', level: 2 }, 'break', 0),
    // imageH3 규칙
    IR.breakRule({ type: 'heading', level: 3, hasImage: true, notFirstInParent: true }, 'break', 1),
  ];
  const result = applyBreakRules(content, rules);
  // H2에서 break → h2BreakOccurred = true
  // First H3: isFirst=true, h2BreakOccurred=true → 매칭 안 됨
  const h3Breaks = result.filter((n, i) =>
    n.type === 'pageBreak' && i > 0 && result[i + 1]?.type === 'heading' && result[i + 1]?.level === 3
  );
  assert.strictEqual(h3Breaks.length, 0);
}

// ============================================================
// preCheck 테스트
// ============================================================

// 19a. CRITICAL: 빈 content → throw
{
  assert.throws(() => preCheck([]), /CRITICAL/);
}

// 19. heading level skip 감지
{
  const content = [IR.heading(1, 'H1'), IR.heading(3, 'H3')];
  const w = preCheck(content);
  assert.ok(w.some(w => w.message.includes('level skip')));
}

// 20. orphan heading 감지
{
  const content = [IR.paragraph('text'), IR.heading(2, 'Orphan')];
  const w = preCheck(content);
  assert.ok(w.some(w => w.message.includes('orphan')));
}

// 21. empty table 감지
{
  const content = [IR.table([{ header: 'A', width: 100 }], [])];
  const w = preCheck(content);
  assert.ok(w.some(w => w.message.includes('empty table')));
}

// 22. 정상 콘텐츠 — 경고 없음
{
  const content = [IR.heading(1, 'H1'), IR.heading(2, 'H2'), IR.paragraph('text')];
  const w = preCheck(content);
  assert.strictEqual(w.length, 0);
}

// ============================================================
// finalizeTableWidths 테스트
// ============================================================

// 23. null width → 균등분배
{
  const content = [
    IR.table(
      [{ header: 'A', width: null }, { header: 'B', width: null }],
      [[{ runs: [{ text: '1' }] }, { runs: [{ text: '2' }] }]]
    ),
  ];
  const result = finalizeTableWidths(content, {});
  assert.ok(result[0].columns[0].width > 0);
  assert.ok(result[0].columns[1].width > 0);
  // 두 컬럼 합이 totalWidth (landscape 12960 DXA = 648 pt)
  const total = result[0].columns[0].width + result[0].columns[1].width;
  assert.ok(Math.abs(total - 648) < 1, `total width: ${total}`);
}

// 24. 이미 값 있는 컬럼은 건드리지 않음
{
  const content = [
    IR.table(
      [{ header: 'A', width: 200 }, { header: 'B', width: null }],
      [[{ runs: [{ text: '1' }] }, { runs: [{ text: '2' }] }]]
    ),
  ];
  const result = finalizeTableWidths(content, {});
  assert.strictEqual(result[0].columns[0].width, 200);
  assert.ok(result[0].columns[1].width > 0);
}

// ============================================================
// checkRemainingDiagrams 테스트
// ============================================================

// 25. mermaid codeBlock 경고
{
  const content = [IR.codeBlock(['graph LR; A-->B'], { language: 'mermaid' })];
  const w = checkRemainingDiagrams(content);
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].message.includes('mermaid'));
}

// 26. 일반 codeBlock 경고 없음
{
  const content = [IR.codeBlock(['console.log()'], { language: 'javascript' })];
  const w = checkRemainingDiagrams(content);
  assert.strictEqual(w.length, 0);
}

// ============================================================
// 빈 입력
// ============================================================

// 27. 빈 rules → 그대로 반환
{
  const content = [IR.heading(2, 'A')];
  const result = applyBreakRules(content, []);
  assert.strictEqual(result.length, 1);
}

// 28. 빈 content → 그대로 반환
{
  const result = applyBreakRules([], [IR.breakRule({ type: 'heading' }, 'break')]);
  assert.strictEqual(result.length, 0);
}

console.log('  ✓ transformer.test.js (28건 통과)');

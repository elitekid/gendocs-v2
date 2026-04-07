const assert = require('assert');
const { convertPageBreaksToRules } = require('../../lib/ir/break-adapter');

// ============================================================
// 1. 빈 pageBreaks → 기본 규칙 (afterChangeHistory + defaultH3Break + imageH3)
// ============================================================

{
  const { rules } = convertPageBreaksToRules({});
  // afterChangeHistory (기본 true), imageH3AlwaysBreak (기본 true), defaultH3Break (기본 true)
  assert.ok(rules.length >= 3, `기본 규칙 3개 이상: ${rules.length}`);
  // afterChangeHistory 규칙 존재
  const acH = rules.find(r => r.match.prevSameLevelHeading);
  assert.ok(acH, 'afterChangeHistory 규칙 존재');
  assert.strictEqual(acH.match.prevSameLevelHeading.textMatch, '변경|개정');
}

// ============================================================
// 2. h2BreakBeforeSection: 4 → H2 index { gte:2, lt:3 } + defaultH3Break parentIndex { lt:3 }
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    h2BreakBeforeSection: 4,
  });
  const h2Rule = rules.find(r => r.match.type === 'heading' && r.match.level === 2 && r.match.index);
  assert.ok(h2Rule, 'h2BreakBeforeSection 규칙 존재');
  assert.strictEqual(h2Rule.match.index.gte, 2);
  assert.strictEqual(h2Rule.match.index.lt, 3);
  // defaultH3Break에 parentIndex가 추가됨
  const h3Default = rules.find(r => r.match.level === 3 && r.priority === -1);
  assert.ok(h3Default, 'defaultH3Break 규칙 존재');
  assert.strictEqual(h3Default.match.parentIndex.lt, 3, 'parentIndex.lt = h2BreakBeforeSection - 1');
}

// ============================================================
// 3. h2Sections가 있으면 afterChangeHistory / h2BreakBeforeSection 무시
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    afterChangeHistory: true,
    h2BreakBeforeSection: 4,
    h2Sections: ['1. 개요', '2. 통신 방식'],
  });
  // afterChangeHistory 규칙 없어야 함
  const acH = rules.find(r => r.match.prevSameLevelHeading);
  assert.strictEqual(acH, undefined, 'h2Sections 있으면 afterChangeHistory 무시');
  // h2BreakBeforeSection 규칙 없어야 함
  const h2Idx = rules.find(r => r.match.index);
  assert.strictEqual(h2Idx, undefined, 'h2Sections 있으면 h2BreakBeforeSection 무시');
  // h2Sections 규칙 존재
  const h2Rules = rules.filter(r => r.match.type === 'heading' && r.match.level === 2);
  assert.strictEqual(h2Rules.length, 2);
  assert.strictEqual(h2Rules[0].priority, 5);
}

// ============================================================
// 4. h3Sections → notFirstInParent: true, priority 5
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    defaultH3Break: false,
    h3Sections: ['4.1', '4.2'],
  });
  const h3Rules = rules.filter(r => r.match.type === 'heading' && r.match.level === 3 && r.action === 'break' && r.priority === 5);
  assert.strictEqual(h3Rules.length, 2);
  assert.strictEqual(h3Rules[0].match.notFirstInParent, true, 'h3Sections에 notFirstInParent');
  assert.ok(h3Rules[0].match.textMatch.includes('4\\.1'));
}

// ============================================================
// 5. noBreakH3Sections → priority 10
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    noBreakH3Sections: ['3.1'],
  });
  const noBreak = rules.find(r => r.action === 'noBreak' && r.match.level === 3);
  assert.ok(noBreak);
  assert.strictEqual(noBreak.priority, 10);
  assert.ok(noBreak.match.textMatch.includes('3\\.1'));
}

// ============================================================
// 6. defaultH3Break: false → 규칙 생성 안 함
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    defaultH3Break: false,
    imageH3AlwaysBreak: false,
  });
  const defaultRule = rules.find(r => r.match.level === 3 && r.action === 'break' && r.priority === -1);
  assert.strictEqual(defaultRule, undefined, 'defaultH3Break false면 규칙 없음');
}

// ============================================================
// 7. defaultH3Break: true → priority -1
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    defaultH3Break: true,
  });
  const defaultRule = rules.find(r => r.match.level === 3 && r.priority === -1);
  assert.ok(defaultRule);
  assert.strictEqual(defaultRule.match.notFirstInParent, true);
}

// ============================================================
// 8. imageH3AlwaysBreak → hasImage + notFirstInParent, priority 1
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    imageH3AlwaysBreak: true,
    defaultH3Break: false,
  });
  const imgRule = rules.find(r => r.match.hasImage === true);
  assert.ok(imgRule);
  assert.strictEqual(imgRule.match.notFirstInParent, true);
  assert.strictEqual(imgRule.priority, 1);
}

// ============================================================
// 9. changeDetailH3Break: true → priority 2
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    changeDetailH3Break: true,
    defaultH3Break: false,
  });
  const cdRule = rules.find(r => r.match.textMatch && r.match.textMatch.includes('변경 상세'));
  assert.ok(cdRule);
  assert.strictEqual(cdRule.action, 'break');
  assert.strictEqual(cdRule.priority, 2);
  assert.strictEqual(cdRule.match.notFirstInParent, true);
}

// ============================================================
// 10. changeDetailH3Break: false → noBreak 규칙
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    changeDetailH3Break: false,
    defaultH3Break: false,
  });
  const cdRule = rules.find(r => r.match.textMatch && r.match.textMatch.includes('변경 상세'));
  assert.ok(cdRule);
  assert.strictEqual(cdRule.action, 'noBreak');
}

// ============================================================
// 11. sample-api doc-config 변환 검증
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    afterChangeHistory: true,
    h2BreakBeforeSection: 4,
    defaultH3Break: false,
    h3Sections: ['4.1', '4.2', '4.3', '4.4', '4.5', '5.1', '5.2'],
  });
  // H2 규칙: afterChangeHistory(0) + h2BreakBeforeSection(0) = 2개
  const h2Rules = rules.filter(r => r.match.level === 2);
  assert.strictEqual(h2Rules.length, 2);
  // H3 break 규칙: h3Sections 7개 + imageH3(1) = 8개 (defaultH3Break false니까 없음)
  const h3Break = rules.filter(r => r.match.level === 3 && r.action === 'break');
  assert.strictEqual(h3Break.length, 8, `H3 break rules: ${h3Break.length}`);
}

// ============================================================
// 12. sample-batch doc-config 변환 검증
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    afterChangeHistory: true,
    h2Sections: ['1. 개요', '2. 통신 방식', '3. 배치 파일 규격'],
    h3Sections: ['1.3', '3.3', '3.4'],
    defaultH3Break: false,
  });
  // H2: h2Sections 3개 (afterChangeHistory 무시)
  const h2Rules = rules.filter(r => r.match.level === 2);
  assert.strictEqual(h2Rules.length, 3);
  // H3: h3Sections 3개 + imageH3(1) = 4개
  const h3Break = rules.filter(r => r.match.level === 3 && r.action === 'break');
  assert.strictEqual(h3Break.length, 4);
}

// ============================================================
// 13. parentIndex — h2BreakBeforeSection이 defaultH3Break에 반영
// ============================================================

{
  const { rules } = convertPageBreaksToRules({
    defaultH3Break: true,
    h2BreakBeforeSection: 5,
  });
  const h3Default = rules.find(r => r.match.level === 3 && r.priority === -1);
  assert.ok(h3Default);
  assert.strictEqual(h3Default.match.parentIndex.lt, 4, 'h2BreakBeforeSection 5 → parentIndex.lt 4');
}

// ============================================================
// 14. parentIndex — h2BreakBeforeSection 없으면 parentIndex 없음
// ============================================================

{
  const { rules } = convertPageBreaksToRules({ defaultH3Break: true });
  const h3Default = rules.find(r => r.match.level === 3 && r.priority === -1);
  assert.ok(h3Default);
  assert.strictEqual(h3Default.match.parentIndex, undefined, 'parentIndex 없음');
}

console.log('  ✓ break-adapter.test.js (14건 통과)');

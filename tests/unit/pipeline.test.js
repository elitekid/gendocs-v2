const assert = require('assert');
const { _calcConfidence } = require('../../lib/fix/reflections-writer');

// ============================================================
// reflections-writer confidence 계산 테스트
// ============================================================

// 1. evidenceCount 1 → 0.5
{
  const lesson = { evidenceCount: 1, evidence: [{ verifierResult: 'PASS' }] };
  assert.strictEqual(_calcConfidence(lesson), 0.5);
}

// 2. evidenceCount 2 → 0.7
{
  const lesson = { evidenceCount: 2, evidence: [
    { verifierResult: 'PASS' }, { verifierResult: 'PASS' }
  ]};
  assert.strictEqual(_calcConfidence(lesson), 0.7);
}

// 3. evidenceCount 3 → 0.85
{
  const lesson = { evidenceCount: 3, evidence: [
    { verifierResult: 'PASS' }, { verifierResult: 'PASS' }, { verifierResult: 'PASS' }
  ]};
  assert.strictEqual(_calcConfidence(lesson), 0.85);
}

// 4. evidenceCount 5+ → 1.0
{
  const lesson = { evidenceCount: 5, evidence: Array(5).fill({ verifierResult: 'PASS' }) };
  assert.strictEqual(_calcConfidence(lesson), 1.0);
}

// 5. PASS 비율 50% → 감점
{
  const lesson = { evidenceCount: 2, evidence: [
    { verifierResult: 'PASS' }, { verifierResult: 'PARTIAL' }
  ]};
  // base 0.7 * passRate 0.5 = 0.35
  assert.strictEqual(_calcConfidence(lesson), 0.35);
}

// 6. 빈 evidence → 0.5
{
  const lesson = { evidenceCount: 0, evidence: [] };
  assert.strictEqual(_calcConfidence(lesson), 0.5);
}

console.log('  ✓ pipeline.test.js (6건 통과)');

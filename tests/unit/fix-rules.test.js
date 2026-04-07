const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { apply, filterFixable } = require('../../lib/fix/fix-rules');

// ============================================================
// 1. filterFixable — suggestion 있는 WARN만 필터
// ============================================================

{
  const warns = [
    { code: 'IMAGE_NEEDS_PAGE_BREAK', severity: 'WARN', message: '...' },
    { code: 'WIDTH_IMBALANCE', severity: 'WARN', suggestion: { headers: 'A|B', recommended: [5000, 7960] } },
    { code: 'ORPHAN_HEADING', severity: 'INFO', message: '...' },
  ];
  const fixable = filterFixable(warns);
  assert.strictEqual(fixable.length, 1);
  assert.strictEqual(fixable[0].code, 'WIDTH_IMBALANCE');
}

// ============================================================
// 2. apply — WIDTH_IMBALANCE → tableWidths 수정
// ============================================================

{
  const config = { tableWidths: { 'A|B': [3000, 9960] } };
  const warns = [{
    code: 'WIDTH_IMBALANCE',
    severity: 'WARN',
    suggestion: { headers: 'A|B', recommended: [5000, 7960] },
  }];
  const { applied } = apply(null, config, warns); // configPath=null → 파일 저장 안 함
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].field, 'tableWidths["A|B"]');
  assert.deepStrictEqual(applied[0].before, [3000, 9960]);
  assert.deepStrictEqual(applied[0].after, [5000, 7960]);
  assert.deepStrictEqual(config.tableWidths['A|B'], [5000, 7960]);
}

// ============================================================
// 3. apply — tableWidths가 없으면 생성
// ============================================================

{
  const config = {};
  const warns = [{
    code: 'WIDTH_IMBALANCE',
    severity: 'WARN',
    suggestion: { headers: 'X|Y', recommended: [6000, 6960] },
  }];
  const { applied } = apply(null, config, warns);
  assert.strictEqual(applied.length, 1);
  assert.deepStrictEqual(config.tableWidths['X|Y'], [6000, 6960]);
}

// ============================================================
// 4. apply — NARROW_IMAGE → diagrams.width 수정
// ============================================================

{
  const config = { diagrams: { width: 512 } };
  const warns = [{
    code: 'NARROW_IMAGE',
    severity: 'WARN',
    suggestion: { width: 1024 },
  }];
  const { applied } = apply(null, config, warns);
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].field, 'diagrams.width');
  assert.strictEqual(applied[0].before, 512);
  assert.strictEqual(config.diagrams.width, 1024);
}

// ============================================================
// 5. apply — suggestion 없는 WARN은 무시
// ============================================================

{
  const config = {};
  const warns = [
    { code: 'IMAGE_NEEDS_PAGE_BREAK', severity: 'WARN', message: '...' },
  ];
  const { applied } = apply(null, config, warns);
  assert.strictEqual(applied.length, 0);
}

// ============================================================
// 6. apply — 파일 저장 (임시 파일)
// ============================================================

{
  const tmpPath = path.join(__dirname, '..', '_test_config_tmp.json');
  const config = { tableWidths: {} };
  fs.writeFileSync(tmpPath, JSON.stringify(config), 'utf-8');

  const warns = [{
    code: 'WIDTH_IMBALANCE',
    severity: 'WARN',
    suggestion: { headers: 'T|V', recommended: [4000, 8960] },
  }];
  apply(tmpPath, config, warns);

  const saved = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
  assert.deepStrictEqual(saved.tableWidths['T|V'], [4000, 8960]);
  fs.unlinkSync(tmpPath);
}

// ============================================================
// 7. apply — 빈 warns → 변경 없음
// ============================================================

{
  const config = { tableWidths: { 'A|B': [1, 2] } };
  const { applied } = apply(null, config, []);
  assert.strictEqual(applied.length, 0);
  assert.deepStrictEqual(config.tableWidths['A|B'], [1, 2]);
}

console.log('  ✓ fix-rules.test.js (7건 통과)');

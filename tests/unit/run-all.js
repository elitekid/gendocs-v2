#!/usr/bin/env node
/**
 * 단위 테스트 러너 — tests/unit/*.test.js 실행
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const unitDir = __dirname;
const testFiles = fs.readdirSync(unitDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

let passed = 0;
let failed = 0;

for (const file of testFiles) {
  const filePath = path.join(unitDir, file);
  try {
    execSync(`node "${filePath}"`, { stdio: 'pipe' });
    console.log(`  ✓ ${file}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${file}`);
    console.log(err.stdout?.toString() || '');
    console.log(err.stderr?.toString() || '');
    failed++;
  }
}

console.log(`\n  PASS ${passed} | FAIL ${failed} / 총 ${testFiles.length}개`);
if (failed > 0) process.exit(1);

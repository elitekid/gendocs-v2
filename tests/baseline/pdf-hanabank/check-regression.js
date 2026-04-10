#!/usr/bin/env node
/**
 * PDF→DOCX 하위 호환성(regression) 검증
 *
 * 사용법: node tests/baseline/pdf-hanabank/check-regression.js
 *
 * extract-pdf-ir.py 또는 plain-docx.js 수정 후 커밋 전에 반드시 실행.
 * baseline.json과 비교하여 페이지 수, 시작/끝 텍스트가 바뀌면 FAIL.
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// 한글 파일명 인코딩 방지: glob으로 config 찾기
const configDir = path.join(ROOT, 'doc-configs');
const configFile = fs.readdirSync(configDir).find(f => f.includes('QR_flow_from_pdf'));
if (!configFile) {
  console.error('FAIL: doc-config not found (QR_flow_from_pdf)');
  process.exit(1);
}
const CONFIG = path.join(configDir, configFile);

console.log('=== PDF→DOCX Regression: hanabank ===');

// 1. 변환
console.log('1. Converting...');
try {
  execSync(`node lib/convert.js "${CONFIG}"`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' });
  console.log('   OK');
} catch (e) {
  console.error('FAIL: convert error\n' + (e.stderr || e.stdout || e.message).substring(0, 300));
  process.exit(1);
}

// 2. 렌더링 + baseline 비교
console.log('2. Comparing with baseline...');
const comparePy = path.join(__dirname, 'compare.py');
try {
  const result = execSync(
    `python -X utf8 "${comparePy}"`,
    { cwd: ROOT, encoding: 'utf-8', timeout: 120000 }
  );
  console.log('   ' + result.trim());
} catch (e) {
  console.log('   ' + (e.stdout?.trim() || e.stderr?.trim() || 'Unknown error'));
  process.exit(1);
}

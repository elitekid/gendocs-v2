#!/usr/bin/env node
/**
 * 스모크 테스트 — examples 3개 변환하여 크래시 없이 파일 생성되는지 확인
 * DOCX는 validate-docx.py로 WARN 0 검증, XLSX는 파일 존재만 확인
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEMP_DIR = path.join(PROJECT_ROOT, '.temp-smoke');

const TESTS = [
  { config: 'examples/sample-api/doc-config.json', format: 'docx', name: 'sample-api' },
  { config: 'examples/sample-batch/doc-config.json', format: 'docx', name: 'sample-batch' },
  { config: 'examples/sample-code-def/doc-config.json', format: 'xlsx', name: 'sample-code-def' },
];

function cleanup() {
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
}

function main() {
  cleanup();
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  let passed = 0;
  let failed = 0;

  for (const t of TESTS) {
    const configPath = path.join(PROJECT_ROOT, t.config);
    if (!fs.existsSync(configPath)) {
      console.log(`  - ${t.name} SKIP (config 없음)`);
      continue;
    }

    try {
      // 변환
      const tempRel = path.relative(PROJECT_ROOT, TEMP_DIR);
      execSync(
        `node lib/convert.js "${configPath}" --output-dir "${tempRel}"`,
        { cwd: PROJECT_ROOT, stdio: 'pipe', encoding: 'utf-8' }
      );

      // 출력 파일 찾기
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      let outputBase = path.basename(config.output);
      if (outputBase.includes('{version}')) {
        outputBase = outputBase.replace('{version}', config.docInfo?.version || 'v1.0');
      }
      const outputPath = path.join(TEMP_DIR, outputBase);

      if (!fs.existsSync(outputPath)) {
        throw new Error(`출력 파일 없음: ${outputBase}`);
      }

      const stat = fs.statSync(outputPath);
      if (stat.size === 0) {
        throw new Error(`출력 파일 0바이트: ${outputBase}`);
      }

      // DOCX만 WARN 검증
      if (t.format === 'docx') {
        const validateOut = execSync(
          `python -X utf8 tools/validate-docx.py "${outputPath}" --json`,
          { cwd: PROJECT_ROOT, stdio: 'pipe', encoding: 'utf-8' }
        );
        const report = JSON.parse(validateOut);
        const warnCount = (report.issues || []).filter(i => i.severity === 'WARN').length;
        if (warnCount > 0) {
          throw new Error(`WARN ${warnCount}건`);
        }
        console.log(`  ✓ ${t.name} (${t.format}, ${report.stats?.estimatedPages}p, WARN 0)`);
      } else {
        console.log(`  ✓ ${t.name} (${t.format}, ${(stat.size / 1024).toFixed(0)}KB)`);
      }

      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name} — ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  cleanup();

  console.log(`\n  PASS ${passed} | FAIL ${failed} / 총 ${TESTS.length}개`);
  if (failed > 0) process.exit(1);
}

main();

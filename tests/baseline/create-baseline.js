#!/usr/bin/env node
/**
 * 기준선 스냅샷 생성 — Phase 0
 * examples 3개를 변환하여 tests/baseline/에 산출물 복사.
 * Phase 2 이후 회귀 비교 기준점.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_DIR = __dirname;
const TEMP_DIR = path.join(PROJECT_ROOT, '.temp-baseline');

const EXAMPLES = [
  { config: 'examples/sample-api/doc-config.json', output: 'sample-api.docx' },
  { config: 'examples/sample-batch/doc-config.json', output: 'sample-batch.docx' },
  { config: 'examples/sample-code-def/doc-config.json', output: 'sample-code-def.xlsx' },
];

function main() {
  // cleanup temp
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const manifest = {
    createdAt: new Date().toISOString(),
    files: [],
  };

  for (const ex of EXAMPLES) {
    const configPath = path.join(PROJECT_ROOT, ex.config);
    if (!fs.existsSync(configPath)) {
      console.log(`  SKIP: ${ex.config} (없음)`);
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
      const tempOutput = path.join(TEMP_DIR, outputBase);

      if (!fs.existsSync(tempOutput)) {
        console.log(`  FAIL: ${ex.output} — 출력 파일 없음`);
        continue;
      }

      // baseline 디렉토리에 복사
      const baselinePath = path.join(BASELINE_DIR, ex.output);
      fs.copyFileSync(tempOutput, baselinePath);

      const stat = fs.statSync(baselinePath);
      manifest.files.push({
        name: ex.output,
        size: stat.size,
        source: ex.config,
      });

      console.log(`  OK: ${ex.output} (${(stat.size / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.log(`  FAIL: ${ex.output} — ${err.message.split('\n')[0]}`);
    }
  }

  // manifest 저장
  const manifestPath = path.join(BASELINE_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n  manifest: ${manifest.files.length}개 파일 기록`);

  // cleanup temp
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
}

main();

/**
 * create-baselines.js — 기존 doc-config의 validate JSON에서 baseline 스냅샷 생성
 *
 * 사용법: node tools/create-baselines.js
 *         node tools/create-baselines.js --force  (기존 baseline 덮어쓰기)
 *
 * 각 doc-config에 대해:
 * 1. node lib/convert.js 실행 (DOCX 생성)
 * 2. python -X utf8 tools/validate-docx.py --json 실행 (검증)
 * 3. stats에서 baseline 필드 추출 → tests/golden/{name}.baseline.json 저장
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOC_CONFIGS_DIR = path.join(PROJECT_ROOT, 'doc-configs');
const GOLDEN_DIR = path.join(PROJECT_ROOT, 'tests', 'golden');
const TEMP_OUTPUT_DIR = '.temp-test';

function getConfigName(configPath) {
  return path.basename(configPath, '.json');
}

function extractBaseline(name, report) {
  const stats = report.stats || {};
  const issues = report.issues || [];

  return {
    docConfig: name,
    capturedAt: new Date().toISOString().slice(0, 10),
    stats: {
      headings: stats.headings || 0,
      headingsByLevel: stats.headingsByLevel || {},
      bullets: stats.bullets || 0,
      tables: stats.tables || 0,
      codeBlocks: stats.codeBlocks || 0,
      infoBoxes: stats.infoBoxes || 0,
      images: stats.images || 0,
      pageBreaks: stats.pageBreaks || 0,
      estimatedPages: stats.estimatedPages || 0,
    },
    warnCount: issues.filter(i => i.severity === 'WARN').length,
    infoCount: issues.filter(i => i.severity === 'INFO').length,
  };
}

function main() {
  const force = process.argv.includes('--force');

  // tests/golden 디렉토리 생성
  if (!fs.existsSync(GOLDEN_DIR)) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  }

  // doc-configs 수집
  const configFiles = fs.readdirSync(DOC_CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DOC_CONFIGS_DIR, f));

  if (configFiles.length === 0) {
    console.log('doc-configs/ 에 JSON 파일이 없습니다.');
    process.exit(0);
  }

  // 임시 출력 디렉토리 생성 (output/ 오염 방지)
  const tempDir = path.join(PROJECT_ROOT, TEMP_OUTPUT_DIR);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  console.log(`\n=== Baseline 생성 시작 (${configFiles.length}개 문서) ===\n`);

  const results = [];

  for (const configPath of configFiles) {
    const name = getConfigName(configPath);
    const baselinePath = path.join(GOLDEN_DIR, `${name}.baseline.json`);

    // 기존 baseline 존재 확인
    if (fs.existsSync(baselinePath) && !force) {
      console.log(`[SKIP] ${name} — baseline 이미 존재 (--force로 덮어쓰기)`);
      results.push({ name, status: 'SKIP' });
      continue;
    }

    console.log(`[BUILD] ${name} — 변환 중...`);

    try {
      // 1. DOCX 변환 (임시 디렉토리로 출력)
      execSync(`node lib/convert.js "${configPath}" --output-dir "${TEMP_OUTPUT_DIR}"`, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      // config에서 output 경로 파악 (임시 디렉토리 기준)
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      let outputBase = path.basename(config.output);
      if (outputBase.includes('{version}')) {
        outputBase = outputBase.replace('{version}', config.docInfo?.version || 'v1.0');
      }
      const outputPath = path.join(tempDir, outputBase);

      if (!fs.existsSync(outputPath)) {
        console.log(`  [ERROR] 출력 파일 없음: ${outputPath}`);
        results.push({ name, status: 'ERROR', message: '출력 파일 없음' });
        continue;
      }

      // 2. 검증
      console.log(`  검증 중...`);
      const validateOutput = execSync(
        `python -X utf8 tools/validate-docx.py "${outputPath}" --json`,
        { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe' }
      );

      const report = JSON.parse(validateOutput);

      // 3. Baseline 추출 + 저장
      const baseline = extractBaseline(name, report);
      fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');

      console.log(`  [OK] ${baseline.stats.estimatedPages}p, WARN ${baseline.warnCount}, INFO ${baseline.infoCount}`);
      results.push({ name, status: 'OK', pages: baseline.stats.estimatedPages });

    } catch (err) {
      console.log(`  [ERROR] ${err.message.split('\n')[0]}`);
      results.push({ name, status: 'ERROR', message: err.message.split('\n')[0] });
    }
  }

  // 요약
  console.log('\n=== 요약 ===\n');
  const ok = results.filter(r => r.status === 'OK').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const error = results.filter(r => r.status === 'ERROR').length;

  for (const r of results) {
    const icon = r.status === 'OK' ? '✓' : r.status === 'SKIP' ? '-' : '✗';
    const detail = r.pages ? `${r.pages}p` : r.message || '';
    console.log(`  ${icon} ${r.name}: ${r.status} ${detail}`);
  }

  console.log(`\n합계: OK ${ok}, SKIP ${skip}, ERROR ${error} / 총 ${results.length}개`);

  // 임시 출력 디렉토리 정리
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }

  if (error > 0) process.exit(1);
}

main();

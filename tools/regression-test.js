/**
 * regression-test.js — 회귀 테스트: 모든 doc-config 재변환 후 baseline 비교
 *
 * 사용법: node tools/regression-test.js
 *         node tools/regression-test.js --verbose    (상세 diff 출력)
 *         node tools/regression-test.js --name api-spec  (특정 문서만)
 *
 * 비교 허용 범위:
 *   estimatedPages: ±2
 *   headings, headingsByLevel: 정확 일치
 *   tables, codeBlocks, images, infoBoxes: 정확 일치
 *   bullets: ±2
 *   pageBreaks: 정확 일치
 *   warnCount: 같거나 감소만 허용
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOC_CONFIGS_DIR = path.join(PROJECT_ROOT, 'doc-configs');
const GOLDEN_DIR = path.join(PROJECT_ROOT, 'tests', 'golden');
const TEMP_OUTPUT_DIR = '.temp-test';

// 허용 범위 정의
const TOLERANCES = {
  estimatedPages: { type: 'range', value: 2 },
  headings: { type: 'exact' },
  bullets: { type: 'range', value: 2 },
  tables: { type: 'exact' },
  codeBlocks: { type: 'exact' },
  infoBoxes: { type: 'exact' },
  images: { type: 'exact' },
  pageBreaks: { type: 'exact' },
};

function getConfigName(configPath) {
  return path.basename(configPath, '.json');
}

function compareValues(key, expected, actual) {
  const tolerance = TOLERANCES[key];
  if (!tolerance) return { pass: true };

  if (tolerance.type === 'exact') {
    if (expected !== actual) {
      return { pass: false, diff: `expected ${expected}, got ${actual}` };
    }
  } else if (tolerance.type === 'range') {
    if (Math.abs(actual - expected) > tolerance.value) {
      return { pass: false, diff: `expected ${expected}±${tolerance.value}, got ${actual}` };
    }
  }
  return { pass: true };
}

function compareHeadingsByLevel(expected, actual) {
  const diffs = [];
  const allLevels = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);

  for (const level of allLevels) {
    const exp = (expected || {})[level] || 0;
    const act = (actual || {})[level] || 0;
    if (exp !== act) {
      diffs.push(`${level}: expected ${exp}, got ${act}`);
    }
  }
  return diffs;
}

function compareBaseline(baseline, current) {
  const failures = [];
  const bs = baseline.stats;
  const cs = current.stats;

  // stats 비교
  for (const key of Object.keys(TOLERANCES)) {
    const result = compareValues(key, bs[key], cs[key]);
    if (!result.pass) {
      failures.push({ field: `stats.${key}`, ...result });
    }
  }

  // headingsByLevel 비교
  const levelDiffs = compareHeadingsByLevel(bs.headingsByLevel, cs.headingsByLevel);
  for (const diff of levelDiffs) {
    failures.push({ field: 'stats.headingsByLevel', diff });
  }

  // warnCount: 같거나 감소만 허용
  if (current.warnCount > baseline.warnCount) {
    failures.push({
      field: 'warnCount',
      diff: `expected ≤${baseline.warnCount}, got ${current.warnCount} (WARN 증가)`,
    });
  }

  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const nameIdx = args.indexOf('--name');
  const filterName = nameIdx >= 0 ? args[nameIdx + 1] : null;

  // doc-configs 수집
  let configFiles = fs.readdirSync(DOC_CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DOC_CONFIGS_DIR, f));

  if (filterName) {
    configFiles = configFiles.filter(f => getConfigName(f) === filterName);
    if (configFiles.length === 0) {
      console.error(`[ERROR] doc-config '${filterName}' 을 찾을 수 없습니다.`);
      process.exit(1);
    }
  }

  // 임시 출력 디렉토리 생성 (output/ 오염 방지)
  const tempDir = path.join(PROJECT_ROOT, TEMP_OUTPUT_DIR);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  console.log(`\n=== 회귀 테스트 시작 (${configFiles.length}개 문서) ===\n`);

  const results = [];

  for (const configPath of configFiles) {
    const name = getConfigName(configPath);
    const baselinePath = path.join(GOLDEN_DIR, `${name}.baseline.json`);

    // baseline 존재 확인
    if (!fs.existsSync(baselinePath)) {
      console.log(`[SKIP] ${name} — baseline 없음 (node tools/create-baselines.js 실행 필요)`);
      results.push({ name, status: 'SKIP', reason: 'no baseline' });
      continue;
    }

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

    console.log(`[TEST] ${name}`);

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
        results.push({ name, status: 'ERROR', reason: '출력 파일 없음' });
        continue;
      }

      // 2. 검증
      const validateOutput = execSync(
        `python -X utf8 tools/validate-docx.py "${outputPath}" --json`,
        { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe' }
      );

      const report = JSON.parse(validateOutput);
      const issues = report.issues || [];

      const current = {
        stats: {
          headings: report.stats?.headings || 0,
          headingsByLevel: report.stats?.headingsByLevel || {},
          bullets: report.stats?.bullets || 0,
          tables: report.stats?.tables || 0,
          codeBlocks: report.stats?.codeBlocks || 0,
          infoBoxes: report.stats?.infoBoxes || 0,
          images: report.stats?.images || 0,
          pageBreaks: report.stats?.pageBreaks || 0,
          estimatedPages: report.stats?.estimatedPages || 0,
        },
        warnCount: issues.filter(i => i.severity === 'WARN').length,
        infoCount: issues.filter(i => i.severity === 'INFO').length,
      };

      // 3. 비교
      const failures = compareBaseline(baseline, current);

      if (failures.length === 0) {
        console.log(`  [PASS] ${current.stats.estimatedPages}p, WARN ${current.warnCount}, INFO ${current.infoCount}`);
        results.push({ name, status: 'PASS' });
      } else {
        console.log(`  [FAIL] ${failures.length}건 불일치`);
        for (const f of failures) {
          console.log(`    - ${f.field}: ${f.diff}`);
        }
        results.push({ name, status: 'FAIL', failures });
      }

      if (verbose) {
        console.log(`  baseline: ${JSON.stringify(baseline.stats)}`);
        console.log(`  current:  ${JSON.stringify(current.stats)}`);
      }

    } catch (err) {
      console.log(`  [ERROR] ${err.message.split('\n')[0]}`);
      results.push({ name, status: 'ERROR', reason: err.message.split('\n')[0] });
    }
  }

  // 요약
  console.log('\n=== 요약 ===\n');

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const error = results.filter(r => r.status === 'ERROR').length;

  console.log('  문서                          결과');
  console.log('  ' + '─'.repeat(50));
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' :
                 r.status === 'FAIL' ? '✗' :
                 r.status === 'SKIP' ? '-' : '!';
    const detail = r.failures ? ` (${r.failures.length}건)` :
                   r.reason ? ` (${r.reason})` : '';
    console.log(`  ${icon} ${r.name.padEnd(30)} ${r.status}${detail}`);
  }

  console.log(`\n  PASS ${pass} | FAIL ${fail} | SKIP ${skip} | ERROR ${error} / 총 ${results.length}개`);

  // 임시 출력 디렉토리 정리
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }

  if (fail > 0 || error > 0) {
    console.log('\n[RESULT] FAIL — 회귀 발견됨');
    process.exit(1);
  } else {
    console.log('\n[RESULT] PASS — 모든 문서 정상');
    process.exit(0);
  }
}

main();

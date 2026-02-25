/**
 * score-docx.js — 문서 품질 점수 산출 CLI
 *
 * 사용법:
 *   node tools/score-docx.js doc-configs/api-spec.json           # 단일 점수
 *   node tools/score-docx.js doc-configs/api-spec.json --save     # 점수 + tests/scores/ 저장
 *   node tools/score-docx.js --batch                              # 전체 문서
 *   node tools/score-docx.js --batch --save                       # 전체 + 저장
 *   node tools/score-docx.js --batch --skip-convert               # 기존 DOCX 사용
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const scoring = require('../lib/scoring');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOC_CONFIGS_DIR = path.join(PROJECT_ROOT, 'doc-configs');
const SCORES_DIR = path.join(PROJECT_ROOT, 'tests', 'scores');

function getConfigName(configPath) {
  return path.basename(configPath, '.json');
}

function resolveOutputPath(config) {
  let outputFile = config.output;
  if (outputFile.includes('{version}')) {
    outputFile = outputFile.replace('{version}', config.docInfo?.version || 'v1.0');
  }
  return path.join(PROJECT_ROOT, outputFile);
}

function runValidate(outputPath) {
  try {
    const output = execSync(
      `python -X utf8 tools/validate-docx.py "${outputPath}" --json`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe' }
    );
    return JSON.parse(output);
  } catch (err) {
    return null;
  }
}

function runReview(outputPath, configPath) {
  try {
    const configArg = configPath ? ` --config "${configPath}"` : '';
    const output = execSync(
      `python -X utf8 tools/review-docx.py "${outputPath}"${configArg} --json`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe' }
    );
    return JSON.parse(output);
  } catch (err) {
    return null;
  }
}

function runConvert(configPath) {
  execSync(`node lib/convert.js "${configPath}"`, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

function scoreDocument(configPath, options = {}) {
  const name = getConfigName(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const outputPath = resolveOutputPath(config);

  // 변환 (skip-convert가 아니면)
  if (!options.skipConvert) {
    runConvert(configPath);
  }

  if (!fs.existsSync(outputPath)) {
    return { name, error: `출력 파일 없음: ${outputPath}` };
  }

  // 검증 실행
  const validateJson = runValidate(outputPath);
  const reviewJson = runReview(outputPath, configPath);

  if (!validateJson) {
    return { name, error: '레이아웃 검증 실패' };
  }

  // 점수 산출
  const contentResult = scoring.scoreContent(reviewJson);
  const layoutResult = scoring.scoreLayout(validateJson, reviewJson);
  const tableResult = scoring.scoreTable(reviewJson);
  const codeResult = scoring.scoreCode(reviewJson);
  const structureResult = scoring.scoreStructure(validateJson, reviewJson);

  const scores = {
    content: contentResult.score,
    layout: layoutResult.score,
    table: tableResult.score,
    code: codeResult.score,
    structure: structureResult.score,
  };
  scores.overall = scoring.computeOverall(scores);

  const deductions = {
    content: contentResult.deductions,
    layout: layoutResult.deductions,
    table: tableResult.deductions,
    code: codeResult.deductions,
    structure: structureResult.deductions,
  };

  const validateIssues = validateJson.issues || [];
  const reviewIssues = (reviewJson && reviewJson.issues) || [];

  const stats = {
    estimatedPages: validateJson.stats?.estimatedPages || 0,
    warnCount: validateIssues.filter(i => i.severity === 'WARN').length +
               reviewIssues.filter(i => i.severity === 'WARN').length,
    infoCount: validateIssues.filter(i => i.severity === 'INFO').length +
               reviewIssues.filter(i => i.severity === 'INFO').length,
    suggestCount: reviewIssues.filter(i => i.severity === 'SUGGEST').length,
  };

  return {
    docConfig: name,
    scoredAt: new Date().toISOString(),
    scores,
    deductions,
    stats,
  };
}

function saveScore(result) {
  if (!fs.existsSync(SCORES_DIR)) {
    fs.mkdirSync(SCORES_DIR, { recursive: true });
  }

  const scorePath = path.join(SCORES_DIR, `${result.docConfig}.scores.json`);

  let existing = { docConfig: result.docConfig, history: [] };
  if (fs.existsSync(scorePath)) {
    existing = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
  }

  const entry = {
    scoredAt: result.scoredAt.slice(0, 10),
    scores: result.scores,
    stats: result.stats,
    trigger: 'manual',
  };

  existing.history.push(entry);
  existing.latestOverall = result.scores.overall;

  // trend 계산
  if (existing.history.length >= 2) {
    const prev = existing.history[existing.history.length - 2].scores.overall;
    const curr = result.scores.overall;
    const delta = curr - prev;
    existing.trend = delta > 0.3 ? 'improving' : delta < -0.3 ? 'degrading' : 'stable';
  } else {
    existing.trend = 'stable';
  }

  fs.writeFileSync(scorePath, JSON.stringify(existing, null, 2), 'utf-8');
  return scorePath;
}

function printSingleResult(result) {
  if (result.error) {
    console.log(JSON.stringify({ docConfig: result.name, error: result.error }, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function printBatchSummary(results) {
  const valid = results.filter(r => !r.error);
  const errors = results.filter(r => r.error);

  console.log(`\n=== 품질 점수 (${results.length}개 문서) ===\n`);

  // 헤더
  const header = '  문서                           총점   Content Layout Table  Code  Structure';
  console.log(header);
  console.log('  ' + '─'.repeat(75));

  for (const r of valid) {
    const name = r.docConfig.padEnd(30);
    const overall = r.scores.overall.toFixed(1).padStart(5);
    const content = r.scores.content.toFixed(1).padStart(7);
    const layout = r.scores.layout.toFixed(1).padStart(7);
    const table = r.scores.table.toFixed(1).padStart(6);
    const code = r.scores.code.toFixed(1).padStart(6);
    const structure = r.scores.structure.toFixed(1).padStart(10);
    console.log(`  ${name} ${overall} ${content}${layout}${table}${code}${structure}`);
  }

  if (errors.length > 0) {
    console.log('');
    for (const r of errors) {
      console.log(`  [ERROR] ${r.name}: ${r.error}`);
    }
  }

  if (valid.length > 0) {
    const overalls = valid.map(r => r.scores.overall);
    const avg = overalls.reduce((a, b) => a + b, 0) / overalls.length;
    const min = Math.min(...overalls);
    const max = Math.max(...overalls);
    const minDoc = valid.find(r => r.scores.overall === min)?.docConfig;
    const maxDoc = valid.find(r => r.scores.overall === max)?.docConfig;

    console.log(`\n  평균: ${avg.toFixed(1)} | 최저: ${min.toFixed(1)} (${minDoc}) | 최고: ${max.toFixed(1)} (${maxDoc})`);
  }

  console.log(`\n  성공 ${valid.length} | 오류 ${errors.length} / 총 ${results.length}개`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('사용법:');
    console.log('  node tools/score-docx.js doc-configs/문서.json           # 단일 점수');
    console.log('  node tools/score-docx.js doc-configs/문서.json --save     # 점수 + 저장');
    console.log('  node tools/score-docx.js --batch                          # 전체 문서');
    console.log('  node tools/score-docx.js --batch --save                   # 전체 + 저장');
    console.log('  node tools/score-docx.js --batch --skip-convert           # 기존 DOCX 사용');
    process.exit(0);
  }

  const isBatch = args.includes('--batch');
  const doSave = args.includes('--save');
  const skipConvert = args.includes('--skip-convert');

  if (isBatch) {
    // 전체 doc-configs 처리
    const configFiles = fs.readdirSync(DOC_CONFIGS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(DOC_CONFIGS_DIR, f));

    if (configFiles.length === 0) {
      console.log('doc-configs/ 에 JSON 파일이 없습니다.');
      process.exit(0);
    }

    const results = [];

    for (const configPath of configFiles) {
      const name = getConfigName(configPath);
      process.stderr.write(`  채점: ${name}...`);

      try {
        const result = scoreDocument(configPath, { skipConvert });
        results.push(result);

        if (doSave && !result.error) {
          saveScore(result);
        }

        process.stderr.write(result.error ? ` ERROR\n` : ` ${result.scores.overall}\n`);
      } catch (err) {
        results.push({ name, error: err.message.split('\n')[0] });
        process.stderr.write(` ERROR\n`);
      }
    }

    printBatchSummary(results);

    if (doSave) {
      console.log(`\n  점수 저장: ${SCORES_DIR}/`);
    }
  } else {
    // 단일 문서
    const configPath = path.resolve(args.find(a => !a.startsWith('--')));

    if (!fs.existsSync(configPath)) {
      console.error(`[ERROR] 설정 파일을 찾을 수 없습니다: ${configPath}`);
      process.exit(1);
    }

    const result = scoreDocument(configPath, { skipConvert });
    printSingleResult(result);

    if (doSave && !result.error) {
      const scorePath = saveScore(result);
      process.stderr.write(`점수 저장: ${scorePath}\n`);
    }

    if (result.error) process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scoreDocument, runValidate, runReview, runConvert, resolveOutputPath, getConfigName };

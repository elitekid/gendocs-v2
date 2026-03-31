/**
 * experiment-v3.js — AI 개입 자가개선 검증 실험 (2-phase)
 *
 * v2와 달리 AI(Claude Code)가 직접 doc-config를 읽고 판단하여 수정하는 진짜 자가개선을 검증.
 * 20개 문서를 4배치(5개씩)로 처리. 배치마다 patterns.json/reflections.json 축적.
 *
 * 사용법:
 *   node tools/experiment-v3.js --cold-start                # 실험 초기화 (백업 + 리셋)
 *   node tools/experiment-v3.js --prep --batch 1            # Phase A: 배치 준비
 *   node tools/experiment-v3.js --finalize --batch 1        # Phase C: 배치 완료 (AI 수정 후)
 *   node tools/experiment-v3.js --report                    # 전체 리포트
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const scoring = require('../lib/scoring');
const { generateDocConfig } = require('./auto-docconfig');

// ── Constants ──

const PROJECT_ROOT = path.resolve(__dirname, '..');
const V3_DIR = path.join(PROJECT_ROOT, 'experiment', 'v3');
const CONFIGS_DIR = path.join(V3_DIR, 'configs');
const OUTPUT_DIR = path.join(V3_DIR, 'output');
const RESULTS_DIR = path.join(V3_DIR, 'results');
const SNAPSHOTS_DIR = path.join(V3_DIR, 'snapshots');
const BACKUP_DIR = path.join(V3_DIR, 'backup');
const MANIFEST_PATH = path.join(V3_DIR, 'manifest.json');
const PATTERNS_PATH = path.join(PROJECT_ROOT, 'lib', 'patterns.json');
const REFLECTIONS_PATH = path.join(PROJECT_ROOT, 'lib', 'reflections.json');

// ── Manifest: 20 docs in 4 batches ──

const BATCH_MANIFEST = [
  // Batch 1 (cold start)
  [
    { name: 'DQMS_인수인계_사항', docType: 'ops-guide' },
    { name: 'SLA_SLO_정의서', docType: 'policy-doc' },
    { name: 'Docker_컨테이너_보안_체크리스트', docType: 'security-doc' },
    { name: 'CICD_파이프라인_구축_가이드_v1.0', docType: 'ops-guide' },
    { name: '데이터_마이그레이션_계획서', docType: 'migration' },
  ],
  // Batch 2
  [
    { name: 'Elasticsearch_클러스터_운영_매뉴얼_v1.0', docType: 'ops-guide' },
    { name: '하이패스_수납이체_배치_연동_요건_정의서_v1.0', docType: 'batch-spec' },
    { name: 'Git_브랜칭_전략_가이드', docType: 'ops-guide' },
    { name: '모바일앱_보안_점검_체크리스트', docType: 'security-doc' },
    { name: '결제시스템_연동_가이드', docType: 'api-spec' },
  ],
  // Batch 3
  [
    { name: 'OWASP_웹보안_점검_가이드', docType: 'security-doc' },
    { name: 'AWS_Lambda_서버리스_아키텍처_설계서_v1.0', docType: 'architecture' },
    { name: 'Apache_Kafka_메시지_큐_운영_가이드', docType: 'ops-guide' },
    { name: 'React_컴포넌트_설계_가이드_v1.0', docType: 'architecture' },
    { name: '마이크로서비스_통신_패턴_가이드_v1.0', docType: 'architecture' },
  ],
  // Batch 4
  [
    { name: '우리은행_큐뱅_API_명세서', docType: 'api-spec' },
    { name: '유통물류일반관리', docType: 'ops-guide' },
    { name: 'Kafka_메시지_큐_운영_가이드', docType: 'ops-guide' },
    { name: 'OWASP_웹_보안_점검_가이드', docType: 'security-doc' },
    { name: '한국물류시장투자보고서', docType: 'report' },
  ],
];

// ── CLI parsing ──

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const isColdStart = args.includes('--cold-start');
const isPrep = args.includes('--prep');
const isFinalize = args.includes('--finalize');
const isReport = args.includes('--report');
const batchNum = parseInt(getArg('--batch') || '0', 10);

if (!isColdStart && !isPrep && !isFinalize && !isReport) {
  console.log('Usage:');
  console.log('  node tools/experiment-v3.js --cold-start');
  console.log('  node tools/experiment-v3.js --prep --batch N');
  console.log('  node tools/experiment-v3.js --finalize --batch N');
  console.log('  node tools/experiment-v3.js --report');
  process.exit(1);
}

if ((isPrep || isFinalize) && (batchNum < 1 || batchNum > 4)) {
  console.error('--batch must be 1..4');
  process.exit(1);
}

// ── Directory setup ──

function ensureDirs() {
  for (const dir of [CONFIGS_DIR, OUTPUT_DIR, RESULTS_DIR, SNAPSHOTS_DIR, BACKUP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Reused pipeline functions (from experiment-runner.js) ──

function runLint(mdPath) {
  try {
    const output = execSync(
      `python -X utf8 tools/lint-md.py "${mdPath}" --json`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 30000 }
    );
    return JSON.parse(output);
  } catch (err) {
    try {
      const combined = (err.stdout || '') + (err.stderr || '');
      const jsonMatch = combined.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (_) {}
    return null;
  }
}

function runConvert(configPath) {
  try {
    execSync(`node lib/convert.js "${configPath}"`, {
      cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 60000,
    });
    return true;
  } catch (err) {
    return false;
  }
}

function runValidate(outputPath) {
  try {
    const output = execSync(
      `python -X utf8 tools/validate-docx.py "${outputPath}" --json`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 30000 }
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
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 30000 }
    );
    return JSON.parse(output);
  } catch (err) {
    return null;
  }
}

function computeScores(validateJson, reviewJson) {
  if (!validateJson) return null;
  const scores = {
    content: scoring.scoreContent(reviewJson).score,
    layout: scoring.scoreLayout(validateJson).score,
    table: scoring.scoreTable(reviewJson).score,
    code: scoring.scoreCode(reviewJson).score,
    structure: scoring.scoreStructure(validateJson, reviewJson).score,
  };
  scores.overall = scoring.computeOverall(scores);
  return scores;
}

function resolveOutputPath(config) {
  let outputFile = config.output;
  if (outputFile.includes('{version}')) {
    outputFile = outputFile.replace('{version}', config.docInfo?.version || 'v1.0');
  }
  return path.join(PROJECT_ROOT, outputFile);
}

function flattenReviewIssues(reviewJson) {
  if (!reviewJson?.checks) return [];
  const issues = [];

  for (const [checkName, checkData] of Object.entries(reviewJson.checks)) {
    if (!checkData || typeof checkData !== 'object') continue;

    if (Array.isArray(checkData.issues)) {
      issues.push(...checkData.issues);
    }

    if (checkName === 'tableWidths' && Array.isArray(checkData.tables)) {
      for (const tbl of checkData.tables) {
        if (!Array.isArray(tbl.issues)) continue;
        const headerPattern = Array.isArray(tbl.headers) ? tbl.headers.join('|') : null;
        for (const issue of tbl.issues) {
          if (issue.type === 'WIDTH_IMBALANCE' && headerPattern) {
            issue.headerPattern = headerPattern;
          }
          if (issue.type === 'WIDTH_IMBALANCE' && !issue.suggestedWidths && tbl.suggestedWidths) {
            issue.suggestedWidths = tbl.suggestedWidths;
          }
          issues.push(issue);
        }
      }
    }
  }
  return issues;
}

function measurePatternHits(config) {
  if (config._meta && config._meta.sabotaged) {
    return {
      total: config._meta.totalTables || 0,
      common: config._meta.patternHits || 0,
      fallback: (config._meta.totalTables || 0) - (config._meta.patternHits || 0),
    };
  }
  const tw = config.tableWidths || {};
  return { total: Object.keys(tw).length, common: 0, fallback: Object.keys(tw).length };
}

function recordReflection(docName, outcome, fixedIssues, warnHistory) {
  try {
    const data = JSON.parse(fs.readFileSync(REFLECTIONS_PATH, 'utf-8'));
    const reflections = data.reflections || [];

    reflections.push({
      docName,
      outcome,
      issues: fixedIssues || [],
      warnHistory: warnHistory || null,
      timestamp: new Date().toISOString(),
    });

    // Size limit: 200
    if (reflections.length > 200) {
      const passIndices = reflections
        .map((r, i) => r.outcome === 'PASS' ? i : -1)
        .filter(i => i >= 0);
      while (reflections.length > 200 && passIndices.length > 0) {
        reflections.splice(passIndices.shift(), 1);
      }
    }

    data.reflections = reflections;
    data._lastUpdated = new Date().toISOString();
    fs.writeFileSync(REFLECTIONS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) {}
}

function extractExperimentPatterns() {
  try {
    execSync(`node tools/extract-patterns.js --dir "${CONFIGS_DIR}"`, {
      cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 60000,
    });
  } catch (err) {
    console.log(`  [WARN] Pattern extraction failed: ${err.message}`);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Cold start ──

function coldStart() {
  ensureDirs();

  console.log('\n=== Experiment v3: Cold Start ===\n');

  // Backup
  if (fs.existsSync(REFLECTIONS_PATH)) {
    fs.copyFileSync(REFLECTIONS_PATH, path.join(BACKUP_DIR, 'reflections.json'));
    console.log('  Backed up reflections.json');
  }
  if (fs.existsSync(PATTERNS_PATH)) {
    fs.copyFileSync(PATTERNS_PATH, path.join(BACKUP_DIR, 'patterns.json'));
    console.log('  Backed up patterns.json');
  }

  // Reset reflections
  const emptyReflections = {
    _version: 1,
    _description: "에피소딕 메모리: 문서 생성 교정 경험. Claude Code가 /gendocs 플로우에서 관리.",
    _lastUpdated: "",
    reflections: [],
  };
  fs.writeFileSync(REFLECTIONS_PATH, JSON.stringify(emptyReflections, null, 2), 'utf-8');
  console.log('  Reset reflections.json (empty)');

  // Reset patterns common (keep structure)
  try {
    const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8'));
    patterns.tableWidths.common = {};
    patterns.tableWidths.byDocType = {};
    patterns._provenance = null;
    fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), 'utf-8');
    console.log('  Reset patterns.json common/byDocType (empty)');
  } catch (_) {
    console.log('  [WARN] Could not reset patterns.json');
  }

  // Generate manifest
  const manifest = {
    version: 'v3',
    created: new Date().toISOString(),
    totalDocs: 20,
    batchSize: 5,
    batches: BATCH_MANIFEST.map((batch, i) => ({
      batch: i + 1,
      docs: batch.map(d => ({
        name: d.name,
        docType: d.docType,
        source: `source/${d.name}.md`,
      })),
    })),
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`  Created manifest.json (${manifest.totalDocs} docs, ${manifest.batches.length} batches)`);

  // Clean previous results
  for (let i = 1; i <= 4; i++) {
    const prepFile = path.join(RESULTS_DIR, `batch-${i}-prep.json`);
    const finalFile = path.join(RESULTS_DIR, `batch-${i}-final.json`);
    if (fs.existsSync(prepFile)) fs.unlinkSync(prepFile);
    if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
  }
  const reportFile = path.join(RESULTS_DIR, 'experiment-report.json');
  if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
  console.log('  Cleaned previous results');

  console.log('\nCold start complete. Run: node tools/experiment-v3.js --prep --batch 1');
}

// ── Phase A: Prep ──

function prep(batchIdx) {
  ensureDirs();

  const batch = BATCH_MANIFEST[batchIdx - 1];
  console.log(`\n=== Batch ${batchIdx} Prep (${batch.length} docs) ===\n`);

  const results = [];

  for (const doc of batch) {
    const mdPath = path.join(PROJECT_ROOT, 'source', `${doc.name}.md`);
    process.stdout.write(`  ${doc.name.substring(0, 50).padEnd(52)}... `);

    if (!fs.existsSync(mdPath)) {
      console.log('MISSING');
      results.push({ name: doc.name, docType: doc.docType, status: 'MISSING', error: 'source file not found' });
      continue;
    }

    const result = {
      name: doc.name,
      docType: doc.docType,
      status: null,
      configPath: null,
      outputPath: null,
      initialScores: null,
      issues: [],
      validateJson: null,
      reviewJson: null,
      patternHits: null,
      error: null,
    };

    try {
      // ① Generate sabotaged doc-config
      const relOutput = path.relative(PROJECT_ROOT, OUTPUT_DIR).replace(/\\/g, '/');
      const relConfig = path.relative(PROJECT_ROOT, CONFIGS_DIR).replace(/\\/g, '/');
      const { configPath, config } = generateDocConfig(mdPath, {
        sabotage: true,
        outputDir: relOutput,
        configDir: relConfig,
      });
      result.configPath = configPath;
      result.patternHits = measurePatternHits(config);

      // ② Lint
      const lintResult = runLint(mdPath);
      if (lintResult) {
        const criticals = (lintResult.issues || lintResult.checks || [])
          .filter(i => (i.severity || i.level) === 'CRITICAL');
        if (criticals.length > 0) {
          result.status = 'BROKEN';
          result.error = `lint CRITICAL: ${criticals.map(c => c.check || c.type || 'unknown').join(', ')}`;
          console.log(`BROKEN (lint)`);
          results.push(result);
          continue;
        }
      }

      // ③ Convert
      const outputPath = resolveOutputPath(config);
      result.outputPath = outputPath;

      const convertOk = runConvert(configPath);
      if (!convertOk) {
        result.status = 'BROKEN';
        result.error = 'convert failed';
        console.log('BROKEN (convert)');
        results.push(result);
        continue;
      }

      // ④ Validate
      const validateJson = runValidate(outputPath);
      result.validateJson = validateJson;

      // ⑤ Review
      const reviewJson = runReview(outputPath, configPath);
      result.reviewJson = reviewJson;

      // ⑥ Score
      const scores = computeScores(validateJson, reviewJson);
      result.initialScores = scores;

      // ⑦ Flatten issues for report
      const validateIssues = (validateJson?.issues || [])
        .filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');
      const reviewIssues = flattenReviewIssues(reviewJson)
        .filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');
      result.issues = [...validateIssues, ...reviewIssues];

      result.status = result.issues.length > 0 ? 'NEEDS_FIX' : 'PASS';
      const scoreStr = scores ? scores.overall.toFixed(1) : '-';
      console.log(`${result.status} (score: ${scoreStr}, issues: ${result.issues.length})`);

    } catch (err) {
      result.status = 'BROKEN';
      result.error = err.message;
      console.log(`BROKEN (${err.message.substring(0, 50)})`);
    }

    results.push(result);
  }

  // Save prep results (strip large JSON to keep file manageable)
  const savedResults = results.map(r => ({
    name: r.name,
    docType: r.docType,
    status: r.status,
    configPath: r.configPath,
    outputPath: r.outputPath,
    initialScores: r.initialScores,
    patternHits: r.patternHits,
    issues: r.issues.map(i => ({
      type: i.type || i.rule || 'unknown',
      severity: i.severity,
      headerPattern: i.headerPattern || null,
      suggestedWidths: i.suggestedWidths || null,
      message: i.message || i.detail || null,
      section: i.section || null,
      page: i.page || null,
    })),
    error: r.error,
  }));

  const prepData = {
    batch: batchIdx,
    timestamp: new Date().toISOString(),
    results: savedResults,
  };
  const prepPath = path.join(RESULTS_DIR, `batch-${batchIdx}-prep.json`);
  fs.writeFileSync(prepPath, JSON.stringify(prepData, null, 2), 'utf-8');

  // Print human-readable report
  printPrepReport(batchIdx, savedResults);
}

function printPrepReport(batchIdx, results) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Batch ${batchIdx} Prep Report`);
  console.log('='.repeat(60));

  let docsWithIssues = 0;
  let docsPass = 0;
  let docsBroken = 0;
  let totalPatternHits = 0;
  let totalTables = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const scoreStr = r.initialScores ? r.initialScores.overall.toFixed(1) : '-';
    console.log(`\n${i + 1}. ${r.name} (score: ${scoreStr}, ${r.docType})`);

    if (r.status === 'BROKEN') {
      console.log(`   [BROKEN] ${r.error}`);
      docsBroken++;
      continue;
    }

    if (r.patternHits) {
      totalPatternHits += r.patternHits.common;
      totalTables += r.patternHits.total;
    }

    const actionable = r.issues.filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');
    if (actionable.length === 0) {
      console.log('   No actionable issues.');
      docsPass++;
      continue;
    }

    docsWithIssues++;
    for (const issue of actionable) {
      const prefix = `[${issue.severity}]`;
      const type = issue.type;
      if (type === 'WIDTH_IMBALANCE' && issue.headerPattern) {
        console.log(`   ${prefix} ${type}: "${issue.headerPattern}"`);
        if (issue.suggestedWidths) {
          console.log(`     suggested: [${issue.suggestedWidths.join(', ')}]`);
        }
      } else if (issue.section) {
        console.log(`   ${prefix} ${type}: ${issue.section}${issue.page ? ` (p.${issue.page})` : ''}`);
      } else {
        console.log(`   ${prefix} ${type}${issue.message ? ': ' + issue.message.substring(0, 80) : ''}`);
      }
    }
    console.log(`   Config: ${r.configPath}`);
  }

  const hitRate = totalTables > 0 ? ((totalPatternHits / totalTables) * 100).toFixed(0) : '0';
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary: ${docsWithIssues} docs with WARN/SUGGEST, ${docsPass} PASS, ${docsBroken} BROKEN`);
  console.log(`Pattern hits: ${totalPatternHits}/${totalTables} tables (${hitRate}%)`);
  console.log(`\nNext: Review issues above, edit configs in experiment/v3/configs/`);
  console.log(`Then: node tools/experiment-v3.js --finalize --batch ${batchIdx}`);
  console.log('='.repeat(60));
}

// ── Phase C: Finalize ──

function finalize(batchIdx) {
  ensureDirs();

  const prepPath = path.join(RESULTS_DIR, `batch-${batchIdx}-prep.json`);
  if (!fs.existsSync(prepPath)) {
    console.error(`Prep results not found: ${prepPath}. Run --prep --batch ${batchIdx} first.`);
    process.exit(1);
  }

  const prepData = JSON.parse(fs.readFileSync(prepPath, 'utf-8'));
  console.log(`\n=== Batch ${batchIdx} Finalize ===\n`);

  const finalResults = [];

  for (const prepResult of prepData.results) {
    const { name, docType, configPath, outputPath, initialScores, issues } = prepResult;
    process.stdout.write(`  ${name.substring(0, 50).padEnd(52)}... `);

    if (prepResult.status === 'BROKEN' || prepResult.status === 'MISSING') {
      console.log(`${prepResult.status} (skipped)`);
      finalResults.push({
        name,
        docType,
        status: prepResult.status,
        initialScores,
        finalScores: null,
        improved: false,
        aiFixed: false,
        fixedIssues: [],
        error: prepResult.error,
      });
      continue;
    }

    // Check if config was modified after prep
    let configModified = false;
    if (configPath && fs.existsSync(configPath)) {
      const configStat = fs.statSync(configPath);
      const prepStat = fs.statSync(prepPath);
      configModified = configStat.mtimeMs > prepStat.mtimeMs;
    }

    const result = {
      name,
      docType,
      status: null,
      initialScores,
      finalScores: null,
      improved: false,
      aiFixed: configModified,
      fixedIssues: [],
      error: null,
    };

    if (!configModified) {
      // Not modified — keep prep results
      result.finalScores = initialScores;
      result.status = prepResult.status === 'PASS' ? 'PASS' : 'SKIP';
      console.log(`${result.status} (unchanged)`);

      // Record reflection even for unchanged docs
      const warnHistory = [issues.length];
      recordReflection(name, result.status === 'PASS' ? 'PASS' : 'SKIP', [], warnHistory);

      finalResults.push(result);
      continue;
    }

    // Config was modified — re-convert + re-validate
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const resolvedOutput = resolveOutputPath(config);

      // Re-convert
      const convertOk = runConvert(configPath);
      if (!convertOk) {
        result.status = 'BROKEN';
        result.error = 'reconvert failed';
        console.log('BROKEN (reconvert)');
        finalResults.push(result);
        continue;
      }

      // Re-validate + re-review + re-score
      const validateJson = runValidate(resolvedOutput);
      const reviewJson = runReview(resolvedOutput, configPath);
      const finalScores = computeScores(validateJson, reviewJson);
      result.finalScores = finalScores;

      // Compute remaining issues
      const validateIssues = (validateJson?.issues || [])
        .filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');
      const reviewIssues = flattenReviewIssues(reviewJson)
        .filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');
      const remainingIssues = [...validateIssues, ...reviewIssues];

      // Determine what was fixed
      const initialIssueTypes = new Set(issues.map(i => i.type));
      const finalIssueTypes = new Set(remainingIssues.map(i => i.type || i.rule || ''));
      result.fixedIssues = [...initialIssueTypes].filter(t => !finalIssueTypes.has(t));

      // Check improvement
      const initialScore = initialScores?.overall || 0;
      const finalScore = finalScores?.overall || 0;
      result.improved = finalScore > initialScore || remainingIssues.length < issues.length;

      if (remainingIssues.length === 0) {
        result.status = 'FIX';
      } else if (result.improved) {
        result.status = 'FIX';
      } else {
        result.status = 'SKIP';
      }

      const scoreStr = finalScores ? finalScores.overall.toFixed(1) : '-';
      const delta = initialScores && finalScores
        ? `${(finalScores.overall - initialScores.overall) >= 0 ? '+' : ''}${(finalScores.overall - initialScores.overall).toFixed(1)}`
        : '';
      console.log(`${result.status} (score: ${scoreStr} ${delta}, remaining: ${remainingIssues.length})`);

      // Record reflection
      const warnHistory = [issues.length, remainingIssues.length];
      recordReflection(name, result.status, result.fixedIssues.map(t => ({ type: t })), warnHistory);

    } catch (err) {
      result.status = 'BROKEN';
      result.error = err.message;
      console.log(`BROKEN (${err.message.substring(0, 50)})`);
    }

    finalResults.push(result);
  }

  // Extract patterns from experiment configs
  console.log('\n  Extracting patterns from experiment configs...');
  extractExperimentPatterns();

  // Save snapshot
  const snapshotDir = path.join(SNAPSHOTS_DIR, `batch-${batchIdx}`);
  fs.mkdirSync(snapshotDir, { recursive: true });
  if (fs.existsSync(PATTERNS_PATH)) {
    fs.copyFileSync(PATTERNS_PATH, path.join(snapshotDir, `batch-${batchIdx}-patterns.json`));
  }
  if (fs.existsSync(REFLECTIONS_PATH)) {
    fs.copyFileSync(REFLECTIONS_PATH, path.join(snapshotDir, `batch-${batchIdx}-reflections.json`));
  }

  // Count patterns
  let patternCount = 0;
  try {
    const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8'));
    patternCount = Object.keys(patterns.tableWidths?.common || {}).length;
  } catch (_) {}

  // Save final results
  const finalData = {
    batch: batchIdx,
    timestamp: new Date().toISOString(),
    results: finalResults,
    summary: computeFinalSummary(finalResults, patternCount),
  };
  const finalPath = path.join(RESULTS_DIR, `batch-${batchIdx}-final.json`);
  fs.writeFileSync(finalPath, JSON.stringify(finalData, null, 2), 'utf-8');

  // Print summary
  printFinalizeSummary(batchIdx, finalResults, patternCount);
}

function computeFinalSummary(results, patternCount) {
  const valid = results.filter(r => r.finalScores);
  const avgInitial = valid.length > 0
    ? valid.reduce((s, r) => s + (r.initialScores?.overall || 0), 0) / valid.length : 0;
  const avgFinal = valid.length > 0
    ? valid.reduce((s, r) => s + (r.finalScores?.overall || 0), 0) / valid.length : 0;
  const aiFixCount = results.filter(r => r.aiFixed).length;
  const improvedCount = results.filter(r => r.improved).length;

  return {
    avgInitialScore: round2(avgInitial),
    avgFinalScore: round2(avgFinal),
    aiFixCount,
    improvedCount,
    passCount: results.filter(r => r.status === 'PASS').length,
    fixCount: results.filter(r => r.status === 'FIX').length,
    skipCount: results.filter(r => r.status === 'SKIP').length,
    brokenCount: results.filter(r => r.status === 'BROKEN').length,
    patternCount,
  };
}

function printFinalizeSummary(batchIdx, results, patternCount) {
  const valid = results.filter(r => r.finalScores);
  const avgInitial = valid.length > 0
    ? valid.reduce((s, r) => s + (r.initialScores?.overall || 0), 0) / valid.length : 0;
  const avgFinal = valid.length > 0
    ? valid.reduce((s, r) => s + (r.finalScores?.overall || 0), 0) / valid.length : 0;
  const aiFixCount = results.filter(r => r.aiFixed).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Batch ${batchIdx} Final Summary`);
  console.log('='.repeat(60));
  console.log(`  Score: ${avgInitial.toFixed(1)} → ${avgFinal.toFixed(1)} (${avgFinal >= avgInitial ? '+' : ''}${(avgFinal - avgInitial).toFixed(2)})`);
  console.log(`  AI fixed: ${aiFixCount}/${results.length} docs`);
  console.log(`  Outcomes: PASS=${results.filter(r => r.status === 'PASS').length} FIX=${results.filter(r => r.status === 'FIX').length} SKIP=${results.filter(r => r.status === 'SKIP').length} BROKEN=${results.filter(r => r.status === 'BROKEN').length}`);
  console.log(`  Patterns DB: ${patternCount} common patterns`);

  let reflectionCount = 0;
  try {
    const data = JSON.parse(fs.readFileSync(REFLECTIONS_PATH, 'utf-8'));
    reflectionCount = (data.reflections || []).length;
  } catch (_) {}
  console.log(`  Reflections: ${reflectionCount} entries`);

  if (batchIdx < 4) {
    console.log(`\nNext: node tools/experiment-v3.js --prep --batch ${batchIdx + 1}`);
  } else {
    console.log(`\nAll batches done. Run: node tools/experiment-v3.js --report`);
  }
  console.log('='.repeat(60));
}

// ── Report ──

function generateReport() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  AI 개입 자가개선 실험 리포트 (v3)');
  console.log('='.repeat(60));

  const batchData = [];
  for (let i = 1; i <= 4; i++) {
    const finalPath = path.join(RESULTS_DIR, `batch-${i}-final.json`);
    if (!fs.existsSync(finalPath)) {
      console.log(`\n  [WARN] batch-${i}-final.json not found. Run finalize for batch ${i}.`);
      continue;
    }
    batchData.push(JSON.parse(fs.readFileSync(finalPath, 'utf-8')));
  }

  if (batchData.length === 0) {
    console.log('\n  No batch data found. Run prep + finalize for each batch first.');
    return;
  }

  // Get pattern hit rate from prep files
  const prepPatternHits = [];
  for (let i = 1; i <= 4; i++) {
    const prepPath = path.join(RESULTS_DIR, `batch-${i}-prep.json`);
    if (!fs.existsSync(prepPath)) { prepPatternHits.push(null); continue; }
    const prep = JSON.parse(fs.readFileSync(prepPath, 'utf-8'));
    let hits = 0, total = 0;
    for (const r of prep.results) {
      if (r.patternHits) {
        hits += r.patternHits.common;
        total += r.patternHits.total;
      }
    }
    prepPatternHits.push({ hits, total, rate: total > 0 ? hits / total : 0 });
  }

  console.log(`\n코퍼스: 20 docs, 4 batches × 5`);
  console.log(`방식: sabotaged config → AI 개입 수정 → 재검증\n`);

  console.log('학습 커브:');
  console.log('  Batch  Init   Final  AI fix  Patterns  Hit%');
  console.log('  ' + '─'.repeat(52));

  for (let i = 0; i < batchData.length; i++) {
    const bd = batchData[i];
    const s = bd.summary;
    const ptnHit = prepPatternHits[i];
    const hitPct = ptnHit ? (ptnHit.rate * 100).toFixed(0) : '-';
    console.log(
      `  ${String(bd.batch).padStart(5)}  ` +
      `${s.avgInitialScore.toFixed(1).padStart(5)} → ${s.avgFinalScore.toFixed(1).padStart(5)}  ` +
      `${String(s.aiFixCount).padStart(2)}/${bd.results.length}   ` +
      `${String(s.patternCount).padStart(4)}      ` +
      `${hitPct.padStart(3)}%`
    );
  }

  // Improvement analysis
  if (batchData.length >= 2) {
    const first = batchData[0].summary;
    const last = batchData[batchData.length - 1].summary;

    console.log('\n자가개선 증거:');

    // AI fix count trend
    const aiFixTrend = batchData.map(b => b.summary.aiFixCount);
    const aiFixDecreasing = aiFixTrend.length >= 2 && aiFixTrend[aiFixTrend.length - 1] <= aiFixTrend[0];
    console.log(`  ${aiFixDecreasing ? '✓' : '✗'} AI 수정 필요 문서 수: ${aiFixTrend.join(' → ')}`);

    // Initial score trend
    const initScoreTrend = batchData.map(b => b.summary.avgInitialScore.toFixed(1));
    const initScoreUp = batchData.length >= 2 &&
      batchData[batchData.length - 1].summary.avgInitialScore >= batchData[0].summary.avgInitialScore;
    console.log(`  ${initScoreUp ? '✓' : '✗'} 초기 점수 추이: ${initScoreTrend.join(' → ')}`);

    // Pattern hit rate trend
    const hitRates = prepPatternHits.filter(p => p !== null).map(p => (p.rate * 100).toFixed(0) + '%');
    const hitUp = prepPatternHits.filter(p => p !== null).length >= 2 &&
      prepPatternHits.filter(p => p !== null).pop().rate >=
      prepPatternHits.filter(p => p !== null)[0].rate;
    console.log(`  ${hitUp ? '✓' : '✗'} 패턴 히트율: ${hitRates.join(' → ')}`);

    // Pattern DB growth
    const patternTrend = batchData.map(b => b.summary.patternCount);
    console.log(`  ${patternTrend[patternTrend.length - 1] > patternTrend[0] ? '✓' : '✗'} 패턴 DB: ${patternTrend.join(' → ')}`);

    // Spearman correlation
    if (batchData.length >= 3) {
      const ranks = batchData.map((_, i) => i + 1);
      const initScores = batchData.map(b => b.summary.avgInitialScore);
      const rhoInit = spearmanRho(ranks, rankValues(initScores));
      const aiFixes = batchData.map(b => -b.summary.aiFixCount); // negative: lower is better
      const rhoFix = spearmanRho(ranks, rankValues(aiFixes));
      const ptnHits = prepPatternHits.filter(p => p !== null).map(p => p.rate);
      const rhoPattern = ptnHits.length >= 3
        ? spearmanRho(ranks.slice(0, ptnHits.length), rankValues(ptnHits)) : 0;

      console.log(`\n상관계수 (Spearman rho):`);
      console.log(`  초기 점수 추이:    rho = ${rhoInit.toFixed(3)} ${strengthLabel(rhoInit)}`);
      console.log(`  AI 수정 감소:      rho = ${rhoFix.toFixed(3)} ${strengthLabel(rhoFix)}`);
      console.log(`  패턴 학습:         rho = ${rhoPattern.toFixed(3)} ${strengthLabel(rhoPattern)}`);
    }
  }

  // Per-doc detail
  console.log('\n문서별 결과:');
  console.log('  Batch  Doc                                        Init  Final  AI fix');
  console.log('  ' + '─'.repeat(72));
  for (const bd of batchData) {
    for (const r of bd.results) {
      const initStr = r.initialScores ? r.initialScores.overall.toFixed(1) : '-';
      const finalStr = r.finalScores ? r.finalScores.overall.toFixed(1) : '-';
      const fixStr = r.aiFixed ? 'Y' : '-';
      console.log(
        `  ${String(bd.batch).padStart(5)}  ` +
        `${r.name.substring(0, 45).padEnd(47)} ` +
        `${initStr.padStart(5)} ${finalStr.padStart(6)}  ${fixStr.padStart(5)}`
      );
    }
  }

  // Save report
  const report = {
    version: 'v3',
    generated: new Date().toISOString(),
    batches: batchData.map(b => b.summary),
    prepPatternHits: prepPatternHits.map((p, i) => p ? { batch: i + 1, ...p } : null).filter(Boolean),
  };
  const reportPath = path.join(RESULTS_DIR, 'experiment-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nReport saved: ${reportPath}`);

  console.log('='.repeat(60));
}

// ── Spearman correlation (from experiment-runner.js) ──

function spearmanRho(x, y) {
  const n = x.length;
  if (n < 2) return 0;
  let d2sum = 0;
  for (let i = 0; i < n; i++) {
    d2sum += Math.pow(x[i] - y[i], 2);
  }
  return 1 - (6 * d2sum) / (n * (n * n - 1));
}

function rankValues(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) {
    ranks[sorted[i].i] = i + 1;
  }
  return ranks;
}

function strengthLabel(rho) {
  if (rho > 0.8) return '[STRONG]';
  if (rho > 0.6) return '[MODERATE]';
  if (rho > 0.3) return '[WEAK]';
  return '[NONE]';
}

// ── Main ──

function main() {
  if (isColdStart) {
    coldStart();
  } else if (isPrep) {
    prep(batchNum);
  } else if (isFinalize) {
    finalize(batchNum);
  } else if (isReport) {
    generateReport();
  }
}

main();

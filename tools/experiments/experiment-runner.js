/**
 * experiment-runner.js — 대규모 자가개선 검증 실험
 *
 * 사용법:
 *   node tools/experiment-runner.js                          # 코퍼스 실험
 *   node tools/experiment-runner.js --source-dir source --sabotage  # 기존 소스 + 사보타주
 *   node tools/experiment-runner.js --start-batch 5          # 배치 5부터 재개
 *   node tools/experiment-runner.js --single gh-001          # 단일 문서 디버그
 *   node tools/experiment-runner.js --no-learning            # 대조군 (학습 비활성화)
 *   node tools/experiment-runner.js --dry-run                # config만 생성, 변환 안 함
 *   node tools/experiment-runner.js --batch-size 12          # 배치당 문서 수 변경
 *   node tools/experiment-runner.js --max-docs 200           # 최대 문서 수 제한
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const scoring = require('../lib/scoring');
const { generateDocConfig } = require('./auto-docconfig');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(PROJECT_ROOT, 'test-sources', 'corpus');
const EXPERIMENT_DIR = path.join(PROJECT_ROOT, 'experiment');
const CONFIGS_DIR = path.join(EXPERIMENT_DIR, 'configs');
const OUTPUT_DIR = path.join(EXPERIMENT_DIR, 'output');
const RESULTS_DIR = path.join(EXPERIMENT_DIR, 'results');
const SNAPSHOTS_DIR = path.join(RESULTS_DIR, 'snapshots');
const LOGS_DIR = path.join(EXPERIMENT_DIR, 'logs');
const PATTERNS_PATH = path.join(PROJECT_ROOT, 'lib', 'patterns.json');
const REFLECTIONS_PATH = path.join(PROJECT_ROOT, 'lib', 'reflections.json');

// ── CLI parsing ──

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const startBatch = parseInt(getArg('--start-batch') || '1', 10);
const singleDoc = getArg('--single');
const noLearning = args.includes('--no-learning');
const dryRun = args.includes('--dry-run');
const sabotage = args.includes('--sabotage');
const sourceDir = getArg('--source-dir');
const batchSize = parseInt(getArg('--batch-size') || '100', 10);
const maxDocs = parseInt(getArg('--max-docs') || '10000', 10);
const MAX_FIX_ITERATIONS = 4;

// ── Helper functions ──

function ensureDirs() {
  for (const dir of [CONFIGS_DIR, OUTPUT_DIR, RESULTS_DIR, SNAPSHOTS_DIR, LOGS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Collect all MD files from corpus
 */
function collectCorpusFiles() {
  const files = [];
  const sources = ['github', 'wikipedia', 'arxiv', 'gutenberg'];

  for (const src of sources) {
    const dir = path.join(CORPUS_DIR, src);
    if (!fs.existsSync(dir)) continue;
    const mdFiles = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => ({ source: src, name: path.basename(f, '.md'), path: path.join(dir, f) }));
    files.push(...mdFiles);
  }

  return files;
}

/**
 * Collect MD files from a source directory (e.g., source/)
 */
function collectSourceDirFiles(dirPath) {
  const resolvedDir = path.resolve(PROJECT_ROOT, dirPath);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`Source directory not found: ${resolvedDir}`);
    process.exit(1);
  }
  return fs.readdirSync(resolvedDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({
      source: 'local',
      name: path.basename(f, '.md'),
      path: path.join(resolvedDir, f),
    }));
}

/**
 * Shuffle array (Fisher-Yates) with seed for reproducibility
 */
function shuffleWithSeed(arr, seed = 42) {
  const result = [...arr];
  let s = seed;
  function rand() {
    s = (s * 1664525 + 1013904223) & 0x7FFFFFFF;
    return s / 0x7FFFFFFF;
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Split into batches with balanced source distribution
 */
function createBatches(files, batchSize) {
  const shuffled = shuffleWithSeed(files);
  const batches = [];
  for (let i = 0; i < shuffled.length; i += batchSize) {
    batches.push(shuffled.slice(i, i + batchSize));
  }
  return batches;
}

// ── Validation/Review/Scoring ──

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
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60000,
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

  const contentResult = scoring.scoreContent(reviewJson);
  const layoutResult = scoring.scoreLayout(validateJson);
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

  return scores;
}

function resolveOutputPath(config) {
  let outputFile = config.output;
  if (outputFile.includes('{version}')) {
    outputFile = outputFile.replace('{version}', config.docInfo?.version || 'v1.0');
  }
  return path.join(PROJECT_ROOT, outputFile);
}

// ── Flatten review-docx issues (bug fix: issues are nested in checks) ──

/**
 * Extract all issues from review-docx's nested check structure.
 * Attaches headerPattern to WIDTH_IMBALANCE issues from parent table.
 */
function flattenReviewIssues(reviewJson) {
  if (!reviewJson?.checks) return [];
  const issues = [];

  for (const [checkName, checkData] of Object.entries(reviewJson.checks)) {
    if (!checkData || typeof checkData !== 'object') continue;

    // Direct issues in check (contentFidelity, tableReadability, codeIntegrity, pageDistribution, headingStructure)
    if (Array.isArray(checkData.issues)) {
      issues.push(...checkData.issues);
    }

    // Nested table issues in tableWidths.tables[].issues[]
    if (checkName === 'tableWidths' && Array.isArray(checkData.tables)) {
      for (const tbl of checkData.tables) {
        if (!Array.isArray(tbl.issues)) continue;
        const headerPattern = Array.isArray(tbl.headers) ? tbl.headers.join('|') : null;
        for (const issue of tbl.issues) {
          // Attach headerPattern for WIDTH_IMBALANCE auto-fixer
          if (issue.type === 'WIDTH_IMBALANCE' && headerPattern) {
            issue.headerPattern = headerPattern;
          }
          // Ensure suggestedWidths from table level is on the issue
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

// ── Auto-fix rules ──

const AUTO_FIX_RULES = {
  IMAGE_NEEDS_PAGE_BREAK: (config) => {
    if (!config.pageBreaks) config.pageBreaks = {};
    config.pageBreaks.imageH3AlwaysBreak = true;
    return true;
  },
  CONSECUTIVE_PAGE_BREAK: (config, issue) => {
    if (!config.pageBreaks) config.pageBreaks = {};
    if (!config.pageBreaks.noBreakH3Sections) config.pageBreaks.noBreakH3Sections = [];
    if (issue.section && !config.pageBreaks.noBreakH3Sections.includes(issue.section)) {
      config.pageBreaks.noBreakH3Sections.push(issue.section);
      return true;
    }
    return false;
  },
  WIDTH_IMBALANCE: (config, issue) => {
    if (issue.suggestedWidths && issue.headerPattern) {
      if (!config.tableWidths) config.tableWidths = {};
      config.tableWidths[issue.headerPattern] = issue.suggestedWidths;
      return true;
    }
    return false;
  },
};

function applyAutoFixes(config, validateJson, reviewJson) {
  let applied = 0;
  const fixedIssues = [];

  // Validate issues (top-level)
  const validateIssues = (validateJson?.issues || [])
    .filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');

  // Review issues (flattened from nested checks)
  const reviewIssues = flattenReviewIssues(reviewJson)
    .filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST');

  const allIssues = [...validateIssues, ...reviewIssues];

  for (const issue of allIssues) {
    const type = issue.type || issue.rule || '';
    const fixer = AUTO_FIX_RULES[type];
    if (fixer && fixer(config, issue)) {
      applied++;
      fixedIssues.push({ type, headerPattern: issue.headerPattern || null });
    }
  }

  return { applied, fixedIssues };
}

// ── Pattern/Reflection measurement ──

function measurePatternHits(config) {
  // Read pattern hits from config metadata (set by auto-docconfig --sabotage)
  if (config._meta && config._meta.sabotaged) {
    return {
      total: config._meta.totalTables || 0,
      common: config._meta.patternHits || 0,
      fallback: (config._meta.totalTables || 0) - (config._meta.patternHits || 0),
    };
  }

  // Fallback: count explicit tableWidths entries
  const tw = config.tableWidths || {};
  return { total: Object.keys(tw).length, common: 0, fallback: Object.keys(tw).length };
}

function measureReflectionHits(config) {
  // Read reflection hits from config metadata (set by auto-docconfig --sabotage)
  if (config._meta && config._meta.sabotaged) {
    return {
      matched: config._meta.reflectionHits || 0,
      total: 0,
    };
  }
  return { matched: 0, total: 0 };
}

// ── Reflection recording ──

function recordReflection(docName, outcome, fixedIssues, warnHistory) {
  if (noLearning) return;

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

    // Size limit: 200 entries
    if (reflections.length > 200) {
      // Remove oldest PASS entries first
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

// ── Single document processing ──

function processDocument(docFile) {
  const { name, path: mdPath } = docFile;
  const configPath = path.join(CONFIGS_DIR, `${name}.json`);

  const result = {
    name,
    source: docFile.source,
    outcome: null,
    scores: null,
    fixIterations: 0,
    patternHits: null,
    reflectionHits: null,
    fixedIssueTypes: [],
    error: null,
  };

  try {
    // ① Generate doc-config
    generateDocConfig(mdPath, {
      outputDir: path.relative(PROJECT_ROOT, OUTPUT_DIR).replace(/\\/g, '/'),
      configDir: path.relative(PROJECT_ROOT, CONFIGS_DIR).replace(/\\/g, '/'),
      sabotage: sabotage,
    });

    if (dryRun) {
      result.outcome = 'DRY_RUN';
      return result;
    }

    // ② Lint
    const lintResult = runLint(mdPath);
    if (lintResult) {
      const criticals = (lintResult.issues || lintResult.checks || [])
        .filter(i => (i.severity || i.level) === 'CRITICAL');
      if (criticals.length > 0) {
        result.outcome = 'BROKEN';
        result.error = `lint CRITICAL: ${criticals.length}`;
        return result;
      }
    }

    // ③ Convert
    let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const outputPath = resolveOutputPath(config);

    // Measure pattern/reflection hits from config generation
    result.patternHits = measurePatternHits(config);
    result.reflectionHits = measureReflectionHits(config);

    const convertOk = runConvert(configPath);
    if (!convertOk) {
      result.outcome = 'BROKEN';
      result.error = 'convert failed';
      return result;
    }

    // ④ Validate
    let validateJson = runValidate(outputPath);
    if (!validateJson) {
      result.outcome = 'BROKEN';
      result.error = 'validate failed';
      return result;
    }

    // ⑤ Review
    let reviewJson = runReview(outputPath, configPath);

    // ⑥ Initial scores
    let currentScores = computeScores(validateJson, reviewJson);

    // ⑦ Auto-fix loop
    const warnHistory = [];
    let currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    let currentValidate = validateJson;
    let currentReview = reviewJson;
    let bestConfig = JSON.stringify(currentConfig);
    let bestWarnCount = Infinity;
    let bestScores = currentScores;
    let allFixedIssues = [];

    const getWarnCount = (v, r) => {
      const vWarns = (v?.issues || []).filter(i => i.severity === 'WARN').length;
      const rWarns = flattenReviewIssues(r).filter(i => i.severity === 'WARN' || i.severity === 'SUGGEST').length;
      return vWarns + rWarns;
    };

    let warnCount = getWarnCount(currentValidate, currentReview);
    warnHistory.push(warnCount);

    if (warnCount < bestWarnCount) {
      bestWarnCount = warnCount;
      bestConfig = JSON.stringify(currentConfig);
      bestScores = currentScores;
    }

    if (warnCount === 0) {
      result.outcome = 'PASS';
      result.scores = currentScores;
      recordReflection(name, 'PASS', [], warnHistory);
      return result;
    }

    // FIX loop
    for (let iter = 0; iter < MAX_FIX_ITERATIONS; iter++) {
      const { applied, fixedIssues } = applyAutoFixes(currentConfig, currentValidate, currentReview);
      if (applied === 0) break;

      result.fixIterations++;
      allFixedIssues.push(...fixedIssues);

      // Save updated config
      fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf-8');

      // Re-convert
      const reConvertOk = runConvert(configPath);
      if (!reConvertOk) break;

      // Re-validate
      currentValidate = runValidate(outputPath);
      if (!currentValidate) break;

      currentReview = runReview(outputPath, configPath);
      currentScores = computeScores(currentValidate, currentReview);

      const newWarnCount = getWarnCount(currentValidate, currentReview);
      warnHistory.push(newWarnCount);

      // Check page growth (ROLLBACK)
      const initialPages = validateJson.stats?.estimatedPages || 0;
      const currentPages = currentValidate.stats?.estimatedPages || 0;
      if (initialPages > 0 && currentPages > initialPages * 1.1) {
        result.outcome = 'ROLLBACK';
        currentConfig = JSON.parse(bestConfig);
        fs.writeFileSync(configPath, bestConfig, 'utf-8');
        runConvert(configPath);
        result.scores = bestScores;
        recordReflection(name, 'ROLLBACK', allFixedIssues, warnHistory);
        return result;
      }

      if (newWarnCount < bestWarnCount) {
        bestWarnCount = newWarnCount;
        bestConfig = JSON.stringify(currentConfig);
        bestScores = currentScores;
      }

      if (newWarnCount === 0) {
        result.outcome = 'FIX';
        result.scores = currentScores;
        result.fixedIssueTypes = allFixedIssues.map(i => i.type);
        recordReflection(name, 'FIX', allFixedIssues, warnHistory);
        return result;
      }

      // Plateau detection (2 consecutive same warn count)
      if (warnHistory.length >= 3) {
        const last3 = warnHistory.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          result.outcome = 'STOP_PLATEAU';
          break;
        }
      }

      // Oscillation detection
      if (warnHistory.length >= 4) {
        const last4 = warnHistory.slice(-4);
        const d1 = last4[1] - last4[0];
        const d2 = last4[2] - last4[1];
        const d3 = last4[3] - last4[2];
        if ((d1 > 0 && d2 < 0 && d3 > 0) || (d1 < 0 && d2 > 0 && d3 < 0)) {
          result.outcome = 'STOP_OSCILLATION';
          break;
        }
      }
    }

    // Determine final outcome
    if (!result.outcome) {
      const finalWarnCount = warnHistory[warnHistory.length - 1];
      if (finalWarnCount === 0) {
        result.outcome = 'FIX';
      } else if (result.fixIterations >= MAX_FIX_ITERATIONS) {
        result.outcome = 'STOP_MAX';
      } else {
        result.outcome = 'SKIP';
      }
    }

    // Restore best config if early termination
    if (['STOP_PLATEAU', 'STOP_OSCILLATION', 'STOP_MAX'].includes(result.outcome)) {
      currentConfig = JSON.parse(bestConfig);
      fs.writeFileSync(configPath, bestConfig, 'utf-8');
      runConvert(configPath);
      result.scores = bestScores;
    } else {
      result.scores = currentScores;
    }

    result.fixedIssueTypes = allFixedIssues.map(i => i.type);
    recordReflection(name, result.outcome, allFixedIssues, warnHistory);
  } catch (err) {
    result.outcome = 'BROKEN';
    result.error = err.message;
  }

  return result;
}

// ── Batch metrics ──

function computeBatchMetrics(batchNum, results) {
  const valid = results.filter(r => r.scores && r.scores.overall);
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const passed = results.filter(r => r.outcome === 'PASS');
  const fixed = results.filter(r => r.outcome === 'FIX');
  const skipped = results.filter(r => r.outcome === 'SKIP');
  const rollbacked = results.filter(r => r.outcome === 'ROLLBACK');
  const plateau = results.filter(r => r.outcome === 'STOP_PLATEAU');
  const oscillation = results.filter(r => r.outcome === 'STOP_OSCILLATION');
  const stopMax = results.filter(r => r.outcome === 'STOP_MAX');

  const overallScores = valid.map(r => r.scores.overall).sort((a, b) => a - b);
  const avg = overallScores.length > 0 ? overallScores.reduce((a, b) => a + b, 0) / overallScores.length : 0;
  const median = overallScores.length > 0 ? overallScores[Math.floor(overallScores.length / 2)] : 0;
  const min = overallScores.length > 0 ? overallScores[0] : 0;
  const max = overallScores.length > 0 ? overallScores[overallScores.length - 1] : 0;

  const totalFix = results.reduce((sum, r) => sum + (r.fixIterations || 0), 0);
  const nonBroken = results.filter(r => r.outcome !== 'BROKEN').length;

  // Pattern hit rate: % of docs where at least one table header matched patterns.json
  const docsWithTables = results.filter(r => r.patternHits && r.patternHits.total > 0);
  const patternHitRate = docsWithTables.length > 0
    ? docsWithTables.filter(r => r.patternHits.common > 0).length / docsWithTables.length
    : 0;

  // Average pattern coverage: % of tables that hit patterns within docs that have tables
  let avgPatternCoverage = 0;
  if (docsWithTables.length > 0) {
    const coverages = docsWithTables.map(r => r.patternHits.common / r.patternHits.total);
    avgPatternCoverage = coverages.reduce((a, b) => a + b, 0) / coverages.length;
  }

  // Reflection hit rate
  const reflectionHitDocs = results.filter(r => r.reflectionHits);
  const reflectionHitRate = reflectionHitDocs.length > 0
    ? reflectionHitDocs.filter(r => r.reflectionHits.matched > 0).length / reflectionHitDocs.length
    : 0;

  // Health categories
  const health = { EXCELLENT: 0, GOOD: 0, NEEDS_FIX: 0, BROKEN: broken.length };
  for (const r of valid) {
    if (r.scores.overall >= 9.5) health.EXCELLENT++;
    else if (r.scores.overall >= 8.0) health.GOOD++;
    else health.NEEDS_FIX++;
  }

  // Count reflections and patterns
  let newReflections = 0;
  try {
    const data = JSON.parse(fs.readFileSync(REFLECTIONS_PATH, 'utf-8'));
    newReflections = (data.reflections || []).length;
  } catch (_) {}

  let totalPatterns = 0;
  try {
    const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8'));
    totalPatterns = Object.keys(patterns.tableWidths?.common || {}).length;
  } catch (_) {}

  // Issue type distribution
  const issueTypes = {};
  for (const r of results) {
    for (const t of (r.fixedIssueTypes || [])) {
      issueTypes[t] = (issueTypes[t] || 0) + 1;
    }
  }

  return {
    batch: batchNum,
    docCount: results.length,
    scores: {
      overall: { avg: round2(avg), median: round2(median), min: round2(min), max: round2(max) },
    },
    firstPassRate: round2(nonBroken > 0 ? passed.length / nonBroken : 0),
    avgFixIterations: round2(nonBroken > 0 ? totalFix / nonBroken : 0),
    patternHitRate: round2(patternHitRate),
    avgPatternCoverage: round2(avgPatternCoverage),
    reflectionHitRate: round2(reflectionHitRate),
    health,
    newReflections,
    totalPatterns,
    issueTypes,
    outcomes: {
      PASS: passed.length,
      FIX: fixed.length,
      SKIP: skipped.length,
      ROLLBACK: rollbacked.length,
      STOP_PLATEAU: plateau.length,
      STOP_OSCILLATION: oscillation.length,
      STOP_MAX: stopMax.length,
      BROKEN: broken.length,
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Snapshot ──

function saveSnapshot(batchNum) {
  const snapshotDir = path.join(SNAPSHOTS_DIR, `batch-${String(batchNum).padStart(3, '0')}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  if (fs.existsSync(REFLECTIONS_PATH)) {
    fs.copyFileSync(REFLECTIONS_PATH, path.join(snapshotDir, 'reflections.json'));
  }
  if (fs.existsSync(PATTERNS_PATH)) {
    fs.copyFileSync(PATTERNS_PATH, path.join(snapshotDir, 'patterns.json'));
  }
}

// ── Cold start ──

function coldStart() {
  console.log('  Cold start: backing up and resetting reflections/patterns...');

  const backupDir = path.join(EXPERIMENT_DIR, 'backup-pre-experiment');
  fs.mkdirSync(backupDir, { recursive: true });

  if (fs.existsSync(REFLECTIONS_PATH)) {
    fs.copyFileSync(REFLECTIONS_PATH, path.join(backupDir, 'reflections.json'));
  }
  if (fs.existsSync(PATTERNS_PATH)) {
    fs.copyFileSync(PATTERNS_PATH, path.join(backupDir, 'patterns.json'));
  }

  // Reset reflections
  const emptyReflections = {
    _version: 1,
    _description: "에피소딕 메모리: 문서 생성 교정 경험. Claude Code가 /gendocs 플로우에서 관리.",
    _lastUpdated: "",
    reflections: [],
  };
  fs.writeFileSync(REFLECTIONS_PATH, JSON.stringify(emptyReflections, null, 2), 'utf-8');

  // Reset patterns common (keep structure)
  try {
    const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8'));
    patterns.tableWidths.common = {};
    patterns.tableWidths.byDocType = {};
    patterns._provenance = null;
    fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), 'utf-8');
  } catch (_) {}
}

// ── Extract patterns for experiment ──

function extractExperimentPatterns() {
  if (noLearning) return;

  try {
    execSync(`node tools/extract-patterns.js --dir "${CONFIGS_DIR}"`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (err) {
    console.log(`  [WARN] Pattern extraction failed: ${err.message}`);
  }
}

// ── Learning curve report ──

function generateReport(batchMetrics) {
  console.log('\n' + '='.repeat(60));
  console.log('  Self-Improvement Experiment Report');
  console.log('='.repeat(60));

  const totalDocs = batchMetrics.reduce((sum, b) => sum + b.docCount, 0);
  console.log(`\nCorpus: ${totalDocs} docs | Mode: ${noLearning ? 'CONTROL (no learning)' : 'LEARNING'}${sabotage ? ' + SABOTAGE' : ''}`);

  console.log('\nLearning Curve (Overall Score + Metrics):');
  console.log('  Batch  Score  PASS%  Fix/doc  PtnHit%  RefHit%  Patterns  FIX  BROKEN');
  console.log('  ' + '-'.repeat(75));
  for (const m of batchMetrics) {
    const passRate = (m.firstPassRate * 100).toFixed(0);
    const patternRate = (m.patternHitRate * 100).toFixed(0);
    const reflectionRate = (m.reflectionHitRate * 100).toFixed(0);
    console.log(
      `  ${String(m.batch).padStart(5)}  ${m.scores.overall.avg.toFixed(1).padStart(5)}  ` +
      `${passRate.padStart(4)}%  ${m.avgFixIterations.toFixed(2).padStart(7)}  ` +
      `${patternRate.padStart(6)}%  ${reflectionRate.padStart(6)}%  ` +
      `${String(m.totalPatterns).padStart(8)}  ${String(m.outcomes.FIX).padStart(3)}  ${String(m.outcomes.BROKEN).padStart(6)}`
    );
  }

  // Improvement summary
  if (batchMetrics.length >= 2) {
    const first = batchMetrics[0];
    const last = batchMetrics[batchMetrics.length - 1];
    const scoreDelta = last.scores.overall.avg - first.scores.overall.avg;
    const passDelta = (last.firstPassRate - first.firstPassRate) * 100;
    const fixDelta = last.avgFixIterations - first.avgFixIterations;
    const patternDelta = (last.patternHitRate - first.patternHitRate) * 100;

    console.log(`\nImprovement (batch 1 → ${last.batch}):`);
    console.log(`  Score:        ${first.scores.overall.avg.toFixed(1)} → ${last.scores.overall.avg.toFixed(1)} (${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(2)})`);
    console.log(`  PASS rate:    ${(first.firstPassRate * 100).toFixed(0)}% → ${(last.firstPassRate * 100).toFixed(0)}% (${passDelta >= 0 ? '+' : ''}${passDelta.toFixed(0)}pp)`);
    console.log(`  Fix/doc:      ${first.avgFixIterations.toFixed(2)} → ${last.avgFixIterations.toFixed(2)} (${fixDelta >= 0 ? '+' : ''}${fixDelta.toFixed(2)})`);
    console.log(`  Pattern hits: ${(first.patternHitRate * 100).toFixed(0)}% → ${(last.patternHitRate * 100).toFixed(0)}% (${patternDelta >= 0 ? '+' : ''}${patternDelta.toFixed(0)}pp)`);
    console.log(`  Patterns DB:  ${first.totalPatterns} → ${last.totalPatterns}`);

    // Spearman rank correlation for score trend
    const ranks = batchMetrics.map((_, i) => i + 1);
    const scoreRanks = batchMetrics.map(m => m.scores.overall.avg);
    const passRanks = batchMetrics.map(m => m.firstPassRate);
    const fixRanks = batchMetrics.map(m => -m.avgFixIterations); // negative: lower is better
    const patternRanks = batchMetrics.map(m => m.patternHitRate);

    console.log(`\nSelf-Improvement Evidence:`);
    const rhoScore = spearmanRho(ranks, rankValues(scoreRanks));
    const rhoPass = spearmanRho(ranks, rankValues(passRanks));
    const rhoFix = spearmanRho(ranks, rankValues(fixRanks));
    const rhoPattern = spearmanRho(ranks, rankValues(patternRanks));

    console.log(`  Score trend:       rho = ${rhoScore.toFixed(3)} ${strengthLabel(rhoScore)}`);
    console.log(`  PASS rate trend:   rho = ${rhoPass.toFixed(3)} ${strengthLabel(rhoPass)}`);
    console.log(`  Fix reduction:     rho = ${rhoFix.toFixed(3)} ${strengthLabel(rhoFix)}`);
    console.log(`  Pattern learning:  rho = ${rhoPattern.toFixed(3)} ${strengthLabel(rhoPattern)}`);

    // Overall verdict
    const strongCount = [rhoScore, rhoPass, rhoFix, rhoPattern].filter(r => r > 0.7).length;
    const modCount = [rhoScore, rhoPass, rhoFix, rhoPattern].filter(r => r > 0.5 && r <= 0.7).length;
    if (strongCount >= 3) console.log('\n  VERDICT: STRONG self-improvement evidence');
    else if (strongCount >= 1 || modCount >= 2) console.log('\n  VERDICT: MODERATE self-improvement evidence');
    else console.log('\n  VERDICT: WEAK or no self-improvement evidence');
  }

  // Outcome distribution
  console.log('\nOutcome Distribution:');
  const totals = {};
  for (const m of batchMetrics) {
    for (const [k, v] of Object.entries(m.outcomes)) {
      totals[k] = (totals[k] || 0) + v;
    }
  }
  for (const [k, v] of Object.entries(totals)) {
    if (v > 0) console.log(`  ${k}: ${v}`);
  }

  // Issue type distribution
  const allIssueTypes = {};
  for (const m of batchMetrics) {
    for (const [k, v] of Object.entries(m.issueTypes || {})) {
      allIssueTypes[k] = (allIssueTypes[k] || 0) + v;
    }
  }
  if (Object.keys(allIssueTypes).length > 0) {
    console.log('\nFixed Issue Types:');
    for (const [k, v] of Object.entries(allIssueTypes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

function strengthLabel(rho) {
  if (rho > 0.8) return '[STRONG]';
  if (rho > 0.6) return '[MODERATE]';
  if (rho > 0.3) return '[WEAK]';
  return '[NONE]';
}

function rankValues(arr) {
  const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) {
    ranks[sorted[i].i] = i + 1;
  }
  return ranks;
}

function spearmanRho(x, y) {
  const n = x.length;
  if (n < 2) return 0;
  let d2sum = 0;
  for (let i = 0; i < n; i++) {
    d2sum += Math.pow(x[i] - y[i], 2);
  }
  return 1 - (6 * d2sum) / (n * (n * n - 1));
}

// ── Main ──

async function main() {
  ensureDirs();

  console.log('\n=== Self-Improvement Experiment ===\n');
  console.log(`Mode: ${noLearning ? 'CONTROL (no learning)' : 'LEARNING'}${sabotage ? ' + SABOTAGE' : ''}`);
  console.log(`Source: ${sourceDir ? sourceDir : 'corpus'}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Batch size: ${batchSize}`);

  // Collect files
  const allFiles = sourceDir ? collectSourceDirFiles(sourceDir) : collectCorpusFiles();
  if (allFiles.length === 0) {
    console.error(`No MD files found in ${sourceDir || 'test-sources/corpus/'}. ${sourceDir ? '' : 'Run collect-corpus.js first.'}`);
    process.exit(1);
  }

  const effectiveFiles = allFiles.slice(0, maxDocs);
  console.log(`Files: ${effectiveFiles.length} (${allFiles.length} available, max ${maxDocs})`);

  // Single document mode
  if (singleDoc) {
    const docFile = effectiveFiles.find(f => f.name === singleDoc);
    if (!docFile) {
      console.error(`Document not found: ${singleDoc}`);
      process.exit(1);
    }

    console.log(`\nProcessing single document: ${singleDoc}`);
    const result = processDocument(docFile);
    console.log(`\nResult: ${JSON.stringify(result, null, 2)}`);
    return;
  }

  // Create batches
  const batches = createBatches(effectiveFiles, batchSize);
  console.log(`Batches: ${batches.length} (${batchSize} docs each)\n`);

  // Cold start (only for batch 1 in learning mode)
  if (startBatch === 1 && !noLearning) {
    coldStart();
  }

  const allBatchMetrics = [];

  // Load existing results for resume
  if (startBatch > 1) {
    for (let b = 1; b < startBatch; b++) {
      const batchFile = path.join(RESULTS_DIR, `batch-${String(b).padStart(3, '0')}.json`);
      if (fs.existsSync(batchFile)) {
        const data = JSON.parse(fs.readFileSync(batchFile, 'utf-8'));
        allBatchMetrics.push(data.metrics);
      }
    }
  }

  const experimentStart = Date.now();

  // Process batches
  for (let b = startBatch; b <= batches.length; b++) {
    const batch = batches[b - 1];
    if (!batch) break;

    const batchStart = Date.now();
    console.log(`\n--- Batch ${b}/${batches.length} (${batch.length} docs) ---\n`);

    const batchResults = [];
    let processed = 0;

    for (const docFile of batch) {
      processed++;
      const pct = ((processed / batch.length) * 100).toFixed(0);
      process.stdout.write(`  [${pct}%] ${docFile.name.substring(0, 40).padEnd(42)}... `);

      const result = processDocument(docFile);
      batchResults.push(result);

      const scoreStr = result.scores ? result.scores.overall.toFixed(1) : '-';
      const fixStr = result.fixIterations > 0 ? ` fix:${result.fixIterations}` : '';
      console.log(`${result.outcome} (${scoreStr}${fixStr})`);
    }

    // Extract patterns after batch
    if (!dryRun) {
      extractExperimentPatterns();
    }

    // Compute batch metrics
    const metrics = computeBatchMetrics(b, batchResults);
    allBatchMetrics.push(metrics);

    // Save batch results
    const batchFile = path.join(RESULTS_DIR, `batch-${String(b).padStart(3, '0')}.json`);
    fs.writeFileSync(batchFile, JSON.stringify({ metrics, results: batchResults }, null, 2), 'utf-8');

    // Snapshot
    saveSnapshot(b);

    const batchElapsed = ((Date.now() - batchStart) / 1000).toFixed(0);
    console.log(`\n  Batch ${b} summary: avg=${metrics.scores.overall.avg.toFixed(1)}, PASS=${metrics.outcomes.PASS}, FIX=${metrics.outcomes.FIX}, BROKEN=${metrics.outcomes.BROKEN}, patterns=${metrics.totalPatterns} (${batchElapsed}s)`);
  }

  // Generate final report
  generateReport(allBatchMetrics);

  // Save experiment report
  const reportPath = path.join(RESULTS_DIR, 'experiment-report.json');
  const totalElapsed = ((Date.now() - experimentStart) / 1000).toFixed(0);

  const report = {
    mode: noLearning ? 'control' : 'learning',
    sabotage,
    sourceDir: sourceDir || 'corpus',
    totalDocs: effectiveFiles.length,
    batchSize,
    totalBatches: batches.length,
    elapsedSeconds: parseInt(totalElapsed),
    batches: allBatchMetrics,
    generated: new Date().toISOString(),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nReport saved: ${reportPath}`);
  console.log(`Total elapsed: ${totalElapsed}s`);
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});

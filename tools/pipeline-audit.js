/**
 * pipeline-audit.js — 파이프라인 진단 모드
 *
 * MD→config→변환→DOCX 전체 체인을 5단계로 진단하고 근본 원인을 매핑한다.
 *
 * 사용법:
 *   node tools/pipeline-audit.js doc-configs/문서.json              # 단일 진단
 *   node tools/pipeline-audit.js doc-configs/문서.json --json       # JSON 출력
 *   node tools/pipeline-audit.js doc-configs/문서.json --skip-convert  # 기존 DOCX 사용
 *   node tools/pipeline-audit.js --batch                            # 전체 진단
 *   node tools/pipeline-audit.js --batch --json                     # 전체 JSON
 *   node tools/pipeline-audit.js --batch --skip-convert             # 전체, 기존 DOCX
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { scoreDocument, runValidate, runReview, resolveOutputPath, getConfigName } = require('./score-docx');
const scoring = require('../lib/scoring');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DOC_CONFIGS_DIR = path.join(PROJECT_ROOT, 'doc-configs');

// ============================================================
// 근본 원인 매핑 테이블
// ============================================================

const ROOT_CAUSE_MAP = {
  // lint-md 이슈
  codeBlockBalance:  { layer: 'source', fix: 'source MD — 코드블록 닫기' },
  nestedBullet:      { layer: 'source', fix: 'source MD — 중첩 불릿을 테이블/플랫 불릿으로' },
  imageReference:    { layer: 'source', fix: 'source MD — 이미지 파일 경로 확인' },
  tableColumnCount:  { layer: 'source', fix: 'source MD — 테이블 분할 또는 컬럼 축소' },
  metadata:          { layer: 'source', fix: 'source MD — 메타데이터 블록쿼트 보완' },
  separator:         { layer: 'source', fix: 'source MD — H2 위 --- 추가' },
  changeHistory:     { layer: 'source', fix: 'source MD — v1.0 "초안 작성" 준수' },
  codeLanguageTag:   { layer: 'source', fix: 'source MD — 올바른 언어 태그 사용' },
  tocConsistency:    { layer: 'source', fix: 'source MD — 목차-본문 일치 수정' },
  htmlArtifact:      { layer: 'source', fix: 'source MD — HTML 태그 제거' },
  sectionBalance:    { layer: 'source', fix: 'source MD — 섹션 분량 조정 (참고용)' },

  // validate-docx 이슈
  IMAGE_NEEDS_PAGE_BREAK: { layer: 'config', fix: 'doc-config pageBreaks — imageH3AlwaysBreak 또는 h3Sections' },
  ORPHAN_HEADING:         { layer: 'info',   fix: '시뮬레이션 추정치, 실제 확인 필요' },
  TABLE_SPLIT:            { layer: 'info',   fix: '시뮬레이션 추정치, 실제 확인 필요' },
  HEADING_LEVEL_SKIP:     { layer: 'source', fix: 'source MD — heading level 순서 수정' },
  CONSECUTIVE_PAGE_BREAK: { layer: 'config', fix: 'doc-config pageBreaks — 중복 break 제거' },

  // review-docx 이슈
  CONTENT_MISSING:   { layer: 'source|config', fix: 'source MD 요소 확인 → 있으면 config, 없으면 source' },
  CONTENT_EXTRA:     { layer: 'converter',     fix: 'converter-core.js 파싱 로직 확인' },
  WIDTH_IMBALANCE:   { layer: 'config',        fix: 'doc-config tableWidths — 너비 재분배' },
  WIDE_WASTE:        { layer: 'config',        fix: 'doc-config tableWidths — 활용도 낮은 컬럼 축소' },
  TRUNCATED_JSON:    { layer: 'source',        fix: 'source MD — JSON 코드블록 완성도 확인' },
  EMPTY_CODE:        { layer: 'source',        fix: 'source MD — 빈 코드블록 제거/채우기' },
  DUPLICATE_HEADING: { layer: 'source',        fix: 'source MD — 중복 제목 수정' },
  LONG_SECTION:      { layer: 'source',        fix: 'source MD — 긴 섹션 분할 (참고용)' },
  TOO_MANY_COLUMNS:  { layer: 'source',        fix: 'source MD — 테이블 컬럼 축소' },
  CELL_OVERFLOW:     { layer: 'config',        fix: 'doc-config tableWidths — 셀 너비 확대' },
  EMPTY_COLUMN:      { layer: 'source',        fix: 'source MD — 빈 컬럼 제거' },
  SPARSE_PAGE:       { layer: 'info',          fix: '페이지 활용도 낮음 (표지 등 의도적일 수 있음)' },
};

// ============================================================
// 파이프라인 단계 실행 함수
// ============================================================

function runLint(mdPath) {
  try {
    const output = execSync(
      `python -X utf8 tools/lint-md.py "${mdPath}" --json`,
      { cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe' }
    );
    return JSON.parse(output);
  } catch (err) {
    return null;
  }
}

// ============================================================
// 근본 원인 분석
// ============================================================

function mapRootCauses(stages) {
  const causes = { source: [], config: [], converter: [], info: [] };

  // lint 이슈
  if (stages.lint && stages.lint.issues) {
    for (const issue of stages.lint.issues) {
      const mapping = ROOT_CAUSE_MAP[issue.check];
      if (mapping) {
        const layers = mapping.layer.split('|');
        const primaryLayer = layers[0];
        if (causes[primaryLayer]) {
          causes[primaryLayer].push({
            stage: 'lint',
            issue: issue.check,
            severity: issue.severity,
            fix: mapping.fix,
            detail: issue.message,
          });
        }
      }
    }
  }

  // validate 이슈
  if (stages.validate && stages.validate.issues) {
    for (const issue of stages.validate.issues) {
      const type = issue.type || issue.rule;
      const mapping = ROOT_CAUSE_MAP[type];
      if (mapping) {
        const layers = mapping.layer.split('|');
        const primaryLayer = layers[0];
        if (causes[primaryLayer]) {
          causes[primaryLayer].push({
            stage: 'validate',
            issue: type,
            severity: issue.severity,
            fix: mapping.fix,
            detail: issue.message,
          });
        }
      }
    }
  }

  // review 이슈
  if (stages.review && stages.review.issues) {
    for (const issue of stages.review.issues) {
      const type = issue.type;
      const mapping = ROOT_CAUSE_MAP[type];
      if (mapping) {
        const layers = mapping.layer.split('|');
        const primaryLayer = layers[0];
        if (causes[primaryLayer]) {
          causes[primaryLayer].push({
            stage: 'review',
            issue: type,
            severity: issue.severity,
            fix: mapping.fix,
            detail: issue.message,
          });
        }
      }
    }
  }

  return causes;
}

// ============================================================
// Health 판정
// ============================================================

function classifyHealth(stages) {
  // BROKEN: lint CRITICAL > 0 또는 convert 실패
  if (stages.lint) {
    const criticals = (stages.lint.summary && stages.lint.summary.CRITICAL) || 0;
    if (criticals > 0) return 'BROKEN';
  }
  if (stages.convert && stages.convert.error) return 'BROKEN';

  // 점수 기반 판정
  const score = stages.score ? stages.score.scores.overall : null;
  const totalWarn = countWarn(stages);

  if (score === null) return 'NEEDS_FIX';

  // EXCELLENT: score 9.5+, totalWarn === 0
  if (score >= 9.5 && totalWarn === 0) return 'EXCELLENT';

  // GOOD: score 8.0~9.4, totalWarn ≤ 2
  if (score >= 8.0 && totalWarn <= 2) return 'GOOD';

  // NEEDS_FIX: score < 8.0 또는 totalWarn > 2
  return 'NEEDS_FIX';
}

function countWarn(stages) {
  let total = 0;
  if (stages.validate && stages.validate.issues) {
    total += stages.validate.issues.filter(i => i.severity === 'WARN').length;
  }
  if (stages.review && stages.review.issues) {
    total += stages.review.issues.filter(i => i.severity === 'WARN').length;
  }
  return total;
}

function countCritical(stages) {
  if (stages.lint && stages.lint.summary && stages.lint.summary.CRITICAL) {
    return stages.lint.summary.CRITICAL;
  }
  return 0;
}

// ============================================================
// Actionable 수정 제안 생성
// ============================================================

function buildActionable(rootCauses) {
  const items = [];
  let priority = 1;

  // WARN/CRITICAL을 우선, INFO는 나중에
  const severityOrder = { CRITICAL: 0, WARN: 1, SUGGEST: 2, MINOR: 3, STYLE: 4, INFO: 5 };

  const allCauses = [
    ...rootCauses.source,
    ...rootCauses.config,
    ...rootCauses.converter,
  ];

  allCauses.sort((a, b) => {
    const sa = severityOrder[a.severity] ?? 99;
    const sb = severityOrder[b.severity] ?? 99;
    return sa - sb;
  });

  for (const cause of allCauses) {
    items.push({
      priority: priority++,
      layer: cause.stage === 'lint' ? 'source' : (ROOT_CAUSE_MAP[cause.issue]?.layer.split('|')[0] || 'unknown'),
      issue: cause.issue,
      severity: cause.severity,
      fix: cause.fix,
    });
  }

  return items;
}

// ============================================================
// 단일 문서 진단
// ============================================================

function auditDocument(configPath, options = {}) {
  const name = getConfigName(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const sourcePath = path.join(PROJECT_ROOT, config.source);
  const outputPath = resolveOutputPath(config);

  const stages = {};

  // ① lint-md
  if (fs.existsSync(sourcePath)) {
    stages.lint = runLint(sourcePath);
  } else {
    stages.lint = { error: `소스 파일 없음: ${config.source}`, issues: [], summary: {} };
  }

  // lint CRITICAL이면 convert 스킵
  const lintCritical = stages.lint && stages.lint.summary && stages.lint.summary.CRITICAL > 0;

  // ② convert
  if (lintCritical) {
    stages.convert = { skipped: true, reason: 'lint CRITICAL 존재' };
  } else {
    try {
      if (!options.skipConvert) {
        execSync(`node lib/convert.js "${configPath}"`, {
          cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: 'pipe',
        });
      }
      if (fs.existsSync(outputPath)) {
        stages.convert = { success: true, output: outputPath };
      } else {
        stages.convert = { error: `출력 파일 없음: ${outputPath}` };
      }
    } catch (err) {
      stages.convert = { error: err.message.split('\n')[0] };
    }
  }

  // ③ validate
  if (stages.convert && stages.convert.success) {
    stages.validate = runValidate(outputPath);
    if (!stages.validate) {
      stages.validate = { error: '레이아웃 검증 실패', issues: [], stats: {} };
    }
  } else {
    stages.validate = { skipped: true, issues: [], stats: {} };
  }

  // ④ review
  if (stages.convert && stages.convert.success) {
    stages.review = runReview(outputPath, configPath);
    if (!stages.review) {
      stages.review = { error: 'AI 셀프리뷰 실패', issues: [] };
    }
  } else {
    stages.review = { skipped: true, issues: [] };
  }

  // ⑤ score
  if (stages.convert && stages.convert.success && stages.validate && !stages.validate.error) {
    const contentResult = scoring.scoreContent(stages.review);
    const layoutResult = scoring.scoreLayout(stages.validate, stages.review);
    const tableResult = scoring.scoreTable(stages.review);
    const codeResult = scoring.scoreCode(stages.review);
    const structureResult = scoring.scoreStructure(stages.validate, stages.review);

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

    stages.score = { scores, deductions };
  } else {
    stages.score = { skipped: true };
  }

  // 근본 원인 매핑
  const rootCauses = mapRootCauses(stages);

  // Health 판정
  const health = classifyHealth(stages);

  // 수정 제안
  const actionable = buildActionable(rootCauses);

  const totalWarn = countWarn(stages);
  const totalCritical = countCritical(stages);

  return {
    docConfig: name,
    auditedAt: new Date().toISOString(),
    source: config.source,
    output: config.output,
    stages,
    rootCauses: {
      source: rootCauses.source.length,
      config: rootCauses.config.length,
      converter: rootCauses.converter.length,
      info: rootCauses.info.length,
    },
    rootCauseDetails: rootCauses,
    health,
    totalWarn,
    totalCritical,
    actionable,
  };
}

// ============================================================
// 배치 진단
// ============================================================

function auditBatch(options) {
  const configFiles = fs.readdirSync(DOC_CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DOC_CONFIGS_DIR, f));

  if (configFiles.length === 0) {
    console.log('doc-configs/ 에 JSON 파일이 없습니다.');
    return [];
  }

  const results = [];

  for (const configPath of configFiles) {
    const name = getConfigName(configPath);
    process.stderr.write(`  진단: ${name}...`);

    try {
      const result = auditDocument(configPath, options);
      results.push(result);
      process.stderr.write(` ${result.health}\n`);
    } catch (err) {
      results.push({ docConfig: name, health: 'BROKEN', error: err.message.split('\n')[0] });
      process.stderr.write(` ERROR\n`);
    }
  }

  return results;
}

// ============================================================
// 출력 포맷
// ============================================================

const HEALTH_ICON = { EXCELLENT: '★', GOOD: '✓', NEEDS_FIX: '⚠', BROKEN: '✗' };

function printSingleText(result) {
  if (result.error) {
    console.log(`\n=== 파이프라인 진단: ${result.docConfig} ===\n`);
    console.log(`  [ERROR] ${result.error}`);
    return;
  }

  console.log(`\n=== 파이프라인 진단: ${result.docConfig} ===\n`);

  const s = result.stages;

  // ① lint
  if (s.lint) {
    if (s.lint.error) {
      console.log(`  ① MD 린트        ✗ ${s.lint.error}`);
    } else {
      const criticals = (s.lint.summary && s.lint.summary.CRITICAL) || 0;
      const warns = (s.lint.summary && s.lint.summary.WARN) || 0;
      const minors = (s.lint.summary && s.lint.summary.MINOR) || 0;
      const total = criticals + warns + minors;
      if (total === 0) {
        console.log(`  ① MD 린트        ✓ PASS`);
      } else {
        const parts = [];
        if (criticals > 0) parts.push(`CRITICAL ${criticals}건`);
        if (warns > 0) parts.push(`WARN ${warns}건`);
        if (minors > 0) parts.push(`MINOR ${minors}건`);
        const icon = criticals > 0 ? '✗' : '⚠';
        console.log(`  ① MD 린트        ${icon} ${parts.join(', ')}`);
      }
    }
  }

  // ② convert
  if (s.convert) {
    if (s.convert.skipped) {
      console.log(`  ② 변환           — 스킵 (${s.convert.reason})`);
    } else if (s.convert.error) {
      console.log(`  ② 변환           ✗ 실패`);
    } else {
      const pages = s.validate && s.validate.stats ? `${s.validate.stats.estimatedPages || '?'}p` : '';
      console.log(`  ② 변환           ✓ 성공 (${pages})`);
    }
  }

  // ③ validate
  if (s.validate && !s.validate.skipped) {
    if (s.validate.error) {
      console.log(`  ③ 레이아웃 검증   ✗ 실패`);
    } else {
      const warns = (s.validate.issues || []).filter(i => i.severity === 'WARN').length;
      const infos = (s.validate.issues || []).filter(i => i.severity === 'INFO').length;
      if (warns === 0 && infos === 0) {
        console.log(`  ③ 레이아웃 검증   ✓ PASS`);
      } else {
        const parts = [];
        if (warns > 0) parts.push(`WARN ${warns}건`);
        if (infos > 0) parts.push(`INFO ${infos}건`);
        const icon = warns > 0 ? '⚠' : '✓';
        console.log(`  ③ 레이아웃 검증   ${icon} ${parts.join(', ')}`);
      }
    }
  } else if (s.validate && s.validate.skipped) {
    console.log(`  ③ 레이아웃 검증   — 스킵`);
  }

  // ④ review
  if (s.review && !s.review.skipped) {
    if (s.review.error) {
      console.log(`  ④ AI 셀프리뷰     ✗ 실패`);
    } else {
      const warns = (s.review.issues || []).filter(i => i.severity === 'WARN').length;
      const suggests = (s.review.issues || []).filter(i => i.severity === 'SUGGEST').length;
      if (warns === 0 && suggests === 0) {
        console.log(`  ④ AI 셀프리뷰     ✓ PASS`);
      } else {
        const parts = [];
        if (warns > 0) parts.push(`WARN ${warns}건`);
        if (suggests > 0) parts.push(`SUGGEST ${suggests}건`);
        const icon = warns > 0 ? '⚠' : '✓';
        console.log(`  ④ AI 셀프리뷰     ${icon} ${parts.join(', ')}`);
      }
    }
  } else if (s.review && s.review.skipped) {
    console.log(`  ④ AI 셀프리뷰     — 스킵`);
  }

  // ⑤ score
  if (s.score && !s.score.skipped) {
    console.log(`  ⑤ 품질 점수       ${s.score.scores.overall.toFixed(1)} / 10.0`);
  } else {
    console.log(`  ⑤ 품질 점수       — 스킵`);
  }

  // 종합
  const icon = HEALTH_ICON[result.health] || '?';
  const scoreTxt = s.score && s.score.scores ? `, 점수 ${s.score.scores.overall.toFixed(1)}` : '';
  console.log(`\n  종합: ${icon} ${result.health} — WARN ${result.totalWarn}건${scoreTxt}`);

  // 수정 제안
  if (result.actionable.length > 0) {
    console.log(`\n  수정 제안:`);
    for (const a of result.actionable) {
      console.log(`    ${a.priority}. [${a.layer}] ${a.fix} — ${a.issue}`);
    }
  }

  console.log('');
}

function printSingleJson(result) {
  // rootCauseDetails 제거 (JSON에는 rootCauses 카운트만)
  const output = { ...result };
  delete output.rootCauseDetails;
  console.log(JSON.stringify(output, null, 2));
}

function printBatchText(results) {
  const healthCounts = { EXCELLENT: 0, GOOD: 0, NEEDS_FIX: 0, BROKEN: 0 };
  const issueFreq = {};
  let totalScore = 0;
  let scoredCount = 0;

  for (const r of results) {
    healthCounts[r.health] = (healthCounts[r.health] || 0) + 1;
    if (r.stages && r.stages.score && r.stages.score.scores) {
      totalScore += r.stages.score.scores.overall;
      scoredCount++;
    }
    if (r.actionable) {
      for (const a of r.actionable) {
        const key = `${a.issue} (${a.layer})`;
        issueFreq[key] = (issueFreq[key] || 0) + 1;
      }
    }
  }

  const total = results.length;
  const avgScore = scoredCount > 0 ? (totalScore / scoredCount).toFixed(1) : 'N/A';

  // 근본 원인 집계
  let totalSourceCauses = 0;
  let totalConfigCauses = 0;
  for (const r of results) {
    if (r.rootCauses) {
      totalSourceCauses += r.rootCauses.source;
      totalConfigCauses += r.rootCauses.config;
    }
  }

  console.log(`\n=== 파이프라인 진단 (${total}개 문서) ===\n`);

  const pct = (n) => total > 0 ? `${Math.round(n / total * 100)}%` : '0%';
  console.log(`  EXCELLENT: ${healthCounts.EXCELLENT}건 (${pct(healthCounts.EXCELLENT)})  |  GOOD: ${healthCounts.GOOD}건 (${pct(healthCounts.GOOD)})  |  NEEDS_FIX: ${healthCounts.NEEDS_FIX}건 (${pct(healthCounts.NEEDS_FIX)})  |  BROKEN: ${healthCounts.BROKEN}건 (${pct(healthCounts.BROKEN)})`);
  console.log(`  평균 점수: ${avgScore}  |  근본 원인: source ${totalSourceCauses}건, config ${totalConfigCauses}건`);

  // 상위 이슈
  const sorted = Object.entries(issueFreq).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`\n  상위 이슈:`);
    const top = sorted.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      console.log(`    ${i + 1}. ${top[i][0]} — ${top[i][1]}건`);
    }
  }

  // NEEDS_FIX / BROKEN 문서 목록
  const problemDocs = results.filter(r => r.health === 'NEEDS_FIX' || r.health === 'BROKEN');
  if (problemDocs.length > 0) {
    console.log(`\n  주의 필요 문서:`);
    for (const r of problemDocs) {
      const scoreTxt = r.stages && r.stages.score && r.stages.score.scores
        ? ` (${r.stages.score.scores.overall.toFixed(1)}점)`
        : '';
      console.log(`    [${r.health}] ${r.docConfig}${scoreTxt}`);
    }
  }

  console.log('');
}

function printBatchJson(results) {
  const output = results.map(r => {
    const o = { ...r };
    delete o.rootCauseDetails;
    return o;
  });
  console.log(JSON.stringify(output, null, 2));
}

// ============================================================
// main
// ============================================================

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('사용법:');
    console.log('  node tools/pipeline-audit.js doc-configs/문서.json              # 단일 진단');
    console.log('  node tools/pipeline-audit.js doc-configs/문서.json --json       # JSON 출력');
    console.log('  node tools/pipeline-audit.js doc-configs/문서.json --skip-convert  # 기존 DOCX');
    console.log('  node tools/pipeline-audit.js --batch                            # 전체 진단');
    console.log('  node tools/pipeline-audit.js --batch --json                     # 전체 JSON');
    console.log('  node tools/pipeline-audit.js --batch --skip-convert             # 전체, 기존 DOCX');
    process.exit(0);
  }

  const isBatch = args.includes('--batch');
  const isJson = args.includes('--json');
  const skipConvert = args.includes('--skip-convert');
  const options = { skipConvert };

  if (isBatch) {
    const results = auditBatch(options);
    if (isJson) {
      printBatchJson(results);
    } else {
      printBatchText(results);
    }
  } else {
    const configPath = path.resolve(args.find(a => !a.startsWith('--')));

    if (!fs.existsSync(configPath)) {
      console.error(`[ERROR] 설정 파일을 찾을 수 없습니다: ${configPath}`);
      process.exit(1);
    }

    const result = auditDocument(configPath, options);

    if (isJson) {
      printSingleJson(result);
    } else {
      printSingleText(result);
    }

    if (result.health === 'BROKEN') process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { auditDocument, auditBatch, classifyHealth, mapRootCauses, ROOT_CAUSE_MAP };

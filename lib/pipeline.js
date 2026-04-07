/**
 * lib/pipeline.js — 변환→검증→수정 자가개선 오케스트레이터
 *
 * buildAndSave → validate-docx.py → fix-rules → 재변환 루프.
 * suggestion 있는 WARN만 자동 수정. 나머지는 NEEDS_MANUAL로 반환.
 *
 * 사용법:
 *   const pipeline = require('./pipeline');
 *   const result = await pipeline.run(config, baseDir, { maxIterations: 4 });
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const core = require('./converter-core');
const { apply, filterFixable } = require('./fix/fix-rules');
const { record } = require('./fix/reflections-writer');

/**
 * @param {Object} config - doc-config JSON
 * @param {string} baseDir - 프로젝트 루트
 * @param {Object} [opts]
 * @param {number} [opts.maxIterations=4]
 * @param {boolean} [opts.visualVerify=false]
 * @param {Array} [opts.previousWarns] - 이전 NEEDS_MANUAL 실행의 최종 warns
 * @param {string} [opts.configPath] - doc-config 파일 경로 (fix-rules 저장용)
 * @returns {Promise<PipelineResult>}
 */
async function run(config, baseDir, opts = {}) {
  const maxIterations = opts.maxIterations || 4;
  const configPath = opts.configPath || null;
  const allFixApplied = [];
  const warnHistory = [];
  let outputPath = null;
  let pageCountBaseline = null;

  // 이전 NEEDS_MANUAL 연결용
  const warnsBefore = opts.previousWarns || null;

  for (let iter = 0; iter <= maxIterations; iter++) {
    // 1. 변환
    const buildResult = await core.buildAndSave(config, baseDir);
    outputPath = buildResult.outputPath;

    // 2. 검증
    const warns = _runValidate(outputPath, baseDir);
    const warnCount = warns.filter(w => w.severity === 'WARN').length;
    warnHistory.push(warnCount);

    // 페이지 수 추적
    const pageCount = _getPageCount(outputPath, baseDir);
    if (iter === 0) pageCountBaseline = pageCount;

    // 3. WARN 0 → PASS
    if (warnCount === 0) {
      _recordResult(config, 'PASS', allFixApplied, warnsBefore, warns);
      return { status: 'PASS', outputPath, iterations: iter, warns, fixApplied: allFixApplied };
    }

    // 4. 조기 종료 판정
    if (warnHistory.length >= 2 && warnHistory[warnHistory.length - 1] === warnHistory[warnHistory.length - 2]) {
      _recordResult(config, 'STOP_PLATEAU', allFixApplied, warnsBefore, warns);
      return { status: 'STOP_PLATEAU', outputPath, iterations: iter, warns, fixApplied: allFixApplied };
    }
    if (warnHistory.length >= 3 && warnHistory[warnHistory.length - 1] === warnHistory[warnHistory.length - 3]) {
      _recordResult(config, 'STOP_OSCILLATION', allFixApplied, warnsBefore, warns);
      return { status: 'STOP_OSCILLATION', outputPath, iterations: iter, warns, fixApplied: allFixApplied };
    }
    if (pageCount && pageCountBaseline && pageCount > pageCountBaseline * 1.1) {
      _recordResult(config, 'ROLLBACK', allFixApplied, warnsBefore, warns);
      return { status: 'ROLLBACK', outputPath, iterations: iter, warns, fixApplied: allFixApplied };
    }

    // 5. fixable 분리
    const fixable = filterFixable(warns);
    if (fixable.length === 0) {
      // 자동 수정 불가 → NEEDS_MANUAL
      _recordResult(config, 'NEEDS_MANUAL', allFixApplied, warnsBefore, warns);
      return { status: 'NEEDS_MANUAL', outputPath, iterations: iter, warns, fixApplied: allFixApplied };
    }

    // 6. 자동 수정
    const { applied } = apply(configPath, config, fixable);
    allFixApplied.push(...applied);

    if (applied.length === 0) {
      _recordResult(config, 'NEEDS_MANUAL', allFixApplied, warnsBefore, warns);
      return { status: 'NEEDS_MANUAL', outputPath, iterations: iter, warns, fixApplied: allFixApplied };
    }

    // 7. 다음 반복으로 (재변환)
  }

  // maxIterations 소진
  const finalWarns = _runValidate(outputPath, baseDir);
  const status = finalWarns.filter(w => w.severity === 'WARN').length === 0 ? 'PASS' : 'FIX';
  _recordResult(config, status, allFixApplied, warnsBefore, finalWarns);
  return { status, outputPath, iterations: maxIterations, warns: finalWarns, fixApplied: allFixApplied };
}

// ═══════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════

function _runValidate(outputPath, baseDir) {
  try {
    const cmd = `python -X utf8 tools/validate-docx.py "${outputPath}" --json`;
    const output = execSync(cmd, { cwd: baseDir, encoding: 'utf-8' });
    const report = JSON.parse(output);
    return report.issues || [];
  } catch {
    return [];
  }
}

function _getPageCount(outputPath, baseDir) {
  try {
    const cmd = `python -X utf8 tools/validate-docx.py "${outputPath}" --json`;
    const output = execSync(cmd, { cwd: baseDir, encoding: 'utf-8' });
    const report = JSON.parse(output);
    return report.stats?.estimatedPages || null;
  } catch {
    return null;
  }
}

function _recordResult(config, status, fixApplied, warnsBefore, warnsAfter) {
  try {
    const docName = config.docInfo?.title || path.basename(config.source || '', '.md');
    record({
      docName,
      docType: config._docType || 'general',
      status,
      fixApplied,
      warnsBefore: warnsBefore || warnsAfter,
      warnsAfter,
    });
  } catch {
    // reflections 기록 실패는 무시
  }
}

module.exports = { run };

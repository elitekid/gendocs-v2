/**
 * lib/fix/reflections-writer.js — 원칙 추출 + reflections.json 기록
 *
 * pipeline 실행 결과를 분석하여 reflections.json에 evidence를 추가한다.
 * 새 lesson 생성은 Claude Code가 담당 (이 모듈은 evidence 누적만).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REFLECTIONS_PATH = path.join(__dirname, '..', 'reflections.json');

/**
 * 변환 결과를 분석하여 reflections.json에 기록
 * @param {Object} opts
 * @param {string} opts.docName
 * @param {string} [opts.docType]
 * @param {string} opts.status - PASS/FIX/NEEDS_MANUAL/STOP_PLATEAU/...
 * @param {Array} opts.fixApplied - 적용된 수정 목록
 * @param {Array} opts.warnsBefore - 수정 전 WARN
 * @param {Array} opts.warnsAfter - 수정 후 WARN
 */
function record(opts) {
  const data = _load();

  // FIX가 적용된 경우, 관련 lesson의 evidence에 추가
  if (opts.fixApplied && opts.fixApplied.length > 0) {
    for (const fix of opts.fixApplied) {
      const lesson = _findOrCreateLesson(data, fix.code, opts.docType);
      lesson.evidence.push({
        date: new Date().toISOString().split('T')[0],
        docName: opts.docName,
        warnBefore: (opts.warnsBefore || []).length,
        warnAfter: (opts.warnsAfter || []).length,
        verifierResult: opts.status === 'PASS' ? 'PASS' : 'PARTIAL',
        fix: { field: fix.field, before: fix.before, after: fix.after },
      });
      lesson.evidenceCount = lesson.evidence.length;
      lesson.lastSeen = new Date().toISOString().split('T')[0];
      lesson.confidence = _calcConfidence(lesson);
    }
  }

  // PASS (수정 없이)인 경우도 기록
  if (opts.status === 'PASS' && (!opts.fixApplied || opts.fixApplied.length === 0)) {
    // 수정 없이 PASS → 기존 lesson에 positive evidence
    // lesson이 없으면 기록 안 함 (원칙 추출은 Claude Code 담당)
  }

  data._lastUpdated = new Date().toISOString();
  _save(data);
}

/**
 * 특정 code에 해당하는 lesson을 찾거나, 없으면 빈 lesson 생성
 */
function _findOrCreateLesson(data, code, docType) {
  let lesson = data.lessons.find(l => l.id === `auto-${code}`);
  if (!lesson) {
    lesson = {
      id: `auto-${code}`,
      principle: `${code} 자동 수정`,
      trigger: code,
      antiPattern: '',
      correctApproach: '',
      confidence: 0.5,
      evidenceCount: 0,
      firstSeen: new Date().toISOString().split('T')[0],
      lastSeen: new Date().toISOString().split('T')[0],
      docType: docType || 'general',
      evidence: [],
    };
    data.lessons.push(lesson);
  }
  return lesson;
}

/**
 * confidence 자동 계산
 * evidenceCount 1→0.5, 2→0.7, 3→0.85, 5+→1.0
 * PASS 비율 < 100% → 감점
 */
function _calcConfidence(lesson) {
  const n = lesson.evidenceCount;
  let base;
  if (n <= 1) base = 0.5;
  else if (n === 2) base = 0.7;
  else if (n <= 4) base = 0.85;
  else base = 1.0;

  // PASS 비율 감점
  const passCount = lesson.evidence.filter(e => e.verifierResult === 'PASS').length;
  const passRate = n > 0 ? passCount / n : 1;
  return Math.round(base * passRate * 100) / 100;
}

function _load() {
  try {
    return JSON.parse(fs.readFileSync(REFLECTIONS_PATH, 'utf-8'));
  } catch {
    return { _version: 2, lessons: [] };
  }
}

function _save(data) {
  fs.writeFileSync(REFLECTIONS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { record, _calcConfidence };

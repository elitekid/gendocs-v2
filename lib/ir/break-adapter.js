/**
 * lib/ir/break-adapter.js — doc-config pageBreaks → breakRules[] 변환
 *
 * 기존 doc-config의 pageBreaks 객체를 IR breakRules 배열로 변환한다.
 * Phase 4에서 doc-config가 native breakRules를 직접 기술하면 이 어댑터는 제거된다.
 */
'use strict';

const { breakRule } = require('./schema');

/**
 * doc-config의 pageBreaks 객체를 breakRules[] 배열로 변환
 * @param {Object} pageBreaks - doc-config.pageBreaks
 * @returns {{ rules: BreakRule[], h2StopIndex: number|null }}
 */
function convertPageBreaksToRules(pageBreaks = {}) {
  const rules = [];
  const h2Sections = pageBreaks.h2Sections || [];
  const h3Sections = pageBreaks.h3Sections || [];
  const noBreakH3 = pageBreaks.noBreakH3Sections || [];

  // ── H2 규칙 ──
  // h2Sections가 있으면 명시적 목록만 사용 (afterChangeHistory, h2BreakBeforeSection 무시)
  if (h2Sections.length > 0) {
    for (const title of h2Sections) {
      rules.push(breakRule(
        { type: 'heading', level: 2, textMatch: _escapeRegex(title) },
        'break', 5
      ));
    }
  } else {
    // afterChangeHistory: 변경이력 H2 다음 H2에서 break
    if (pageBreaks.afterChangeHistory !== false) {
      rules.push(breakRule(
        { type: 'heading', level: 2, prevSameLevelHeading: { textMatch: '변경|개정' } },
        'break', 0
      ));
    }

    // h2BreakBeforeSection: N — h2Count 3~(N-1)에서 break (N번째 이후 중단)
    // 기존 로직: beforeStopSection && h2Count > 2 → break
    // h2Count는 1-based, index는 0-based → index 2~(N-2) 범위
    const n = pageBreaks.h2BreakBeforeSection;
    if (n && n > 2) {
      rules.push(breakRule(
        { type: 'heading', level: 2, index: { gte: 2, lt: n - 1 } },
        'break', 0
      ));
    }
  }

  // ── H3 규칙 ──

  // noBreakH3Sections: 최고 우선순위 (10)
  for (const section of noBreakH3) {
    rules.push(breakRule(
      { type: 'heading', level: 3, textMatch: _sectionToRegex(section) },
      'noBreak', 10
    ));
  }

  // h3Sections: 명시적 break 목록 (priority 5)
  // 기존 377줄: inBreakList → return !isFirstH3AfterH2 — 첫 번째 H3이면 break 안 함
  for (const section of h3Sections) {
    rules.push(breakRule(
      { type: 'heading', level: 3, textMatch: _sectionToRegex(section), notFirstInParent: true },
      'break', 5
    ));
  }

  // changeDetailH3Break
  if (pageBreaks.changeDetailH3Break === true) {
    rules.push(breakRule(
      { type: 'heading', level: 3, textMatch: '^v.*변경 상세', notFirstInParent: true },
      'break', 2
    ));
  } else if (pageBreaks.changeDetailH3Break === false) {
    rules.push(breakRule(
      { type: 'heading', level: 3, textMatch: '^v.*변경 상세' },
      'noBreak', 2
    ));
  }

  // imageH3AlwaysBreak (priority 1)
  // 기존 380줄: hasImage && imageH3AlwaysBreak → !isFirstH3AfterH2 || !lastH2Broke
  // notFirstInParent + h2BreakOccurred 조합은 _ruleMeta로 엔진에 전달
  if (pageBreaks.imageH3AlwaysBreak !== false) {
    rules.push(breakRule(
      { type: 'heading', level: 3, hasImage: true, notFirstInParent: true },
      'break', 1
    ));
  }

  // defaultH3Break (가장 낮은 priority -1)
  // 기존 381줄: defaultH3Break && beforeStopSection && !isFirstH3AfterH2
  // parentIndex: 부모 H2의 index가 범위 내일 때만 매칭 (h2StopIndex 대체)
  if (pageBreaks.defaultH3Break !== false) {
    const match = { type: 'heading', level: 3, notFirstInParent: true };
    const n = pageBreaks.h2BreakBeforeSection;
    if (n && n > 0) {
      match.parentIndex = { lt: n - 1 }; // N번째 H2(0-based N-1) 전까지만
    }
    rules.push(breakRule(match, 'break', -1));
  }

  return { rules };
}

// ── 내부 헬퍼 ──

/** 섹션 번호 또는 제목을 정규식 문자열로 변환 */
function _sectionToRegex(section) {
  // "4.1" → "^4\\.1" (섹션 번호), "제목 텍스트" → 전체 제목 매칭
  if (/^\d+\.\d+/.test(section)) {
    return '^' + _escapeRegex(section);
  }
  return _escapeRegex(section);
}

/** 정규식 특수문자 이스케이프 */
function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { convertPageBreaksToRules };

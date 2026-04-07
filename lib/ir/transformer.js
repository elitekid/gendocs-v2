/**
 * lib/ir/transformer.js — SemanticIR → LayoutIR 변환
 *
 * 책임:
 *  1. breakRules 엔진 — pageBreak 노드 삽입
 *  2. 테이블 너비 확정 — null인 컬럼만 균등분배
 *  3. 스타일 해석 — deriveColors 위임
 *  4. preCheck — 구조 검증 (경고만, 콘텐츠 수정 없음)
 *  5. 다이어그램 — no-op (MD 단계에서 이미 변환됨, 잔여 경고만)
 *
 * 기존 converter-core.js를 건드리지 않고 나란히 공존 (전략 B).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const IR = require('./schema');
const { dxaToPt } = require('./units');
const { deriveColors, isV2Theme } = require('../theme-utils');
const { convertPageBreaksToRules } = require('./break-adapter');

// ═══════════════════════════════════════
// 메인 transform 함수
// ═══════════════════════════════════════

/**
 * SemanticIR → LayoutIR 변환
 * @param {Object} semanticIR - { content, headings, warnings, meta?, layout?, styles?, breakRules? }
 * @param {Object} config - doc-config 전체
 * @param {Object} [options]
 * @param {string} [options.baseDir] - 프로젝트 루트
 * @param {Array} [options.headings] - parse() 결과의 headings 배열
 * @returns {Object} LayoutIR
 */
function transform(semanticIR, config, options = {}) {
  const warnings = [...(semanticIR.warnings || [])];
  let content = [...semanticIR.content];

  // 1. preCheck — 구조 경고 수집
  warnings.push(...preCheck(content));

  // 2. 다이어그램 확인 — 남은 mermaid/dot codeBlock 경고
  warnings.push(...checkRemainingDiagrams(content));

  // 3. 테이블 너비 확정 — null인 컬럼만, 이미 값이 있는 컬럼은 건드리지 않음
  content = finalizeTableWidths(content, config);

  // 4. breakRules 적용 → pageBreak 노드 삽입
  let breakRules;
  if (semanticIR.breakRules) {
    breakRules = semanticIR.breakRules;
  } else {
    const adapted = convertPageBreaksToRules(config.pageBreaks || {});
    breakRules = adapted.rules;
  }
  content = applyBreakRules(content, breakRules);

  // 5. cover/toc 노드 생성 → content[] 앞에 삽입
  _insertCoverAndToc(content, config, options);

  // 6. 스타일 해석
  const styles = resolveStyles(config, options.baseDir);

  return {
    meta: semanticIR.meta || { title: config.docInfo?.title || '' },
    layout: semanticIR.layout || _defaultLayout(config),
    styles,
    content,
    headings: options.headings || [],
    _warnings: warnings,
  };
}

// ═══════════════════════════════════════
// breakRules 엔진
// ═══════════════════════════════════════

/**
 * breakRules를 content에 적용하여 pageBreak 노드를 삽입한다.
 * @param {ContentNode[]} content
 * @param {BreakRule[]} rules
 * @returns {ContentNode[]} pageBreak가 삽입된 새 배열
 */
function applyBreakRules(content, rules) {
  if (!rules || rules.length === 0) return content;

  // imageH3Legacy: hasImage + notFirstInParent 조합 규칙 감지 (스키마 비오염)
  // Phase 7에서 native breakRules 마이그레이션 시 제거
  const ruleMeta = new Map();
  rules.forEach((rule, idx) => {
    if (rule.match.hasImage && rule.match.notFirstInParent &&
        rule.match.type === 'heading' && rule.match.level === 3) {
      ruleMeta.set(idx, { imageH3Legacy: true });
    }
  });

  const ctx = {
    typeCounters: {},      // "heading:2" → 0,1,2...
    parentStack: [],       // [{level, text, firstChildSeen: {level: bool}, index: number}]
    prevSibling: null,     // 직전 의미 노드
    sameLevelPrev: {},     // {2: node, 3: node}
    h2BreakOccurred: false, // 직전 H2에서 break 발생 여부
  };

  const result = [];

  for (let i = 0; i < content.length; i++) {
    const node = content[i];

    // context 갱신 (heading일 때)
    if (node.type === 'heading') {
      const key = `${node.type}:${node.level}`;
      ctx.typeCounters[key] = (ctx.typeCounters[key] || 0);

      // parentStack 갱신: 자신보다 level이 높거나 같은 것 제거
      while (ctx.parentStack.length > 0 &&
             ctx.parentStack[ctx.parentStack.length - 1].level >= node.level) {
        ctx.parentStack.pop();
      }

      // isFirstAfterParent 판정
      const parent = ctx.parentStack.length > 0
        ? ctx.parentStack[ctx.parentStack.length - 1]
        : null;
      const isFirst = parent
        ? !parent.firstChildSeen[node.level]
        : ctx.typeCounters[key] === 0;

      // breakRules 매칭
      const matchedRules = [];
      for (let ri = 0; ri < rules.length; ri++) {
        const rule = rules[ri];
        const meta = ruleMeta.get(ri);
        if (_matchNode(node, rule.match, ctx, content, i, isFirst, meta)) {
          matchedRules.push(rule);
        }
      }

      const action = _resolveAction(matchedRules);
      if (action === 'break') {
        result.push(IR.pageBreak());
        // H2 break 추적
        if (node.level === 2) ctx.h2BreakOccurred = true;
      } else {
        if (node.level === 2) ctx.h2BreakOccurred = false;
      }

      // 부모 스택에 자식 방문 기록
      if (parent) {
        parent.firstChildSeen[node.level] = true;
      }

      // 자신을 부모로 등록 (index는 증가 전 값 = 현재 0-based index)
      ctx.parentStack.push({
        level: node.level,
        text: node.text,
        firstChildSeen: {},
        index: ctx.typeCounters[key], // 아직 증가 전이므로 현재 index
      });

      // sameLevelPrev 갱신
      ctx.sameLevelPrev[node.level] = node;

      // typeCounter 증가 (매칭 후)
      ctx.typeCounters[key]++;
    }

    result.push(node);

    // prevSibling 갱신 (spacer/pageBreak 제외)
    if (node.type !== 'spacer' && node.type !== 'pageBreak') {
      ctx.prevSibling = node;
    }
  }

  return result;
}

/**
 * 단일 노드가 BreakMatch에 매칭되는지 판정 (AND 결합)
 */
function _matchNode(node, match, ctx, content, idx, isFirst, meta) {
  // type
  if (match.type !== node.type) return false;

  // level
  if (match.level !== undefined && match.level !== node.level) return false;

  // textMatch
  if (match.textMatch) {
    if (!node.text || !new RegExp(match.textMatch).test(node.text)) return false;
  }

  // index
  if (match.index) {
    const key = `${node.type}:${node.level || ''}`;
    const counter = ctx.typeCounters[key] || 0;
    if (match.index.gte !== undefined && counter < match.index.gte) return false;
    if (match.index.lt !== undefined && counter >= match.index.lt) return false;
  }

  // notFirstInParent
  if (match.notFirstInParent) {
    // imageH3Legacy: !isFirst || !h2BreakOccurred
    if (meta && meta.imageH3Legacy) {
      if (isFirst && ctx.h2BreakOccurred) return false;
    } else {
      if (isFirst) return false;
    }
  }

  // hasImage (look-ahead)
  if (match.hasImage !== undefined) {
    const has = _hasImageBeforeNextSameLevel(content, idx, node.level || 0);
    if (match.hasImage !== has) return false;
  }

  // parentTextMatch
  if (match.parentTextMatch) {
    const parent = ctx.parentStack.length > 0
      ? ctx.parentStack[ctx.parentStack.length - 1]
      : null;
    if (!parent || !new RegExp(match.parentTextMatch).test(parent.text)) return false;
  }

  // prevSibling
  if (match.prevSibling) {
    if (!ctx.prevSibling) return false;
    if (match.prevSibling.type !== ctx.prevSibling.type) return false;
    if (match.prevSibling.textMatch) {
      if (!ctx.prevSibling.text || !new RegExp(match.prevSibling.textMatch).test(ctx.prevSibling.text)) return false;
    }
  }

  // prevSameLevelHeading
  if (match.prevSameLevelHeading) {
    const prev = ctx.sameLevelPrev[node.level];
    if (!prev) return false;
    if (match.prevSameLevelHeading.textMatch) {
      if (!new RegExp(match.prevSameLevelHeading.textMatch).test(prev.text)) return false;
    }
  }

  // parentIndex: 부모 heading의 type:level index 범위 체크
  if (match.parentIndex) {
    const parent = ctx.parentStack.length > 0
      ? ctx.parentStack[ctx.parentStack.length - 1]
      : null;
    if (!parent) return false;
    const parentIdx = parent.index || 0;
    if (match.parentIndex.gte !== undefined && parentIdx < match.parentIndex.gte) return false;
    if (match.parentIndex.lt !== undefined && parentIdx >= match.parentIndex.lt) return false;
  }

  return true;
}

/**
 * 매칭된 규칙 중 최종 action 결정
 */
function _resolveAction(matchedRules) {
  if (matchedRules.length === 0) return null;
  matchedRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const maxPri = matchedRules[0].priority || 0;
  const topRules = matchedRules.filter(r => (r.priority || 0) === maxPri);
  // 동순위면 noBreak 우선 (보수적)
  if (topRules.some(r => r.action === 'noBreak')) return 'noBreak';
  return topRules[0].action;
}

/**
 * 현재 heading부터 같은/상위 level heading 전까지 image 노드 존재 여부
 */
function _hasImageBeforeNextSameLevel(content, startIdx, level) {
  for (let j = startIdx + 1; j < content.length; j++) {
    const n = content[j];
    if (n.type === 'heading' && n.level <= level) break;
    if (n.type === 'image') return true;
  }
  return false;
}

// ═══════════════════════════════════════
// preCheck — 구조 검증
// ═══════════════════════════════════════

/**
 * 콘텐츠 구조를 검증하여 경고 배열 반환.
 * CRITICAL 이슈 발견 시 throw하여 변환 중단.
 */
function preCheck(content) {
  if (!content || content.length === 0) {
    throw new Error('[CRITICAL] preCheck: content가 비어있습니다');
  }
  const warnings = [];
  let lastHeadingLevel = 0;

  for (let i = 0; i < content.length; i++) {
    const node = content[i];

    // heading level skip (H1 → H3)
    if (node.type === 'heading') {
      if (lastHeadingLevel > 0 && node.level > lastHeadingLevel + 1) {
        warnings.push({
          type: 'structure',
          element: 'heading',
          message: `heading level skip: H${lastHeadingLevel} → H${node.level} ("${node.text}")`,
        });
      }
      lastHeadingLevel = node.level;

      // orphan heading (마지막 요소가 heading)
      if (i === content.length - 1) {
        warnings.push({
          type: 'structure',
          element: 'heading',
          message: `orphan heading at end: H${node.level} ("${node.text}")`,
        });
      }
    }

    // empty table
    if (node.type === 'table' && (!node.rows || node.rows.length === 0)) {
      warnings.push({
        type: 'structure',
        element: 'table',
        message: 'empty table (no data rows)',
      });
    }
  }

  return warnings;
}

// ═══════════════════════════════════════
// 다이어그램 잔여 확인
// ═══════════════════════════════════════

function checkRemainingDiagrams(content) {
  const warnings = [];
  for (const node of content) {
    if (node.type === 'codeBlock' && node.language &&
        ['mermaid', 'dot', 'graphviz'].includes(node.language)) {
      warnings.push({
        type: 'info',
        element: 'diagram',
        message: `unrendered ${node.language} diagram in content`,
      });
    }
  }
  return warnings;
}

// ═══════════════════════════════════════
// 테이블 너비 확정
// ═══════════════════════════════════════

/**
 * null인 컬럼만 균등분배. 이미 값이 있는 컬럼은 건드리지 않음.
 */
function finalizeTableWidths(content, config) {
  const orient = config.orientation || 'landscape';
  const pageW = (orient === 'portrait') ? 12240 : 15840;
  const defaultMarginLR = 1440;
  const pm = config._resolvedTheme?.pageMargin || {};
  const totalWidthDxa = pageW - (pm.left || defaultMarginLR) - (pm.right || defaultMarginLR);
  const totalWidthPt = dxaToPt(totalWidthDxa);

  return content.map(node => {
    if (node.type !== 'table') return node;

    const hasNull = node.columns.some(c => c.width == null);
    if (!hasNull) return node;

    // 확정된 너비 합산, 남은 공간을 null 컬럼에 균등분배
    let usedWidth = 0;
    let nullCount = 0;
    for (const col of node.columns) {
      if (col.width != null) usedWidth += col.width;
      else nullCount++;
    }
    const remainWidth = Math.max(0, totalWidthPt - usedWidth);
    const perNull = nullCount > 0 ? remainWidth / nullCount : 0;

    const newColumns = node.columns.map(col => {
      if (col.width != null) return col;
      return { ...col, width: Math.round(perNull * 10) / 10 };
    });

    return { ...node, columns: newColumns };
  });
}

// ═══════════════════════════════════════
// 스타일 해석
// ═══════════════════════════════════════

/**
 * config에서 테마를 로드하여 colors/fonts 반환
 */
function resolveStyles(config, baseDir) {
  const themeName = config.theme || 'office-modern';
  const projectRoot = baseDir || '.';

  // 테마 JSON 로드
  let theme = {};
  const themePath = path.join(projectRoot, 'themes', `${themeName}.json`);
  if (fs.existsSync(themePath)) {
    try { theme = JSON.parse(fs.readFileSync(themePath, 'utf-8')); } catch { /* noop */ }
  }

  let colors = {};
  if (isV2Theme(theme)) {
    colors = deriveColors(theme.slots, theme.overrides);
  }

  // doc-config style 오버라이드
  if (config.style?.colors) {
    Object.assign(colors, config.style.colors);
  }

  return {
    colors,
    fonts: theme.fonts || { default: 'Malgun Gothic', code: 'Consolas' },
    sizes: theme.sizes || {},
    syntax: theme.syntax || {},
  };
}

// ═══════════════════════════════════════
// 내부 헬퍼
// ═══════════════════════════════════════

/**
 * cover/toc 노드를 content[] 앞에 삽입 (in-place)
 */
function _insertCoverAndToc(content, config, options) {
  const baseDir = options.baseDir || '.';
  const docInfo = config.docInfo || {};

  // cover 노드 생성
  if (docInfo.title) {
    const info = [];
    if (docInfo.author) info.push({ label: '작성자', value: docInfo.author });
    if (docInfo.company) info.push({ label: '회사', value: docInfo.company });
    if (docInfo.version) info.push({ label: '버전', value: docInfo.version });
    if (docInfo.createdDate) info.push({ label: '작성일', value: docInfo.createdDate });
    if (docInfo.modifiedDate) info.push({ label: '최종 수정일', value: docInfo.modifiedDate });

    const logoPath = config.logoPath || null;
    const resolvedLogo = logoPath ? path.join(baseDir, logoPath) : null;
    const effectiveLogo = resolvedLogo && fs.existsSync(resolvedLogo) ? resolvedLogo : null;

    content.unshift(IR.cover({ text: docInfo.title }, {
      subtitle: docInfo.subtitle ? { text: docInfo.subtitle } : undefined,
      logo: effectiveLogo ? { src: effectiveLogo } : undefined,
      info,
      style: config.coverStyle,
    }));
  }

  // toc 노드 생성
  const themeConfig = config._resolvedTheme || {};
  const tocEnabled = config.toc || (themeConfig.toc && themeConfig.toc.enabled);
  if (tocEnabled) {
    const tocStyle = themeConfig.toc || {};
    const tocExclude = new Set(tocStyle.exclude || []);
    const headings = (options.headings || [])
      .filter(h => (h.level === 2 || h.level === 3) && !tocExclude.has(h.text));

    if (headings.length > 0) {
      const tocNode = IR.toc({
        title: tocStyle.title,
        maxLevel: tocStyle.maxLevel,
        indentPerLevel: tocStyle.indent,
      });

      const tocPosition = tocStyle.position || 'afterCover';
      if (tocPosition === 'afterChangeHistory') {
        // 두 번째 H2 앞에 삽입
        let h2Count = 0;
        let insertIdx = content[0]?.type === 'cover' ? 1 : 0;
        for (let i = insertIdx; i < content.length; i++) {
          if (content[i].type === 'heading' && content[i].level === 2) {
            h2Count++;
            if (h2Count === 2) { insertIdx = i; break; }
          }
        }
        content.splice(insertIdx, 0, tocNode);
      } else {
        // afterCover (기본)
        const idx = content[0]?.type === 'cover' ? 1 : 0;
        content.splice(idx, 0, tocNode);
      }
    }
  }
}

function _defaultLayout(config) {
  const orient = config.orientation || 'landscape';
  const isPortrait = orient === 'portrait';
  return {
    pageSize: { width: isPortrait ? 612 : 792, height: isPortrait ? 792 : 612 },
    margins: { top: 54, right: 72, bottom: 54, left: 72 },
    orientation: orient,
  };
}

// ═══════════════════════════════════════
// exports
// ═══════════════════════════════════════

module.exports = {
  transform,
  // 테스트용 내부 함수 노출
  applyBreakRules,
  preCheck,
  finalizeTableWidths,
  resolveStyles,
  checkRemainingDiagrams,
};

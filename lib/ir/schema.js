/**
 * lib/ir/schema.js — GDoc IR 스키마 정의 + 팩토리 + 런타임 검증
 *
 * 참조: docs/architecture/03-ir-schema.md
 *
 * IR 단위 표준:
 *   - 모든 길이(페이지, 여백, 이미지, 테이블 컬럼, 폰트): pt
 *   - 모든 색상: hex 6자리 (# 없이, 예: "44546A")
 *   - 렌더러(plain-docx 등)가 lib/ir/units.js로 출력 포맷에 맞게 변환
 *
 * TypeScript 미도입 — JSDoc typedef + 런타임 validate 함수.
 * 기존 코드 수정 없음, 신규 파일만 추가.
 */
'use strict';

// ═══════════════════════════════════════
// 상수
// ═══════════════════════════════════════

const CONTENT_NODE_TYPES = [
  'heading', 'paragraph', 'list', 'table', 'codeBlock',
  'image', 'callout', 'cover', 'toc', 'pageBreak',
  'spacer', 'section', 'divider',
];

const ALIGNMENTS = ['left', 'center', 'right', 'justify'];
const CALLOUT_VARIANTS = ['info', 'warning', 'note', 'success', 'error', 'flow'];
const ORIENTATIONS = ['landscape', 'portrait'];
const BREAK_ACTIONS = ['break', 'noBreak'];
const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double', 'none'];
const VERTICAL_ALIGNS = ['top', 'center', 'bottom'];
const SOURCE_FORMATS = ['docx', 'pdf', 'xlsx'];

const HEX_6_RE = /^[0-9A-Fa-f]{6}$/;

// ═══════════════════════════════════════
// 팩토리 함수 — ContentNode (13개)
// ═══════════════════════════════════════

/** @returns {HeadingNode} */
function heading(level, text, opts = {}) {
  return { type: 'heading', level, text, ...opts };
}

/** @returns {ParagraphNode} */
function paragraph(content, opts = {}) {
  const runs = typeof content === 'string' ? [{ text: content }] : content;
  return { type: 'paragraph', runs, ...opts };
}

/** @returns {TableNode} */
function table(columns, rows, opts = {}) {
  return { type: 'table', columns, rows, ...opts };
}

/** @returns {ListNode} */
function list(ordered, items, opts = {}) {
  return { type: 'list', ordered, items, ...opts };
}

/** @returns {CodeBlockNode} */
function codeBlock(lines, opts = {}) {
  return { type: 'codeBlock', lines, ...opts };
}

/** @returns {ImageNode} */
function image(width, height, opts = {}) {
  return { type: 'image', width, height, ...opts };
}

/** @returns {CalloutNode} */
function callout(variant, opts = {}) {
  return { type: 'callout', variant, ...opts };
}

/** @returns {CoverNode} */
function cover(title, opts = {}) {
  const titleObj = typeof title === 'string' ? { text: title } : title;
  return { type: 'cover', title: titleObj, ...opts };
}

/** @returns {TocNode} */
function toc(opts = {}) {
  return { type: 'toc', ...opts };
}

/** @returns {PageBreakNode} */
function pageBreak(reason) {
  return reason ? { type: 'pageBreak', reason } : { type: 'pageBreak' };
}

/** @returns {SpacerNode} */
function spacer(height) {
  return { type: 'spacer', height };
}

/** @returns {SectionNode} */
function section(content, opts = {}) {
  return { type: 'section', content, ...opts };
}

/** @returns {DividerNode} */
function divider() {
  return { type: 'divider' };
}

// ═══════════════════════════════════════
// 팩토리 함수 — 별도 구조 (2개)
// ═══════════════════════════════════════

/** @returns {SheetDef} */
function sheetDef(name, content, opts = {}) {
  return { name, content, ...opts };
}

/** @returns {BreakRule} */
function breakRule(match, action, priority) {
  const rule = { match, action };
  if (priority !== undefined) rule.priority = priority;
  return rule;
}

// ═══════════════════════════════════════
// validateIR — 런타임 유효성 검증
// ═══════════════════════════════════════

/**
 * IR 객체의 유효성을 검증한다.
 * @param {Object} ir - SemanticIR 또는 LayoutIR
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateIR(ir) {
  const errors = [];

  // meta
  if (!ir.meta) {
    errors.push('meta is required');
  } else {
    if (!ir.meta.title || typeof ir.meta.title !== 'string') {
      errors.push('meta.title must be a non-empty string');
    }
  }

  // layout
  if (!ir.layout) {
    errors.push('layout is required');
  } else {
    const l = ir.layout;
    if (!l.pageSize) {
      errors.push('layout.pageSize is required');
    } else {
      if (typeof l.pageSize.width !== 'number' || l.pageSize.width <= 0) {
        errors.push('layout.pageSize.width must be a positive number');
      }
      if (typeof l.pageSize.height !== 'number' || l.pageSize.height <= 0) {
        errors.push('layout.pageSize.height must be a positive number');
      }
    }
    if (!l.margins) {
      errors.push('layout.margins is required');
    } else {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (typeof l.margins[side] !== 'number' || l.margins[side] < 0) {
          errors.push(`layout.margins.${side} must be a non-negative number`);
        }
      }
    }
    if (l.orientation && !ORIENTATIONS.includes(l.orientation)) {
      errors.push(`layout.orientation must be '${ORIENTATIONS.join("' or '")}'`);
    }
  }

  // content
  if (!Array.isArray(ir.content)) {
    errors.push('content must be an array');
  } else {
    ir.content.forEach((node, i) => {
      _validateNode(node, `content[${i}]`, errors);
    });
  }

  // breakRules (선택)
  if (ir.breakRules) {
    if (!Array.isArray(ir.breakRules)) {
      errors.push('breakRules must be an array');
    } else {
      ir.breakRules.forEach((rule, i) => {
        const p = `breakRules[${i}]`;
        if (!rule.match || typeof rule.match.type !== 'string') {
          errors.push(`${p}.match.type must be a string`);
        }
        if (!BREAK_ACTIONS.includes(rule.action)) {
          errors.push(`${p}.action must be '${BREAK_ACTIONS.join("' or '")}'`);
        }
      });
    }
  }

  // sheets (선택)
  if (ir.sheets) {
    if (!Array.isArray(ir.sheets)) {
      errors.push('sheets must be an array');
    } else {
      ir.sheets.forEach((sheet, i) => {
        const p = `sheets[${i}]`;
        if (!sheet.name || typeof sheet.name !== 'string') {
          errors.push(`${p}.name must be a non-empty string`);
        }
        if (!Array.isArray(sheet.content)) {
          errors.push(`${p}.content must be an array`);
        }
      });
    }
  }

  // _source (선택)
  if (ir._source) {
    if (!SOURCE_FORMATS.includes(ir._source.format)) {
      errors.push(`_source.format must be '${SOURCE_FORMATS.join("', '")}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ───────────────────────────────────────
// 내부 헬퍼
// ───────────────────────────────────────

function _validateNode(node, path, errors) {
  if (!node || typeof node !== 'object') {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!CONTENT_NODE_TYPES.includes(node.type)) {
    errors.push(`${path}.type '${node.type}' is invalid (must be one of: ${CONTENT_NODE_TYPES.join(', ')})`);
    return;
  }

  switch (node.type) {
    case 'heading':
      if (!Number.isInteger(node.level) || node.level < 1 || node.level > 6) {
        errors.push(`${path}: heading.level must be an integer 1-6`);
      }
      if (!node.text || typeof node.text !== 'string') {
        errors.push(`${path}: heading.text must be a non-empty string`);
      }
      if (node.inlineStyle) _validateInlineStyle(node.inlineStyle, `${path}.inlineStyle`, errors);
      if (node.runs) _validateRuns(node.runs, `${path}.runs`, errors);
      break;

    case 'paragraph':
      if (!Array.isArray(node.runs)) {
        errors.push(`${path}: paragraph.runs must be an array`);
      } else {
        _validateRuns(node.runs, `${path}.runs`, errors);
      }
      if (node.align && !ALIGNMENTS.includes(node.align)) {
        errors.push(`${path}: paragraph.align '${node.align}' is invalid`);
      }
      if (node.background) _validateColor(node.background, `${path}.background`, errors);
      break;

    case 'list':
      if (typeof node.ordered !== 'boolean') {
        errors.push(`${path}: list.ordered must be a boolean`);
      }
      if (!Array.isArray(node.items) || node.items.length === 0) {
        errors.push(`${path}: list.items must be a non-empty array`);
      }
      break;

    case 'table':
      if (!Array.isArray(node.columns) || node.columns.length === 0) {
        errors.push(`${path}: table.columns must be a non-empty array`);
      } else {
        node.columns.forEach((col, j) => {
          if (col.width !== null && (typeof col.width !== 'number' || col.width <= 0)) {
            errors.push(`${path}: table.columns[${j}].width must be a positive number or null`);
          }
        });
      }
      if (!Array.isArray(node.rows)) {
        errors.push(`${path}: table.rows must be an array`);
      }
      if (node.headerStyle) {
        if (node.headerStyle.background) _validateColor(node.headerStyle.background, `${path}.headerStyle.background`, errors);
        if (node.headerStyle.color) _validateColor(node.headerStyle.color, `${path}.headerStyle.color`, errors);
      }
      if (node.rowHeights != null) {
        if (!Array.isArray(node.rowHeights)) {
          errors.push(`${path}: table.rowHeights must be an array of numbers`);
        } else {
          node.rowHeights.forEach((h, j) => {
            if (typeof h !== 'number' || h <= 0) {
              errors.push(`${path}: table.rowHeights[${j}] must be a positive number`);
            }
          });
        }
      }
      break;

    case 'codeBlock':
      // lines 또는 tokens 중 하나 (둘 다 없어도 경고만)
      break;

    case 'image':
      if (typeof node.width !== 'number' || node.width <= 0) {
        errors.push(`${path}: image.width must be a positive number`);
      }
      if (typeof node.height !== 'number' || node.height <= 0) {
        errors.push(`${path}: image.height must be a positive number`);
      }
      if (!node.path && !node.data) {
        errors.push(`${path}: image must have path or data`);
      }
      break;

    case 'callout':
      if (!CALLOUT_VARIANTS.includes(node.variant)) {
        errors.push(`${path}: callout.variant '${node.variant}' is invalid (must be one of: ${CALLOUT_VARIANTS.join(', ')})`);
      }
      break;

    case 'cover':
      if (!node.title || !node.title.text || typeof node.title.text !== 'string') {
        errors.push(`${path}: cover.title.text must be a non-empty string`);
      }
      break;

    case 'toc':
      // 모두 선택적
      break;

    case 'pageBreak':
      // 모두 선택적
      break;

    case 'spacer':
      if (typeof node.height !== 'number' || node.height <= 0) {
        errors.push(`${path}: spacer.height must be a positive number`);
      }
      break;

    case 'section':
      if (!Array.isArray(node.content)) {
        errors.push(`${path}: section.content must be an array`);
      } else {
        node.content.forEach((child, j) => {
          _validateNode(child, `${path}.content[${j}]`, errors);
        });
      }
      break;

    case 'divider':
      // 필드 없음
      break;
  }

  // 공통: spacing
  if (node.spacing) _validateSpacing(node.spacing, `${path}.spacing`, errors);
}

function _validateRuns(runs, path, errors) {
  runs.forEach((run, i) => {
    if (typeof run.text !== 'string') {
      errors.push(`${path}[${i}].text must be a string`);
    }
    if (run.color) _validateColor(run.color, `${path}[${i}].color`, errors);
    if (run.highlight) _validateColor(run.highlight, `${path}[${i}].highlight`, errors);
    if (run.fontSize !== undefined && (typeof run.fontSize !== 'number' || run.fontSize <= 0)) {
      errors.push(`${path}[${i}].fontSize must be a positive number`);
    }
  });
}

function _validateInlineStyle(style, path, errors) {
  if (style.color) _validateColor(style.color, `${path}.color`, errors);
  if (style.fontSize !== undefined && (typeof style.fontSize !== 'number' || style.fontSize <= 0)) {
    errors.push(`${path}.fontSize must be a positive number`);
  }
}

function _validateColor(value, path, errors) {
  if (typeof value !== 'string' || !HEX_6_RE.test(value)) {
    errors.push(`${path} '${value}' is not valid hex 6-digit color`);
  }
}

function _validateSpacing(spacing, path, errors) {
  if (spacing.before !== undefined && typeof spacing.before !== 'number') {
    errors.push(`${path}.before must be a number`);
  }
  if (spacing.after !== undefined && typeof spacing.after !== 'number') {
    errors.push(`${path}.after must be a number`);
  }
}

// ═══════════════════════════════════════
// exports
// ═══════════════════════════════════════

module.exports = {
  // 상수
  CONTENT_NODE_TYPES,
  ALIGNMENTS,
  CALLOUT_VARIANTS,
  ORIENTATIONS,
  BREAK_ACTIONS,
  BORDER_STYLES,
  VERTICAL_ALIGNS,
  SOURCE_FORMATS,

  // 팩토리 — ContentNode
  heading, paragraph, table, list, codeBlock, image,
  callout, cover, toc, pageBreak, spacer, section, divider,

  // 팩토리 — 별도 구조
  sheetDef, breakRule,

  // 검증
  validateIR,
};

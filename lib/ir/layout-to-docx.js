/**
 * lib/ir/layout-to-docx.js — LayoutIR → DOCX elements 변환 어댑터
 *
 * LayoutIR의 content[] 노드를 순회하며 기존 템플릿(t.h1, t.createTable 등)을
 * 호출하여 DOCX elements 배열을 생성한다. 템플릿 인터페이스는 그대로 유지.
 */
'use strict';

const { ptToDxa } = require('./units');

/**
 * LayoutIR content[] → DOCX elements[]
 * @param {ContentNode[]} content - LayoutIR.content
 * @param {Object} t - 템플릿 모듈 (h1, h2, createTable 등)
 * @param {Object} [config] - doc-config (changeHistory minRows 등)
 * @returns {Array} DOCX elements
 */
function layoutToDocx(content, t, config = {}) {
  const elements = [];

  for (const node of content) {
    switch (node.type) {
      case 'heading':
        elements.push(..._renderHeading(node, t));
        break;

      case 'paragraph':
        elements.push(_renderParagraph(node, t));
        break;

      case 'list':
        elements.push(..._renderList(node, t));
        break;

      case 'table':
        elements.push(..._renderTable(node, t, config));
        break;

      case 'codeBlock':
        elements.push(..._renderCodeBlock(node, t));
        break;

      case 'callout':
        elements.push(..._renderCallout(node, t));
        break;

      case 'image':
        elements.push(..._renderImage(node, t));
        break;

      case 'pageBreak':
        elements.push(t.pageBreak());
        break;

      case 'spacer':
        elements.push(t.spacer(ptToDxa(node.height)));
        break;

      case 'cover':
        elements.push(..._renderCover(node, t, config));
        break;

      case 'toc':
        if (typeof t.createTocPage === 'function') {
          elements.push(..._renderToc(node, t, content));
        }
        break;

      case 'divider':
        break;

      default:
        break;
    }
  }

  return elements;
}

// ═══════════════════════════════════════
// 노드별 변환 함수
// ═══════════════════════════════════════

function _renderHeading(node, t) {
  switch (node.level) {
    case 1: return [t.h1(node.text)];
    case 2: return [t.h2(node.text)];
    case 3: return [t.h3(node.text)];
    case 4: return [t.h4(node.text)];
    case 5:
      // H5는 bold text로 렌더링 (기존 converter-core.js 660줄 동작)
      return [t.text(node.text, { bold: true, spacing: { before: 150 } })];
    default:
      return [t.text(node.text)];
  }
}

function _renderParagraph(node, t) {
  const runs = node.runs || [];
  if (runs.length === 0) return t.text('');

  // labelText 패턴: 첫 run이 bold이고 ':'으로 끝남
  if (runs.length >= 2 && runs[0].bold && runs[0].text.endsWith(':')) {
    return t.labelText(runs[0].text, (runs[1].text || '').trim());
  }

  // 단일 텍스트
  if (runs.length === 1 && !runs[0].bold) {
    return t.text(runs[0].text);
  }

  // bold 단일 텍스트
  if (runs.length === 1 && runs[0].bold) {
    return t.text(runs[0].text, { bold: true });
  }

  // 복수 run — 첫 번째 텍스트만 사용 (Phase 5에서 인라인 파싱 개선)
  return t.text(runs.map(r => r.text).join(''));
}

function _renderList(node, t) {
  const elements = [];
  if (node.ordered && typeof t.numberedItem === 'function') {
    node.items.forEach((item, idx) => {
      elements.push(t.numberedItem(idx + 1, item));
    });
  } else {
    node.items.forEach(item => {
      elements.push(t.bullet(item));
    });
  }
  return elements;
}

function _renderTable(node, t, config) {
  const headers = node.columns.map(c => c.header);
  const widths = node.columns.map(c => c.width != null ? ptToDxa(c.width) : 0);

  const rows = node.rows.map(row =>
    row.map(cell => {
      if (cell.runs && cell.runs.length > 0) {
        return cell.runs.map(r => r.text).join('');
      }
      return typeof cell === 'string' ? cell : '';
    })
  );

  const tableOpts = {};
  // 변경이력 섹션의 minRows 처리
  if (config._resolvedTheme?.changeHistory?.totalRows) {
    // heading context가 없으므로 config에서 직접 확인
  }

  const elements = [t.createTable(headers, widths, rows, tableOpts)];
  return elements;
}

function _renderCodeBlock(node, t) {
  const codeLines = node.lines || [];
  if (codeLines.length === 0) return [];

  const lang = (node.language || '').toLowerCase();
  const elements = [];

  if (lang === 'combined' && typeof t.createColoredMessage === 'function') {
    elements.push(t.createColoredMessage(codeLines));
  } else if (lang === 'signature' && typeof t.createPlainCodeBlock === 'function') {
    elements.push(t.createPlainCodeBlock(codeLines));
  } else {
    const firstNonEmpty = codeLines.find(l => l.trim())?.trim() || '';
    if ((firstNonEmpty.startsWith('{') || firstNonEmpty.startsWith('[')) && typeof t.createJsonBlock === 'function') {
      elements.push(t.createJsonBlock(codeLines));
    } else if (typeof t.createSyntaxCodeBlock === 'function') {
      elements.push(t.createSyntaxCodeBlock(codeLines));
    } else {
      elements.push(t.createCodeBlock(codeLines));
    }
  }

  return elements;
}

function _renderCallout(node, t) {
  const elements = [];

  if (node.variant === 'flow') {
    // flowBox: 내부 list의 items를 추출
    const innerList = node.content?.find(c => c.type === 'list');
    const items = innerList ? innerList.items : [];
    if (typeof t.flowBox === 'function' && items.length > 0) {
      elements.push(t.flowBox(items));
    } else {
      items.forEach(item => elements.push(t.bullet(item)));
    }
  } else if (node.variant === 'warning') {
    const text = node.runs?.map(r => r.text).join('') || '';
    elements.push(t.warningBox(text));
  } else {
    // info, note, success, error → infoBox
    const text = node.runs?.map(r => r.text).join('') || '';
    elements.push(t.infoBox(text));
  }

  return elements;
}

function _renderCover(node, t, config) {
  if (typeof t.createCoverPage !== 'function') return [];
  const docInfo = config.docInfo || {};
  const projectInfo = (node.info || []).filter(Boolean);
  return t.createCoverPage(
    docInfo.title || node.title?.text || '',
    docInfo.subtitle || node.subtitle?.text || '',
    projectInfo,
    docInfo.author || '',
    node.logo?.src || null
  );
}

function _renderToc(node, t, allContent) {
  const maxLevel = node.maxLevel || 3;
  const headings = allContent
    .filter(n => n.type === 'heading' && n.level >= 2 && n.level <= maxLevel)
    .map(n => ({ level: n.level, text: n.text }));
  if (headings.length === 0) return [];
  return t.createTocPage(headings, {
    title: node.title,
    indent: node.indentPerLevel,
  });
}

function _renderImage(node, t) {
  if (!t.createImage) return [];
  if (!node.path) return [];
  return [t.createImage(node.path, node.width, node.height)];
}

// ═══════════════════════════════════════
// exports
// ═══════════════════════════════════════

module.exports = { layoutToDocx };

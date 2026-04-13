/**
 * lib/ir/plain-docx-renderers.js — IR 노드 → DOCX 요소 렌더러
 *
 * plain-docx.js에서 분리. 각 IR 노드 타입별 렌더 함수 + 공유 상수.
 * 모든 시각 속성은 IR 노드의 style에서 직접 읽음.
 */
'use strict';

const {
  Paragraph, TextRun, Table, TableRow, TableCell,
  BorderStyle, WidthType, ShadingType, AlignmentType, HeightRule,
  TableLayoutType, VerticalAlign, ImageRun, LineRuleType,
  TabStopType, LeaderType, PageNumber,
} = require('docx');
const fs = require('fs');
const { ptToHalfPt, ptToDxa, ptToPx } = require('./units');

// ============================================================
// 공유 상수
// ============================================================

const ALIGN_MAP = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT };

const FONT_GAP_RATIO = {
  'Gulim': 0.30,
  'GulimChe': 0.25,
  '맑은 고딕': 0.44,
  'Malgun Gothic': 0.44,
  'MalgunGothic': 0.44,
  'Consolas': 0.25,
  '_default': 0.30,
};

const TABLE_MARGIN = 3.6;
const WORD_LINE_SPACING_FACTOR = 0.84;
const CODE_LINE_GAP_RATIO = FONT_GAP_RATIO;

// pdf2docx 방식: 모든 paragraph에 최소 line=~9pt (Word가 font에 맞게 확장)
const PDF2DOCX_MIN_LINE = Math.round(9.1 * 20);  // 182 twips = 9.1pt

// ============================================================
// 유틸
// ============================================================

function calcWordGap(prevType, prevFont, prevSize, nextFont, nextSize, prevStyle) {
  if (prevType === 'table') return TABLE_MARGIN;
  const prevRatio = FONT_GAP_RATIO[prevFont] || FONT_GAP_RATIO._default;
  const nextRatio = FONT_GAP_RATIO[nextFont] || FONT_GAP_RATIO._default;
  if (prevType === 'codeBlock') {
    const codeLS = prevStyle?.lineSpacing || (prevSize || 11) * 2.5;
    return codeLS * 0.65;
  }
  return Math.max((prevSize || 11) * prevRatio, (nextSize || 11) * nextRatio);
}

const _fontWidths = (() => {
  try {
    return require('./font-widths.json');
  } catch {
    return {};
  }
})();

function estimateTextWidth(text, sizePt, fontName) {
  const fw = _fontWidths[fontName] || _fontWidths['Gulim'] || {};
  const defaultW = 0.5;
  const cjkW = fw['CJK'] || 1.0;
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0x2E80) {
      w += sizePt * cjkW;
    } else {
      w += sizePt * (fw[ch] || defaultW);
    }
  }
  return w;
}

// ============================================================
// 렌더러
// ============================================================

function renderHeading(node, skipSpacing = false, prevType = null, prevStyle = null, nextNode = null) {
  const s = node.style || {};
  const rawBefore = node.spacingBefore != null ? node.spacingBefore : 12;
  let beforePt = skipSpacing ? 0 : rawBefore;
  let afterPt = (nextNode && nextNode.spacingBefore == null) ? 5 : 0;
  if (nextNode && nextNode.type === 'table' && (nextNode.spacingBefore || 0) > 10) {
    const transfer = Math.min(beforePt, (nextNode.spacingBefore || 0) - 4);
    beforePt -= transfer;
    afterPt += transfer;
  }
  return new Paragraph({
    spacing: {
      before: ptToDxa(beforePt),
      after: ptToDxa(afterPt),
      line: PDF2DOCX_MIN_LINE,
      lineRule: LineRuleType.AUTO,
    },
    indent: node.indent ? { left: ptToDxa(node.indent) } : undefined,
    alignment: node.align ? ALIGN_MAP[node.align] : undefined,
    children: [new TextRun({
      text: node.text,
      font: s.font || undefined,
      size: s.size ? ptToHalfPt(s.size) : ptToHalfPt(14),
      color: s.color || '000000',
      bold: s.bold === true ? true : undefined,
      italics: s.italic || undefined,
    })],
  });
}

function renderParagraph(node, lineSpacing) {
  const runs = (node.runs || []).map(r => new TextRun({
    text: r.text,
    font: r.font || undefined,
    size: r.size ? ptToHalfPt(r.size) : undefined,
    color: r.color || undefined,
    bold: r.bold || undefined,
    italics: r.italic || undefined,
  }));
  const pBefore = node.spacingBefore != null ? node.spacingBefore : undefined;

  if (node._dotLeader) {
    const tabPos = ptToDxa((node._dotLeaderEnd || 648) - (node._marginLeft || 72));
    const firstRun = (node.runs || [])[0] || {};
    const pageNumText = node._dotLeaderPageNum || '';
    runs.push(new TextRun({
      children: ['\t', pageNumText],
      font: firstRun.font || undefined,
      size: firstRun.size ? ptToHalfPt(firstRun.size) : undefined,
    }));
    return new Paragraph({
      spacing: {
        before: pBefore != null ? ptToDxa(pBefore) : undefined,
        after: ptToDxa(0),
        line: lineSpacing != null ? lineSpacing : PDF2DOCX_MIN_LINE,
        lineRule: LineRuleType.AUTO,
      },
      indent: node.indent ? { left: ptToDxa(node.indent) } : undefined,
      tabStops: [{ type: TabStopType.RIGHT, position: tabPos, leader: LeaderType.DOT }],
      children: runs,
    });
  }

  const pLine = lineSpacing != null ? lineSpacing : PDF2DOCX_MIN_LINE;

  return new Paragraph({
    spacing: {
      before: pBefore != null ? ptToDxa(pBefore) : undefined,
      after: ptToDxa(0),
      line: pLine,
      lineRule: LineRuleType.AUTO,
    },
    indent: node.indent ? { left: ptToDxa(node.indent) } : undefined,
    alignment: node.align ? ALIGN_MAP[node.align] : undefined,
    children: runs,
  });
}

function renderCodeBlock(node) {
  const s = node.style || {};
  const font = s.font || 'Consolas';
  const size = s.size ? ptToHalfPt(s.size) : ptToHalfPt(9);
  const color = s.color || '000000';
  const bg = s.bg || null;

  const codeSizePt = s.size || 9;
  const lineGap = s.lineSpacing || 0;
  const renderedLineH = codeSizePt + 0.6;
  const codeBefore = lineGap > renderedLineH ? Math.round((lineGap - renderedLineH) * 20) : 0;

  const lineIndents = node.lineIndents || [];

  const firstLineBefore = node.spacingBefore ? ptToDxa(node.spacingBefore) : Math.round(codeBefore * 0.5);
  const lineCount = (node.lines || []).length;
  const extraFirst = firstLineBefore;
  const adjustedCodeBefore = lineCount > 1
    ? Math.max(0, codeBefore - Math.round(extraFirst / (lineCount - 1)))
    : codeBefore;

  return (node.lines || []).map((line, lineIdx) => {
    const lineIndent = lineIndents[lineIdx] || 0;
    const pOpts = {
      spacing: {
        before: lineIdx === 0 ? firstLineBefore : adjustedCodeBefore,
        after: 0, line: PDF2DOCX_MIN_LINE, lineRule: LineRuleType.AUTO
      },
      indent: lineIndent > 0 ? { left: ptToDxa(lineIndent) } : undefined,
      children: [new TextRun({
        text: (line || ' ').trimStart(),
        font,
        size,
        color,
      })],
    };
    if (bg) {
      pOpts.shading = { type: ShadingType.SOLID, color: bg, fill: bg };
    }
    return new Paragraph(pOpts);
  });
}

function adjustColumnWidths(columns, rows, sizePt, fontName) {
  const colCount = columns.length;
  const widths = columns.map(c => c.width || 100);
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  const maxTextWidths = columns.map((col, ci) => {
    let maxW = estimateTextWidth(col.header || '', sizePt, fontName);
    for (const row of rows) {
      if (!row[ci]) continue;
      const cellText = (row[ci].runs || []).map(r => r.text).join('');
      for (const line of cellText.split('\n')) {
        const tw = estimateTextWidth(line, sizePt, fontName);
        if (tw > maxW) maxW = tw;
      }
    }
    return maxW;
  });

  const needed = maxTextWidths.map((tw, ci) => {
    const p = columns[ci].padding;
    const lr = p ? (p.left + p.right) : 4;
    return tw + lr + 2;
  });
  const adjusted = [...widths];

  const deficits = [];
  for (let i = 0; i < colCount; i++) {
    const deficit = needed[i] - adjusted[i];
    if (deficit > 0) {
      deficits.push({ col: i, deficit });
    }
  }

  if (deficits.length === 0) return adjusted;

  const surpluses = [];
  for (let i = 0; i < colCount; i++) {
    const surplus = adjusted[i] - needed[i];
    if (surplus > 5) {
      surpluses.push({ col: i, surplus: surplus - 5 });
    }
  }

  const totalDeficit = deficits.reduce((s, d) => s + d.deficit, 0);
  const totalSurplus = surpluses.reduce((s, d) => s + d.surplus, 0);

  if (totalSurplus <= 0) return adjusted;

  const redistAmount = Math.min(totalDeficit, totalSurplus);
  const deficitRatio = redistAmount / totalDeficit;
  const surplusRatio = redistAmount / totalSurplus;

  for (const d of deficits) {
    adjusted[d.col] += d.deficit * deficitRatio;
  }
  for (const s of surpluses) {
    adjusted[s.col] -= s.surplus * surplusRatio;
  }

  return adjusted.map(w => Math.round(w * 10) / 10);
}

function renderTable(node) {
  const columns = node.columns || [];
  const rows = node.rows || [];
  const colCount = columns.length;
  const s = node.style || {};

  if (colCount === 0) return [];

  const tableFont = s.font || undefined;
  const tableSizePt = s.size || 9;
  const tableSize = ptToHalfPt(tableSizePt);
  const totalWidth = columns.reduce((sum, c) => sum + (c.width || 100), 0);

  const adjustedWidths = adjustColumnWidths(columns, rows, tableSizePt, tableFont);
  const adjColumns = columns.map((c, i) => ({ ...c, width: adjustedWidths[i] }));
  const borderColor = s.borderColor || '000000';
  const simpleBorder = { style: BorderStyle.SINGLE, size: 1, color: borderColor };
  const cellBorders = { top: simpleBorder, bottom: simpleBorder, left: simpleBorder, right: simpleBorder };

  const DEFAULT_PAD_DXA = ptToDxa(1);
  const cp = s.cellPadding;
  const defaultMargins = cp ? {
    left: ptToDxa(cp.left), top: ptToDxa(cp.top),
    right: ptToDxa(cp.right), bottom: ptToDxa(cp.bottom),
  } : { left: DEFAULT_PAD_DXA, top: DEFAULT_PAD_DXA, right: DEFAULT_PAD_DXA, bottom: DEFAULT_PAD_DXA };

  const colMargins = columns.map((col) => {
    const p = col.padding;
    if (p) {
      return { left: ptToDxa(p.left), top: ptToDxa(p.top), right: ptToDxa(p.right), bottom: ptToDxa(p.bottom) };
    }
    return defaultMargins;
  });

  const rawRowHeights = node.rowHeights || null;
  let rowHeights = null;
  let adjustedPadTB = null;
  if (rawRowHeights) {
    const lineHeight = tableSizePt * 1.2;
    rowHeights = rawRowHeights.map((h) => {
      const maxPad = Math.max((h - lineHeight) / 2, 1);
      return h - maxPad;
    });
    const maxPad = Math.max((rawRowHeights[0] - lineHeight) / 2, 1);
    adjustedPadTB = ptToDxa(maxPad);
  }

  const hasHeaderBg = !!s.headerBg;
  const headerBold = s.headerBold === true;
  const headerCenter = s.headerCenter === true;
  const headerRowOpts = {};
  if (rowHeights && rowHeights[0]) {
    headerRowOpts.height = { value: ptToDxa(rowHeights[0]), rule: HeightRule.EXACT };
  }
  const headerRow = new TableRow({
    ...headerRowOpts,
    children: adjColumns.map((col, ci) => {
      const baseMar = colMargins[ci] || defaultMargins;
      const cellMar = adjustedPadTB != null
        ? { ...baseMar, top: adjustedPadTB, bottom: adjustedPadTB }
        : baseMar;
      const headerLines = (col.header || '').split('\n');
      const cellOpts = {
        width: { size: ptToDxa(col.width || totalWidth / colCount), type: WidthType.DXA },
        borders: cellBorders,
        margins: cellMar,
        verticalAlign: VerticalAlign.CENTER,
        children: headerLines.map(line => new Paragraph({
          alignment: headerCenter ? AlignmentType.CENTER : undefined,
          children: [new TextRun({
            text: line,
            bold: headerBold || undefined,
            color: s.headerColor || (hasHeaderBg ? 'FFFFFF' : undefined),
            font: tableFont,
            size: tableSize,
          })],
        })),
      };
      if (hasHeaderBg) {
        cellOpts.shading = { type: ShadingType.SOLID, color: s.headerBg, fill: s.headerBg };
      }
      return new TableCell(cellOpts);
    }),
  });

  const dataRows = rows.map((row, rowIdx) => {
    const rowOpts = {};
    const rh = rowHeights && rowHeights[rowIdx + 1];
    if (rh) {
      const hasMultiLine = row.some((cell) => {
        const text = (cell.runs || []).map(r => r.text).join('');
        return text.includes('\n');
      });
      if (hasMultiLine) {
        const rawH = rawRowHeights ? rawRowHeights[rowIdx + 1] : null;
        if (rawH) {
          rowOpts.height = { value: ptToDxa(rawH), rule: HeightRule.EXACT };
          rowOpts._noPadTB = true;
        }
      }
      const hasOverflow = !hasMultiLine && row.some((cell, ci) => {
        const text = (cell.runs || []).map(r => r.text).join('');
        if (text.includes('\n')) return false;
        const tw = estimateTextWidth(text, tableSizePt, tableFont);
        const colW = adjColumns[ci]?.width || 100;
        const p = adjColumns[ci]?.padding;
        const lr = p ? (p.left + p.right) : 4;
        return tw > (colW - lr);
      });
      if (!hasMultiLine) {
        const rule = hasOverflow ? HeightRule.ATLEAST : HeightRule.EXACT;
        rowOpts.height = { value: ptToDxa(rh), rule };
      }
    }
    return new TableRow({
      ...rowOpts,
      children: row.slice(0, colCount).map((cell, colIdx) => {
        const cellText = (cell.runs || []).map(r => r.text).join('');
        const lines = cellText.split('\n');
        const cellBg = cell.bg;
        const cellAlign = cell.align ? ALIGN_MAP[cell.align] : undefined;
        const dBaseMar = colMargins[colIdx] || defaultMargins;
        const dCellMar = rowOpts._noPadTB
          ? { ...dBaseMar, top: 0, bottom: 0 }
          : adjustedPadTB != null
            ? { ...dBaseMar, top: adjustedPadTB, bottom: adjustedPadTB }
            : dBaseMar;
        return new TableCell({
          width: { size: ptToDxa(adjColumns[colIdx]?.width || totalWidth / colCount), type: WidthType.DXA },
          borders: cellBorders,
          margins: dCellMar,
          verticalAlign: VerticalAlign.CENTER,
          shading: cellBg ? { type: ShadingType.SOLID, color: cellBg, fill: cellBg } : undefined,
          children: lines.map(line => new Paragraph({
            alignment: cellAlign,
            children: [new TextRun({ text: line, font: tableFont, size: tableSize })],
          })),
        });
      }),
    });
  });

  const columnWidths = adjColumns.map(c => ptToDxa(c.width || totalWidth / colCount));
  const allRows = node._noHeader ? dataRows : [headerRow, ...dataRows];

  return [new Table({
    rows: allRows,
    width: { size: ptToDxa(totalWidth), type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
  })];
}

function renderList(node) {
  const items = node.items || [];
  const s = node.style || {};
  const font = s.font || undefined;
  const size = s.size ? ptToHalfPt(s.size) : ptToHalfPt(10);
  const color = s.color || '000000';
  return items.map(text => new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, font, size, color })],
  }));
}

function renderImage(node, prevType, prevStyle) {
  if (!node.data && !node.path) return [];
  let imageData;
  if (node.data) {
    imageData = Buffer.from(node.data, 'base64');
  } else if (node.path && fs.existsSync(node.path)) {
    imageData = fs.readFileSync(node.path);
  } else {
    return [];
  }
  const width = Math.round(ptToPx(node.width || 400));
  const height = Math.round(ptToPx(node.height || 300));
  const imgBefore = node.spacingBefore || 0;
  return [new Paragraph({
    spacing: { before: ptToDxa(imgBefore), after: 0 },
    alignment: node.align ? ALIGN_MAP[node.align] : undefined,
    children: [new ImageRun({ type: 'png', data: imageData, transformation: { width, height } })],
  })];
}

function renderCallout(node) {
  const text = (node.runs || []).map(r => r.text).join('');
  const s = node.style || {};
  const bg = node.variant === 'warning' ? 'FFF3CD' : 'D1ECF1';
  return new Paragraph({
    shading: { type: ShadingType.SOLID, color: bg, fill: bg },
    children: [new TextRun({
      text,
      font: s.font || undefined,
      size: s.size ? ptToHalfPt(s.size) : ptToHalfPt(10),
      color: s.color || '000000',
    })],
  });
}

function buildHeaderFooterParagraph(items, meta) {
  const margins = meta.margins || {};
  const pageWidth = meta.pageWidth || 595;
  const leftMargin = margins.left || 72;
  const rightMargin = margins.right || 72;
  const contentWidth = pageWidth - leftMargin - rightMargin;
  const centerPos = ptToDxa(contentWidth / 2);
  const rightPos = ptToDxa(contentWidth);

  const runs = [];
  const sorted = [...items].sort((a, b) => {
    const order = { left: 0, center: 1, right: 2 };
    return (order[a.align] || 0) - (order[b.align] || 0);
  });

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (i > 0) {
      runs.push(new TextRun({ children: ['\t'] }));
    }
    if (item.text === '__PAGE__') {
      runs.push(new TextRun({ children: ['Page ', PageNumber.CURRENT] }));
    } else {
      runs.push(new TextRun({ text: item.text, font: 'NotoSerif', size: ptToHalfPt(9) }));
    }
  }

  return [new Paragraph({
    tabStops: [
      { type: TabStopType.CENTER, position: centerPos },
      { type: TabStopType.RIGHT, position: rightPos },
    ],
    children: runs,
  })];
}

// ============================================================
// exports
// ============================================================

module.exports = {
  // 상수
  ALIGN_MAP, FONT_GAP_RATIO, TABLE_MARGIN, WORD_LINE_SPACING_FACTOR,
  CODE_LINE_GAP_RATIO, PDF2DOCX_MIN_LINE,
  // 유틸
  calcWordGap, estimateTextWidth,
  // 렌더러
  renderHeading, renderParagraph, renderCodeBlock,
  renderTable, renderList, renderImage, renderCallout,
  buildHeaderFooterParagraph,
};

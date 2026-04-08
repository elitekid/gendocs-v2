/**
 * lib/ir/plain-docx.js — IR → 플레인 DOCX 빌더
 *
 * PDF→DOCX 전용. Word 내장 스타일/테마를 일절 사용하지 않는다.
 * 모든 시각 속성은 IR 노드의 style에서 가져와 TextRun/Paragraph에 직접 지정한다.
 */
'use strict';

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  BorderStyle, WidthType, ShadingType, AlignmentType, HeightRule,
  TableLayoutType, VerticalAlign, PageBreak, ImageRun, LineRuleType,
} = require('docx');
const fs = require('fs');
const path = require('path');
const { ptToHalfPt, ptToDxa, ptToPx, lineSpacingMultipleToDocx } = require('./units');

const ALIGN_MAP = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT };

// ============================================================
// 노드 렌더러 — 모든 스타일을 IR에서 직접 읽음
// ============================================================

// Word 폰트별 paragraph 간 추가 간격 비율 (gap = fontSize * ratio)
// Word COM 렌더링 실측값 기반. 두 paragraph 사이 gap = prev_size * prev_ratio + next_size * next_ratio 근사.
// 실제: gap = fontSize * ratio (LINE1→LINE2 gap / fontSize)
const FONT_GAP_RATIO = {
  'Gulim': 0.30,
  'GulimChe': 0.25,
  '맑은 고딕': 0.44,
  'Malgun Gothic': 0.44,
  'MalgunGothic': 0.44,
  'Consolas': 0.25,
  '_default': 0.30,
};
// Word table↔paragraph 고정 마진 (폰트 무관)
const TABLE_MARGIN = 3.6;

// 코드블록 line spacing 보정: Word가 line에 추가하는 양 = fontSize * ratio
// 보정된 spacing = pdfSpacing - fontSize * ratio
const CODE_LINE_GAP_RATIO = FONT_GAP_RATIO;

/**
 * 이전/다음 요소의 폰트/크기 기반으로 Word 추가 간격을 동적 계산.
 */
function calcWordGap(prevType, prevFont, prevSize, nextFont, nextSize, prevStyle) {
  if (prevType === 'table') return TABLE_MARGIN;

  const prevRatio = FONT_GAP_RATIO[prevFont] || FONT_GAP_RATIO._default;
  const nextRatio = FONT_GAP_RATIO[nextFont] || FONT_GAP_RATIO._default;

  if (prevType === 'codeBlock') {
    // 실측: codeBlock→heading gap(sp=0) = lineSpacing * 0.65
    // 이 비율은 code의 line spacing 렌더링 잔여분 + heading top 여백의 합
    const codeLS = prevStyle?.lineSpacing || (prevSize || 11) * 2.5;
    return codeLS * 0.65;
  }

  // paragraph/heading → heading: 양쪽 요소의 descent/leading이 합쳐짐
  return (prevSize || 11) * prevRatio + (nextSize || 11) * nextRatio;
}

function renderHeading(node, skipSpacing = false, prevType = null, prevStyle = null) {
  const s = node.style || {};
  // Word 추가 간격 보정: 이전 요소 폰트/크기 기반 동적 계산
  let beforePt = node.spacingBefore != null ? node.spacingBefore : 12;
  if (!skipSpacing && node.spacingBefore != null && prevType) {
    const prevFont = prevStyle?.font || '_default';
    const prevSize = prevStyle?.size || 11;
    const curFont = s.font || '_default';
    const curSize = s.size || 11;
    const wordGap = calcWordGap(prevType, prevFont, prevSize, curFont, curSize, prevStyle);
    beforePt = Math.max(0, beforePt - wordGap);
  }
  return new Paragraph({
    spacing: {
      before: skipSpacing ? 0 : ptToDxa(beforePt),
      after: ptToDxa(0),
      line: 240,
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
  const children = (node.runs || []).map(r => new TextRun({
    text: r.text,
    font: r.font || undefined,
    size: r.size ? ptToHalfPt(r.size) : undefined,
    color: r.color || undefined,
    bold: r.bold || undefined,
    italics: r.italic || undefined,
  }));
  return new Paragraph({
    spacing: {
      before: node.spacingBefore != null ? ptToDxa(node.spacingBefore) : undefined,
      after: ptToDxa(0),
      line: lineSpacing != null ? lineSpacing : undefined,
      lineRule: lineSpacing != null ? LineRuleType.AUTO : undefined,
    },
    indent: node.indent ? { left: ptToDxa(node.indent) } : undefined,
    alignment: node.align ? ALIGN_MAP[node.align] : undefined,
    children,
  });
}

function renderCodeBlock(node) {
  const s = node.style || {};
  const font = s.font || 'Consolas';
  const size = s.size ? ptToHalfPt(s.size) : ptToHalfPt(9);
  const color = s.color || '000000';
  const bg = s.bg || null;

  // 코드블록 줄 간격: Word AUTO line rule은 지정값의 ~19%를 추가 렌더링
  // 이 비율(0.84)은 폰트와 무관한 Word 엔진 상수 (실측 확인)
  const WORD_LINE_SPACING_FACTOR = 0.84;
  const codeLineSpacing = s.lineSpacing
    ? Math.round(s.lineSpacing * WORD_LINE_SPACING_FACTOR * 20)  // 원본 * 0.84 → twips
    : 276;  // 기본 1.15배

  return (node.lines || []).map(line => {
    const pOpts = {
      spacing: { before: 0, after: 0, line: codeLineSpacing, lineRule: LineRuleType.AUTO },
      children: [new TextRun({
        text: line || ' ',
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

/**
 * fonttools 실측 글리프 폭 기반 텍스트 폭 계산 (pt).
 */
const _fontWidths = (() => {
  try {
    return require('./font-widths.json');
  } catch {
    return {};
  }
})();

function estimateTextWidth(text, sizePt, fontName) {
  const fw = _fontWidths[fontName] || _fontWidths['Gulim'] || {};
  const defaultW = 0.5;  // fallback 반각
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

/**
 * 컬럼 너비 보정: PDF 비율 기준 → Word 렌더링에 맞게 조정.
 * 넘치는 컬럼은 최소한으로 확장, 가장 여유 있는 컬럼에서 양보.
 * @returns {number[]} 보정된 컬럼 너비 (pt)
 */
function adjustColumnWidths(columns, rows, sizePt, fontName) {
  const colCount = columns.length;
  const widths = columns.map(c => c.width || 100);
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  // 각 컬럼의 최대 텍스트 폭 계산 (헤더 + 데이터)
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

  // 각 컬럼의 가용 폭 vs 필요 폭 (컬럼별 패딩 반영)
  const needed = maxTextWidths.map((tw, ci) => {
    const p = columns[ci].padding;
    const lr = p ? (p.left + p.right) : 4;  // 기본 2+2=4pt
    return tw + lr;
  });
  const adjusted = [...widths];

  // 부족한 컬럼 찾기
  const deficits = [];
  for (let i = 0; i < colCount; i++) {
    const deficit = needed[i] - adjusted[i];
    if (deficit > 0) {
      deficits.push({ col: i, deficit });
    }
  }

  if (deficits.length === 0) return adjusted;

  // 여유 있는 컬럼에서 양보할 수 있는 양 계산
  const surpluses = [];
  for (let i = 0; i < colCount; i++) {
    const surplus = adjusted[i] - needed[i];
    if (surplus > 5) { // 최소 5pt 여유는 남김
      surpluses.push({ col: i, surplus: surplus - 5 });
    }
  }

  const totalDeficit = deficits.reduce((s, d) => s + d.deficit, 0);
  const totalSurplus = surpluses.reduce((s, d) => s + d.surplus, 0);

  if (totalSurplus <= 0) return adjusted;

  // 양보 가능한 만큼만 재분배
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

  // 컬럼 너비 보정: Word 렌더링에 맞게 조정 (컬럼별 패딩 반영)
  const adjustedWidths = adjustColumnWidths(columns, rows, tableSizePt, tableFont);
  // columns 객체의 width를 보정값으로 교체 (이후 코드에서 사용)
  const adjColumns = columns.map((c, i) => ({ ...c, width: adjustedWidths[i] }));
  const borderColor = s.borderColor || '000000';
  const simpleBorder = {
    style: BorderStyle.SINGLE, size: 1, color: borderColor,
  };
  const cellBorders = {
    top: simpleBorder, bottom: simpleBorder,
    left: simpleBorder, right: simpleBorder,
  };

  // cellPadding — 컬럼별 padding 우선, 없으면 테이블 대표값, 없으면 1pt 기본값
  const DEFAULT_PAD_DXA = ptToDxa(1);
  const cp = s.cellPadding;
  const defaultMargins = cp ? {
    left: ptToDxa(cp.left), top: ptToDxa(cp.top),
    right: ptToDxa(cp.right), bottom: ptToDxa(cp.bottom),
  } : {
    left: DEFAULT_PAD_DXA, top: DEFAULT_PAD_DXA,
    right: DEFAULT_PAD_DXA, bottom: DEFAULT_PAD_DXA,
  };
  // 컬럼별 margins 배열 생성
  const colMargins = columns.map((col) => {
    const p = col.padding;
    if (p) {
      return {
        left: ptToDxa(p.left), top: ptToDxa(p.top),
        right: ptToDxa(p.right), bottom: ptToDxa(p.bottom),
      };
    }
    return defaultMargins;
  });

  // rowHeights — IR에서 행 높이 (pt, 헤더 포함)
  // Word: 실제렌더링높이 = trHeight + min(padT, padB)
  // 텍스트 잘림 방지: padT = padB = (rowHeight - fontSize*1.2) / 2
  const rawRowHeights = node.rowHeights || null;
  let rowHeights = null;
  let adjustedPadTB = null;  // 행 높이에 맞춘 상하 패딩 (DXA)
  if (rawRowHeights) {
    const lineHeight = tableSizePt * 1.2;
    rowHeights = rawRowHeights.map((h) => {
      // 최대 패딩: 텍스트가 들어갈 공간 확보
      const maxPad = Math.max((h - lineHeight) / 2, 1);
      // trHeight = h - maxPad (실제렌더링 = trHeight + maxPad = h)
      return h - maxPad;
    });
    // 패딩도 행 높이에 맞게 조정
    const maxPad = Math.max((rawRowHeights[0] - lineHeight) / 2, 1);
    adjustedPadTB = ptToDxa(maxPad);
  }

  // 헤더 행 — IR의 headerBold/headerBg/headerCenter에서 읽기
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
      const cellOpts = {
        width: { size: ptToDxa(col.width || totalWidth / colCount), type: WidthType.DXA },
        borders: cellBorders,
        margins: cellMar,
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({
          alignment: headerCenter ? AlignmentType.CENTER : undefined,
          children: [new TextRun({
            text: col.header || '',
            bold: headerBold || undefined,
            color: s.headerColor || (hasHeaderBg ? 'FFFFFF' : undefined),
            font: tableFont,
            size: tableSize,
          })],
        })],
      };
      if (hasHeaderBg) {
        cellOpts.shading = { type: ShadingType.SOLID, color: s.headerBg, fill: s.headerBg };
      }
      return new TableCell(cellOpts);
    }),
  });

  // 데이터 행 — 셀 bg/align/padding/rowHeight 반영
  const dataRows = rows.map((row, rowIdx) => {
    const rowOpts = {};
    // rowHeights[0]은 헤더, rowHeights[1+]은 데이터 행
    const rh = rowHeights && rowHeights[rowIdx + 1];
    if (rh) {
      // 줄바꿈(\n) 또는 실측 기반 오버플로우 → ATLEAST
      const hasMultiLine = row.some((cell) => {
        const text = (cell.runs || []).map(r => r.text).join('');
        return text.includes('\n');
      });
      const hasOverflow = !hasMultiLine && row.some((cell, ci) => {
        const text = (cell.runs || []).map(r => r.text).join('');
        if (text.includes('\n')) return false;
        const tw = estimateTextWidth(text, tableSizePt, tableFont);
        const colW = adjColumns[ci]?.width || 100;
        const p = adjColumns[ci]?.padding;
        const lr = p ? (p.left + p.right) : 4;
        return tw > (colW - lr);
      });
      const rule = (hasMultiLine || hasOverflow) ? HeightRule.ATLEAST : HeightRule.EXACT;
      rowOpts.height = { value: ptToDxa(rh), rule };
    }
    return new TableRow({
    ...rowOpts,
    children: row.slice(0, colCount).map((cell, colIdx) => {
      const cellText = (cell.runs || []).map(r => r.text).join('');
      const lines = cellText.split('\n');
      const cellBg = cell.bg;
      const cellAlign = cell.align ? ALIGN_MAP[cell.align] : undefined;
      const dBaseMar = colMargins[colIdx] || defaultMargins;
      const dCellMar = adjustedPadTB != null
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
          children: [new TextRun({
            text: line,
            font: tableFont,
            size: tableSize,
          })],
        })),
      });
    }),
  });
  });

  const columnWidths = adjColumns.map(c => ptToDxa(c.width || totalWidth / colCount));

  return [new Table({
    rows: [headerRow, ...dataRows],
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

function renderImage(node) {
  if (!node.data && !node.path) return [];

  let imageData;
  if (node.data) {
    imageData = Buffer.from(node.data, 'base64');
  } else if (node.path && fs.existsSync(node.path)) {
    imageData = fs.readFileSync(node.path);
  } else {
    return [];
  }

  // IR은 pt, docx transformation은 px → units.js 변환
  // IR은 pt, docx transformation은 px → units.js 변환
  const width = Math.round(ptToPx(node.width || 400));
  const height = Math.round(ptToPx(node.height || 300));

  return [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: 'png',
      data: imageData,
      transformation: { width, height },
    })],
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

// ============================================================
// 메인 빌더
// ============================================================

async function buildPlainDocx(ir, outputPath) {
  const meta = ir.meta || {};
  const content = ir.content || [];

  const pageWidth = meta.pageWidth || 842;
  const pageHeight = meta.pageHeight || 595;
  const isLandscape = pageWidth > pageHeight;
  const margins = meta.margins || {};

  // docx 라이브러리의 orientation 플래그가 Word에서 안 먹으므로
  // w/h를 실제 표시 크기 그대로 넣음 (landscape면 w > h)
  const pageSettings = {
    page: {
      size: {
        width: ptToDxa(pageWidth),
        height: ptToDxa(pageHeight),
      },
      margin: {
        top: ptToDxa(margins.top || 72),
        bottom: ptToDxa(margins.bottom || 72),
        left: ptToDxa(margins.left || 72),
        right: ptToDxa(margins.right || 72),
      },
    },
  };

  // lineSpacing (커밋 3에서 실제 값 연결, 현재는 undefined)
  const lineSpacing = meta.lineSpacing != null
    ? lineSpacingMultipleToDocx(meta.lineSpacing)
    : undefined;

  const children = [];
  let prevType = null;
  let prevStyle = null;
  let prevPage = null;
  let skipNextSpacing = false;
  let prevNodeIsFullPageImage = false;
  const pageUsableHeight = (pageHeight || 612) - ((margins.top || 72) + (margins.bottom || 72));

  for (const node of content) {
    // 원본 PDF 페이지가 바뀌는 곳에 pageBreak 삽입 (heading에서만)
    // 단, 이전 페이지에 큰 이미지가 있으면 Word가 이미 넘기므로 skip
    const curPage = node._page;
    if (node.type === 'heading' && curPage != null && prevPage != null
        && curPage !== prevPage && prevType !== null) {
      if (!prevNodeIsFullPageImage) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
        skipNextSpacing = true;
      }
    }

    const currentSkip = node.type === 'heading' ? skipNextSpacing : false;
    skipNextSpacing = false;

    switch (node.type) {
      case 'heading':
        children.push(renderHeading(node, currentSkip, prevType, prevStyle));
        break;
      case 'paragraph':
        children.push(renderParagraph(node, lineSpacing));
        break;
      case 'codeBlock':
        children.push(...renderCodeBlock(node));
        break;
      case 'table':
        children.push(...renderTable(node));
        break;
      case 'list':
        children.push(...renderList(node));
        break;
      case 'image':
        children.push(...renderImage(node));
        break;
      case 'callout':
        children.push(renderCallout(node));
        break;
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      default:
        break;
    }
    prevType = node.type;
    prevStyle = node.style || (node.runs && node.runs[0]) || {};
    if (curPage != null) prevPage = curPage;
    // 이미지가 페이지 가용 높이의 70% 이상이면 Word가 자동 페이지 넘김
    prevNodeIsFullPageImage = (node.type === 'image' && node.height > pageUsableHeight * 0.7);
  }

  const doc = new Document({
    sections: [{ properties: pageSettings, children }],
  });

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const buffer = await Packer.toBuffer(doc);
  try {
    fs.writeFileSync(outputPath, buffer);
  } catch (err) {
    if (err.code === 'EBUSY' && process.platform === 'win32') {
      const filename = path.basename(outputPath);
      console.log(`[WARN] 파일이 열려 있음: ${filename}`);
      console.log(`[INFO] 파일을 잡고 있는 프로세스를 종료합니다...`);
      const { execSync } = require('child_process');
      try {
        try {
          execSync(
            `powershell -Command "Get-Process | Where-Object { $_.MainWindowTitle -like '*${filename.replace('.docx', '')}*' } | Stop-Process -Force"`,
            { timeout: 5000, stdio: 'pipe' }
          );
        } catch (_) {
          try { execSync('taskkill /IM WINWORD.EXE /F', { timeout: 5000, stdio: 'pipe' }); } catch (_2) {}
        }
        const lockFile = path.join(path.dirname(outputPath), '~$' + filename.substring(2));
        try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
        for (let retry = 0; retry < 3; retry++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try { fs.writeFileSync(outputPath, buffer); break; }
          catch (retryErr) { if (retry === 2) throw retryErr; }
        }
      } catch (killErr) {
        throw new Error(`파일이 잠겨 있어 저장할 수 없습니다: ${outputPath}`);
      }
    } else {
      throw err;
    }
  }
  console.log(`Document saved: ${outputPath}`);
}

module.exports = { buildPlainDocx };

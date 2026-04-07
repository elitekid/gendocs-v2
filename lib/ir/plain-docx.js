/**
 * lib/ir/plain-docx.js — IR → 플레인 DOCX 빌더
 *
 * PDF→DOCX 전용. Word 내장 스타일/테마를 일절 사용하지 않는다.
 * 모든 시각 속성은 IR 노드의 style에서 가져와 TextRun/Paragraph에 직접 지정한다.
 */
'use strict';

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  BorderStyle, WidthType, ShadingType, AlignmentType,
  PageBreak, ImageRun, LineRuleType,
} = require('docx');
const fs = require('fs');
const path = require('path');
const { ptToHalfPt, ptToDxa, ptToPx, lineSpacingMultipleToDocx } = require('./units');

const ALIGN_MAP = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT };

// ============================================================
// 노드 렌더러 — 모든 스타일을 IR에서 직접 읽음
// ============================================================

function renderHeading(node, skipSpacing = false) {
  const s = node.style || {};
  return new Paragraph({
    spacing: {
      before: skipSpacing ? 0
        : node.spacingBefore != null ? ptToDxa(node.spacingBefore)
        : ptToDxa(12),
      after: ptToDxa(6),
    },
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
      after: ptToDxa(3),
      line: lineSpacing != null ? lineSpacing : undefined,
      lineRule: lineSpacing != null ? LineRuleType.AUTO : undefined,
    },
    children,
  });
}

function renderCodeBlock(node) {
  const s = node.style || {};
  const font = s.font || 'Consolas';
  const size = s.size ? ptToHalfPt(s.size) : ptToHalfPt(9);
  const color = s.color || '000000';
  const bg = s.bg || null;

  return (node.lines || []).map(line => {
    const pOpts = {
      spacing: { before: 0, after: 0, line: 276 },
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

function renderTable(node) {
  const columns = node.columns || [];
  const rows = node.rows || [];
  const colCount = columns.length;
  const s = node.style || {};

  if (colCount === 0) return [];

  const tableFont = s.font || undefined;
  const tableSize = s.size ? ptToHalfPt(s.size) : ptToHalfPt(9);
  const totalWidth = columns.reduce((sum, c) => sum + (c.width || 100), 0);
  const borderColor = s.borderColor || '000000';
  const simpleBorder = {
    style: BorderStyle.SINGLE, size: 1, color: borderColor,
  };
  const cellBorders = {
    top: simpleBorder, bottom: simpleBorder,
    left: simpleBorder, right: simpleBorder,
  };

  // 헤더 행 — IR의 headerBold/headerBg에서 읽기
  const hasHeaderBg = !!s.headerBg;
  const headerBold = s.headerBold === true;
  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map((col) => {
      const cellOpts = {
        width: { size: ptToDxa(col.width || totalWidth / colCount), type: WidthType.DXA },
        borders: cellBorders,
        children: [new Paragraph({
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

  // 데이터 행 — 배경 없음 (원본 보존), 셀 줄바꿈 보존
  const dataRows = rows.map((row) => new TableRow({
    children: row.slice(0, colCount).map((cell, colIdx) => {
      const cellText = (cell.runs || []).map(r => r.text).join('');
      const lines = cellText.split('\n');
      return new TableCell({
        width: { size: ptToDxa(columns[colIdx]?.width || totalWidth / colCount), type: WidthType.DXA },
        borders: cellBorders,
        children: lines.map(line => new Paragraph({
          children: [new TextRun({
            text: line,
            font: tableFont,
            size: tableSize,
          })],
        })),
      });
    }),
  }));

  return [new Table({
    rows: [headerRow, ...dataRows],
    width: { size: ptToDxa(totalWidth), type: WidthType.DXA },
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
  let skipNextSpacing = false;

  for (const node of content) {
    if (node.type === 'heading' && node.level === 2 && prevType !== null) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      skipNextSpacing = true;
    }

    const currentSkip = node.type === 'heading' ? skipNextSpacing : false;
    skipNextSpacing = false;

    switch (node.type) {
      case 'heading':
        children.push(renderHeading(node, currentSkip));
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

/**
 * lib/ir/plain-docx.js — IR → 플레인 DOCX 빌더 (orchestrator)
 *
 * PDF→DOCX 전용. 렌더 함수는 plain-docx-renderers.js에 분리.
 */
'use strict';

const {
  Document, Packer, BorderStyle, Header, Footer,
} = require('docx');
const fs = require('fs');
const path = require('path');
const { ptToDxa, lineSpacingMultipleToDocx } = require('./units');
const {
  renderHeading, renderParagraph, renderCodeBlock,
  renderTable, renderList, renderImage, renderCallout,
  buildHeaderFooterParagraph,
} = require('./plain-docx-renderers');

// ============================================================
// 메인 빌더
// ============================================================

async function buildPlainDocx(ir, outputPath) {
  const meta = ir.meta || {};
  const content = ir.content || [];

  const pageWidth = meta.pageWidth || 842;
  const pageHeight = meta.pageHeight || 595;
  const margins = meta.margins || {};

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

  // 페이지 border (content 영역 상하 가로선)
  if (meta.pageBorder) {
    const bc = meta.pageBorder.color || 'CCCCCC';
    pageSettings.page.borders = {
      pageBorderTop: { style: BorderStyle.SINGLE, size: 6, color: bc, space: 10 },
      pageBorderBottom: { style: BorderStyle.SINGLE, size: 6, color: bc, space: 10 },
    };
  }

  const lineSpacing = meta.lineSpacing != null
    ? lineSpacingMultipleToDocx(meta.lineSpacing)
    : undefined;

  // 페이지별 section 분할 (pdf2docx 방식: 각 PDF 페이지 = Word section)
  const pages = new Map();
  for (const node of content) {
    const pg = node._page != null ? node._page : (pages.size > 0 ? [...pages.keys()].pop() : 0);
    if (!pages.has(pg)) pages.set(pg, []);
    pages.get(pg).push(node);
  }

  const sections = [];
  for (const [pageNum, pageNodes] of pages) {
    const children = [];
    let prevType = null;
    let prevStyle = null;

    for (const node of pageNodes) {
      const nextNode = pageNodes[pageNodes.indexOf(node) + 1] || null;

      switch (node.type) {
        case 'heading':
          children.push(renderHeading(node, false, prevType, prevStyle, nextNode));
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
          children.push(...renderImage(node, prevType, prevStyle));
          break;
        case 'callout':
          children.push(renderCallout(node));
          break;
        default:
          break;
      }
      prevType = node.type;
      prevStyle = node.style || (node.runs && node.runs[0]) || {};
    }

    if (children.length > 0) {
      const section = { properties: pageSettings, children };

      // header/footer — 첫 페이지(표지)는 header 없이 footer만 적용
      const isFirstSection = sections.length === 0;
      if (meta.header && meta.header.length > 0 && !isFirstSection) {
        const hdrChildren = buildHeaderFooterParagraph(meta.header, meta);
        section.headers = { default: new Header({ children: hdrChildren }) };
      }
      if (meta.footer && meta.footer.length > 0) {
        const ftrChildren = buildHeaderFooterParagraph(meta.footer, meta);
        section.footers = { default: new Footer({ children: ftrChildren }) };
      }

      sections.push(section);
    }
  }

  const doc = new Document({ sections });

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

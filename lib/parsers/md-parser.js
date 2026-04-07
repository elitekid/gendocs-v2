/**
 * lib/parsers/md-parser.js — Markdown → SemanticIR content[] 파서
 *
 * 기존 converter-core.js의 convertMarkdownToElements()에서 파싱 로직만 분리.
 * 전략 B: 기존 함수를 건드리지 않고 나란히 구현.
 * Phase 4에서 기존 함수를 교체할 때까지 두 코드가 공존한다.
 *
 * @param {string} markdown — 전처리된 MD (cleanMarkdownHeader 적용 후)
 * @param {Object} [options]
 * @returns {{ content: ContentNode[], headings: {level:number,text:string}[], warnings: ParseWarning[] }}
 */
'use strict';

const fs = require('fs');
const path = require('path');
const IR = require('../ir/schema');
const { dxaToPt } = require('../ir/units');
const {
  parseTable,
  matchPattern,
  getImageDimensions,
  lookAheadForImage,
  calculateTableWidths,
} = require('./parse-utils');

// ═══════════════════════════════════════
// 메인 parse 함수
// ═══════════════════════════════════════

/**
 * @param {string} markdown
 * @param {Object} [options]
 * @param {Object} [options.images] — { basePath, sectionMap }
 * @param {Object} [options.tableWidths] — doc-config 명시적 너비 (DXA)
 * @param {string} [options.docType] — patterns.json 조회용
 * @param {string} [options.orientation] — 'landscape' | 'portrait'
 * @param {Object} [options.pageMargin] — { left, right } (DXA)
 * @param {string} [options.baseDir] — 프로젝트 루트
 * @returns {{ content: ContentNode[], headings: {level:number,text:string}[], warnings: ParseWarning[] }}
 */
function parse(markdown, options = {}) {
  const lines = markdown.split('\n');
  const content = [];
  const headings = [];
  const warnings = [];

  // 가용 폭 계산 (DXA)
  const orient = options.orientation || 'landscape';
  const pageW = (orient === 'portrait') ? 12240 : 15840;
  const defaultMarginLR = 1440;
  const pm = options.pageMargin || {};
  const totalWidth = pageW - (pm.left || defaultMarginLR) - (pm.right || defaultMarginLR);

  // 이미지 설정
  const imgConfig = options.images || {};
  const baseDir = options.baseDir || '.';
  const imageBasePath = imgConfig.basePath ? path.join(baseDir, imgConfig.basePath) : baseDir;
  const imageSectionMap = imgConfig.sectionMap || {};

  // 테이블 너비
  const tableWidthsConfig = options.tableWidths || {};
  const docType = options.docType;

  // 상태
  let currentImageSection = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue; }

    // --- 구분선
    if (line.trim() === '---') {
      content.push(IR.divider());
      i++; continue;
    }

    // # H1
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      const text = line.substring(2).trim();
      content.push(IR.heading(1, text));
      headings.push({ level: 1, text });
      i++; continue;
    }

    // ## H2
    if (line.startsWith('## ')) {
      currentImageSection = null;
      const text = line.substring(3).trim();
      content.push(IR.heading(2, text));
      headings.push({ level: 2, text });
      i++; continue;
    }

    // ### H3
    if (line.startsWith('### ')) {
      const text = line.substring(4).trim();
      const sectionMatch = text.match(/^(\d+\.\d+)/);
      const sectionNum = sectionMatch ? sectionMatch[1] : null;

      content.push(IR.heading(3, text));
      headings.push({ level: 3, text });

      // 이미지 섹션 (sectionMap 기반)
      const hasImageConfig = sectionNum && imageSectionMap[sectionNum];
      if (hasImageConfig) {
        currentImageSection = sectionNum;
        const result = _parseImageSection(lines, i, imageSectionMap[sectionNum], imageBasePath, warnings);
        content.push(...result.nodes);
        i = result.nextIndex;
        continue;
      } else {
        currentImageSection = null;
      }

      i++; continue;
    }

    // 이미지 섹션 내 코드블록 스킵
    if (currentImageSection && line.trim().startsWith('```')) {
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { i++; }
      i++;
      continue;
    }

    // #### H4
    if (line.startsWith('#### ')) {
      const text = line.substring(5).trim().replace(/\*\*/g, '');
      content.push(IR.heading(4, text));
      headings.push({ level: 4, text });
      i++; continue;
    }

    // ##### H5 (IR은 의미 보존, 렌더러가 bold text로 변환)
    if (line.startsWith('##### ')) {
      const text = line.substring(6).trim().replace(/\*\*/g, '');
      content.push(IR.heading(5, text));
      headings.push({ level: 5, text });
      i++; continue;
    }

    // > 인용문 (blockquote)
    if (line.startsWith('> ')) {
      const result = _parseBlockquote(lines, i);
      content.push(result.node);
      content.push(IR.spacer(7.5)); // 150 DXA = 7.5pt
      i = result.nextIndex;
      continue;
    }

    // ![설명](경로) 인라인 이미지
    if (line.trim().match(/^!\[.*?\]\(.+?\)$/)) {
      const imgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch) {
        const altText = imgMatch[1];
        const imgPath = imgMatch[2];
        const resolvedPath = path.isAbsolute(imgPath) ? imgPath : path.join(baseDir, imgPath);

        if (fs.existsSync(resolvedPath)) {
          const maxWidthPx = (orient === 'portrait') ? 560 : 780;
          const dims = getImageDimensions(resolvedPath, maxWidthPx, 500);
          content.push(IR.image(dims.width, dims.height, { path: resolvedPath, alt: altText }));
        } else {
          warnings.push({ type: 'error', element: 'image', message: `파일 없음: ${resolvedPath}` });
          content.push(IR.paragraph(`[이미지 없음: ${altText || imgPath}]`));
        }
        i++; continue;
      }
    }

    // ```코드블록```
    if (line.trim().startsWith('```')) {
      const result = _parseCodeBlock(lines, i);
      if (result.lines.length > 0) {
        content.push(IR.codeBlock(result.lines, { language: result.language }));
        content.push(IR.spacer(5)); // 100 DXA = 5pt
      }
      i = result.nextIndex;
      continue;
    }

    // 테이블 | ... |
    if (line.trim().startsWith('|')) {
      const result = _parseTableBlock(lines, i, tableWidthsConfig, totalWidth, docType);
      if (result.node) {
        content.push(result.node);
        content.push(IR.spacer(5)); // 100 DXA = 5pt
      }
      i = result.nextIndex;
      continue;
    }

    // - 불릿 포인트 (연속 묶음)
    if (line.trim().startsWith('- ')) {
      const result = _parseList(lines, i, false);
      content.push(result.node);
      i = result.nextIndex;
      continue;
    }

    // 숫자. 목록 (연속 묶음)
    const numMatch = line.trim().match(/^(\d+)\.\s(.+)/);
    if (numMatch) {
      const result = _parseList(lines, i, true);
      content.push(result.node);
      i = result.nextIndex;
      continue;
    }

    // **처리 흐름:** → flowBox (callout 'flow')
    const flowLabelMatch = line.trim().match(/^\*\*([^*]*처리\s*흐름[^*]*):\*\*\s*$/);
    if (flowLabelMatch) {
      const result = _parseFlowBox(lines, i, warnings);
      if (result.node) {
        content.push(result.node);
        content.push(IR.spacer(4)); // 80 DXA = 4pt
      }
      i = result.nextIndex;
      continue;
    }

    // **라벨:** 텍스트
    const labelMatch = line.trim().match(/^\*\*([^*]+):\*\*\s*(.*)?$/);
    if (labelMatch) {
      const label = labelMatch[1] + ':';
      const value = (labelMatch[2] || '');
      content.push(IR.paragraph([
        { text: label, bold: true },
        { text: ' ' + value },
      ]));
      i++; continue;
    }

    // 일반 텍스트
    if (line.trim()) {
      content.push(IR.paragraph(line.trim()));
    }
    i++;
  }

  return { content, headings, warnings };
}

// ═══════════════════════════════════════
// 내부 헬퍼 — 순수 파싱
// ═══════════════════════════════════════

/**
 * 블록인용 파싱
 * @returns {{ nextIndex: number, node: CalloutNode, variant: string, text: string }}
 */
function _parseBlockquote(lines, i) {
  let quoteText = lines[i].substring(2).trim();
  i++;
  while (i < lines.length && lines[i].startsWith('> ')) {
    quoteText += ' ' + lines[i].substring(2).trim();
    i++;
  }
  const variant = (quoteText.startsWith('주의') || quoteText.startsWith('중요'))
    ? 'warning' : 'info';
  return {
    nextIndex: i,
    node: IR.callout(variant, { runs: [{ text: quoteText }] }),
    variant,
    text: quoteText,
  };
}

/**
 * 코드블록 파싱
 * @returns {{ nextIndex: number, language: string, lines: string[] }}
 */
function _parseCodeBlock(lines, i) {
  const langTag = lines[i].trim().slice(3).trim().toLowerCase();
  const codeLines = [];
  i++;
  while (i < lines.length && !lines[i].trim().startsWith('```')) {
    codeLines.push(lines[i]);
    i++;
  }
  i++; // 닫는 ``` 스킵

  // 언어 자동 감지 (JSON)
  let language = langTag || '';
  if (!language && codeLines.length > 0) {
    const firstNonEmpty = codeLines.find(l => l.trim())?.trim() || '';
    if (firstNonEmpty.startsWith('{') || firstNonEmpty.startsWith('[')) {
      language = 'json';
    }
  }

  return { nextIndex: i, language, lines: codeLines };
}

/**
 * 테이블 블록 파싱 → IR table 노드
 * @returns {{ nextIndex: number, node: TableNode|null }}
 */
function _parseTableBlock(lines, i, tableWidthsConfig, totalWidth, docType) {
  const tableLines = [];
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    tableLines.push(lines[i]);
    i++;
  }

  const rows = parseTable(tableLines);
  if (rows.length < 2) {
    return { nextIndex: i, node: null };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // 너비 계산 (DXA → pt 변환)
  const widthsDxa = calculateTableWidths(headers, tableWidthsConfig, totalWidth, docType);
  const columns = headers.map((h, idx) => ({
    header: h,
    width: widthsDxa[idx] != null ? dxaToPt(widthsDxa[idx]) : null,
  }));

  const irRows = dataRows.map(row =>
    row.map(cell => ({ runs: [{ text: cell }] }))
  );

  return {
    nextIndex: i,
    node: IR.table(columns, irRows),
  };
}

/**
 * 연속 불릿/번호 목록 → 단일 list 노드
 * @returns {{ nextIndex: number, node: ListNode }}
 */
function _parseList(lines, i, ordered) {
  const items = [];

  if (ordered) {
    while (i < lines.length) {
      const m = lines[i].trim().match(/^(\d+)\.\s(.+)/);
      if (!m) break;
      items.push(m[2]);
      i++;
    }
  } else {
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('- ')) break;
      items.push(trimmed.substring(2));
      i++;
    }
  }

  return {
    nextIndex: i,
    node: IR.list(ordered, items),
  };
}

/**
 * 흐름 박스 파싱 → callout('flow') 노드
 * @returns {{ nextIndex: number, node: CalloutNode|null }}
 */
function _parseFlowBox(lines, i, warnings) {
  const flowItems = [];
  i++; // **처리 흐름:** 줄 스킵

  while (i < lines.length) {
    const currentLine = lines[i].trim();

    // 종료 조건: 빈 줄 + 다음 줄이 새로운 구조
    if (currentLine === '' && flowItems.length > 0 &&
        (i + 1 >= lines.length || lines[i + 1].trim() === '' ||
         lines[i + 1].trim().startsWith('####') ||
         lines[i + 1].trim().startsWith('---') ||
         (lines[i + 1].trim().startsWith('**') && lines[i + 1].trim().endsWith(':**') && !lines[i + 1].includes('Step')))) {
      break;
    }
    if (currentLine.startsWith('####') || currentLine.startsWith('### ') ||
        currentLine.startsWith('## ') || currentLine.startsWith('---')) break;
    if (currentLine.match(/^\*\*(?!Step)[^*]+:\*\*\s*$/) && !currentLine.includes('처리') && flowItems.length > 0) break;

    if (currentLine !== '' && (currentLine.startsWith('**Step') || currentLine.startsWith('- ') || currentLine.match(/^\d+\.\s/))) {
      flowItems.push(currentLine);
    }
    i++;
  }

  if (flowItems.length === 0) {
    warnings.push({ type: 'approximation', element: 'flowBox', message: '흐름 박스에 항목 없음' });
    return { nextIndex: i, node: null };
  }

  return {
    nextIndex: i,
    node: IR.callout('flow', {
      content: [IR.list(false, flowItems)],
    }),
  };
}

/**
 * 이미지 섹션 처리 (sectionMap 기반)
 * @returns {{ nextIndex: number, nodes: ContentNode[] }}
 */
function _parseImageSection(lines, i, imgInfo, imageBasePath, warnings) {
  const nodes = [];
  i++; // H3 줄 다음부터

  // 이미지 전 텍스트 수집
  while (i < lines.length) {
    const nextLine = lines[i];
    if (!nextLine.trim()) { i++; continue; }
    if (nextLine.trim().startsWith('```')) break;
    if (nextLine.startsWith('## ') || nextLine.startsWith('### ')) break;
    nodes.push(IR.paragraph(nextLine.trim()));
    i++;
  }

  // 이미지 삽입
  let imgFile, imgWidth, imgHeight;
  if (typeof imgInfo === 'string') {
    imgFile = imgInfo; imgWidth = 780; imgHeight = 500;
  } else {
    imgFile = imgInfo.file; imgWidth = imgInfo.width || 780; imgHeight = imgInfo.height || 500;
  }
  const imagePath = path.join(imageBasePath, imgFile);
  if (fs.existsSync(imagePath)) {
    nodes.push(IR.image(imgWidth, imgHeight, { path: imagePath }));
  } else {
    warnings.push({ type: 'error', element: 'image', message: `파일 없음: ${imagePath}` });
  }

  // 이미지 섹션 내 코드블록 스킵
  if (i < lines.length && lines[i].trim().startsWith('```')) {
    i++;
    while (i < lines.length && !lines[i].trim().startsWith('```')) { i++; }
    i++;
  }

  return { nextIndex: i, nodes };
}

// ═══════════════════════════════════════
// exports
// ═══════════════════════════════════════

module.exports = { parse };

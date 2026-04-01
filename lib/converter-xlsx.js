/**
 * converter-xlsx.js — Markdown → XLSX 변환 엔진
 *
 * converter-core.js의 유틸리티(parseTable, calculateTableWidths, cleanMarkdownHeader, resolveTheme)를 재사용.
 * doc-config JSON과 함께 사용하여 XLSX 문서를 생성한다.
 *
 * v2: xlsx.sheets[] 커스텀 시트 구조 지원 (AI가 설계한 시트별 레이아웃).
 *     기존 sheetMapping 로직은 그대로 폴백.
 *
 * 사용법: const xlsx = require('./converter-xlsx');
 *         xlsx.buildAndSave(config, projectRoot);
 */

const fs = require('fs');
const path = require('path');
const core = require('./converter-core');
const xlsxUtils = require('./xlsx-utils');

// ============================================================
// 마크다운 서식 정리
// ============================================================

/**
 * 마크다운 인라인 서식을 플레인 텍스트로 변환
 * **볼드**, `코드`, [링크](url) 등 제거
 */
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')            // *italic* → italic
    .replace(/`([^`]+)`/g, '$1')              // `code` → code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
    .replace(/~~([^~]+)~~/g, '$1');           // ~~strike~~ → strike
}

// ============================================================
// 템플릿 로더 (XLSX 전용)
// ============================================================

function loadXlsxTemplate(templateName, themeConfig) {
  const templatePath = path.join(__dirname, '..', 'templates', 'xlsx', `${templateName}.js`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`XLSX 템플릿을 찾을 수 없습니다: ${templatePath}\n  → templates/xlsx/ 에 템플릿을 배치하세요.`);
  }
  const createTemplate = require(templatePath);
  if (typeof createTemplate === 'function') {
    return createTemplate(themeConfig);
  }
  return createTemplate;
}

// ============================================================
// 마크다운 → 시트 구조 변환
// ============================================================

// 기본 스킵 시트 제목 (대소문자 무시)
const DEFAULT_SKIP_TITLES = [
  '목차', 'toc', 'table of contents',
  '변경 이력', '변경이력', 'change history', 'changelog',
  '개요', 'overview', 'introduction',
];

/**
 * 시트 제목이 스킵 대상인지 판정
 */
function shouldSkipSheet(title, customSkip) {
  const lower = title.toLowerCase().replace(/^\d+\.\s*/, '');
  if (DEFAULT_SKIP_TITLES.includes(lower)) return true;
  if (customSkip && customSkip.some(s => lower === s.toLowerCase())) return true;
  return false;
}

/**
 * 마크다운을 섹션(시트) 배열로 분할
 */
function splitSections(markdown, mapping, opts) {
  const lines = markdown.split('\n');
  const customSkip = (opts && opts.skipSheets) || [];

  if (mapping === 'single') {
    return [{ title: '데이터', lines }];
  }

  if (mapping === 'table') {
    const sections = [];
    let currentLines = [];
    let currentTitle = '일반';
    let lastTableHeader = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('## ')) {
        currentTitle = line.substring(3).trim();
      } else if (line.startsWith('### ')) {
        currentTitle = line.substring(4).trim();
      }

      if (line.trim().startsWith('|')) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i]);
          i++;
        }
        i--;

        const parsed = core.parseTable(tableLines);
        if (parsed.length >= 2) {
          const headerStr = parsed[0].join('|');
          if (headerStr !== lastTableHeader) {
            if (currentLines.length > 0) {
              sections.push({ title: currentTitle, lines: currentLines });
            }
            currentLines = [];
            lastTableHeader = headerStr;
          }
          currentLines.push(...tableLines);
        }
      } else {
        currentLines.push(line);
      }
    }
    if (currentLines.length > 0) {
      sections.push({ title: currentTitle, lines: currentLines });
    }
    const result = sections.length > 0 ? sections : [{ title: '데이터', lines }];
    return result.filter(s => !shouldSkipSheet(s.title, customSkip));
  }

  if (mapping === 'h3') {
    const sections = [];
    let currentH2 = '';
    let currentSection = null;

    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (currentSection) sections.push(currentSection);
        currentH2 = line.substring(3).trim();
        currentSection = null;
      } else if (line.startsWith('### ')) {
        if (currentSection) sections.push(currentSection);
        const h3Title = line.substring(4).trim();
        const sheetTitle = currentH2 ? `${currentH2} - ${h3Title}` : h3Title;
        currentSection = { title: sheetTitle, lines: [] };
      } else {
        if (!currentSection) {
          if (currentH2 && line.trim()) {
            currentSection = { title: currentH2, lines: [line] };
          }
          continue;
        }
        currentSection.lines.push(line);
      }
    }
    if (currentSection) sections.push(currentSection);
    return sections.filter(s => !shouldSkipSheet(s.title, customSkip));
  }

  // 기본: H2 기준 분할
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: line.substring(3).trim(), lines: [] };
    } else {
      if (!currentSection) continue;
      currentSection.lines.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  return sections.filter(s => !shouldSkipSheet(s.title, customSkip));
}

/**
 * MD에서 특정 섹션(H2/H3 제목)의 라인을 추출
 * @param {string} markdown - 전체 마크다운
 * @param {string} sectionTitle - "## 제목" 또는 "### 제목" 형태
 * @returns {string[]} 해당 섹션의 라인
 */
function extractSectionLines(markdown, sectionTitle) {
  const lines = markdown.split('\n');
  const title = sectionTitle.replace(/^#+\s*/, '').trim();
  let inSection = false;
  let sectionLevel = 0;
  const result = [];

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      const lineTitle = line.replace(/^#+\s*/, '').trim();
      const lineLevel = line.startsWith('### ') ? 3 : 2;

      if (lineTitle === title) {
        inSection = true;
        sectionLevel = lineLevel;
        continue;
      } else if (inSection && lineLevel <= sectionLevel) {
        break; // 같거나 상위 레벨 도달 → 종료
      }
    }

    if (inSection) {
      result.push(line);
    }
  }

  return result;
}

// ============================================================
// renderSection 헬퍼 함수
// ============================================================

/** 시트 내 최대 컬럼 수 사전 스캔 */
function _prescanMaxCols(sectionLines) {
  let maxCols = 3;
  let si = 0;
  while (si < sectionLines.length) {
    const sl = sectionLines[si];
    if (sl && sl.trim().startsWith('|')) {
      const tLines = [];
      while (si < sectionLines.length && sectionLines[si].trim().startsWith('|')) {
        tLines.push(sectionLines[si]);
        si++;
      }
      const parsed = core.parseTable(tLines);
      if (parsed.length >= 2 && parsed[0].length > maxCols) {
        maxCols = parsed[0].length;
      }
    } else {
      si++;
    }
  }
  return maxCols;
}

/** XLSX 블록인용 처리 — { row, nextIndex } 반환 */
function _renderXlsxBlockquote(sheet, row, lines, i, t, maxCols, skipProse) {
  let quoteText = lines[i].substring(2).replace(/\*\*/g, '').trim();
  i++;
  while (i < lines.length && lines[i].startsWith('> ')) {
    quoteText += ' ' + lines[i].substring(2).replace(/\*\*/g, '').trim();
    i++;
  }
  if (quoteText.startsWith('주의') || quoteText.startsWith('중요')) {
    row = t.writeWarningBox(sheet, row, quoteText, maxCols);
  } else {
    row = t.writeInfoBox(sheet, row, quoteText, maxCols);
  }
  row++;
  return { row, nextIndex: i };
}

/** XLSX 코드블록 처리 — { row, nextIndex } 반환 */
function _renderXlsxCodeBlock(sheet, row, lines, i, t, maxCols) {
  const codeLines = [];
  i++; // 여는 ``` 스킵
  while (i < lines.length && !lines[i].trim().startsWith('```')) {
    codeLines.push(lines[i]);
    i++;
  }
  i++; // 닫는 ``` 스킵
  if (codeLines.length > 0) {
    row = t.writeCodeBlock(sheet, row, codeLines, maxCols);
    row++;
  }
  return { row, nextIndex: i };
}

/** XLSX 테이블 처리 — { row, nextIndex, newTables, headerRow } 반환 */
function _renderXlsxTable(sheet, row, lines, i, config, t, renderOpts, maxCols, globalSemantic) {
  const tableWidthsConfig = config.tableWidths || {};
  const docType = config._docType || undefined;
  const tableLines = [];
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    tableLines.push(lines[i]);
    i++;
  }

  const rows = core.parseTable(tableLines);
  let newTables = 0;
  let headerRow = null;
  if (rows.length >= 2) {
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const widths = calculateXlsxWidths(headers, tableWidthsConfig, docType);

    newTables = 1;
    headerRow = row;

    const sectionColumnDefs = renderOpts.columnDefs || {};
    const enableSemantic = renderOpts.semanticColors || globalSemantic;

    row = t.writeTable(sheet, row, headers, widths, dataRows, {
      columnDefs: sectionColumnDefs,
      semanticColors: enableSemantic,
      customSemanticMap: renderOpts.customSemanticMap,
      richText: true,
    });

    if (renderOpts.summaryRow) {
      row = t.writeSummaryRow(sheet, row);
    }
    row++;
  }
  return { row, nextIndex: i, newTables, headerRow };
}

/** 시트 후처리: 헤더 고정 + 자동 필터 + 너비 정규화 */
function _applySheetFormatting(sheet, firstTableHeaderRow, tableCount, maxCols, xlsxConfig, t) {
  const freezeHeaders = xlsxConfig.freezeHeaders !== false;
  const autoFilter = xlsxConfig.autoFilter !== false;

  if (tableCount === 1 && firstTableHeaderRow) {
    if (freezeHeaders) t.freezeHeaderRow(sheet, firstTableHeaderRow);
    if (autoFilter) t.applyAutoFilter(sheet, 1, maxCols, firstTableHeaderRow);
  }

  const widths = [];
  for (let c = 1; c <= maxCols; c++) {
    widths.push(sheet.getColumn(c).width || 8.43);
  }
  const normalized = _normalizeSheetWidths(widths);
  if (normalized) {
    for (let c = 0; c < normalized.length; c++) {
      sheet.getColumn(c + 1).width = normalized[c];
    }
  }
}

// ============================================================
// renderSection 메인
// ============================================================

/**
 * 섹션 내용을 시트에 렌더링
 * @param {Object} opts - 확장 옵션
 * @param {Object} [opts.columnDefs] - 컬럼별 타입/수식 정의
 * @param {boolean} [opts.summaryRow] - 합계 행 렌더링
 * @param {boolean} [opts.semanticColors] - 의미론적 색상
 * @param {Object} [opts.customSemanticMap] - 커스텀 색상 매핑
 */
function renderSection(sheet, sectionLines, config, t, opts) {
  const renderOpts = opts || {};
  const xlsxConfig = config.xlsx || {};
  const skipProse = xlsxConfig.skipProse !== false;
  const globalSemantic = xlsxConfig.semanticColors || false;

  const maxCols = _prescanMaxCols(sectionLines);

  let row = 1;
  let i = 0;
  let firstTableHeaderRow = null;
  let tableCount = 0;

  while (i < sectionLines.length) {
    const line = sectionLines[i];

    if (!line.trim()) { i++; continue; }
    if (line.trim() === '---') { i++; continue; }
    if (line.startsWith('# ') && !line.startsWith('## ')) { i++; continue; }

    if (line.startsWith('### ')) {
      row = t.writeTitle(sheet, row, stripMarkdown(line.substring(4).trim()), 3, maxCols);
      i++; continue;
    }

    if (line.startsWith('#### ')) {
      row = t.writeTitle(sheet, row, stripMarkdown(line.substring(5).trim()), 4, maxCols);
      i++; continue;
    }

    if (line.startsWith('> ')) {
      const result = _renderXlsxBlockquote(sheet, row, sectionLines, i, t, maxCols, skipProse);
      row = result.row; i = result.nextIndex;
      continue;
    }

    if (line.trim().startsWith('```')) {
      const result = _renderXlsxCodeBlock(sheet, row, sectionLines, i, t, maxCols);
      row = result.row; i = result.nextIndex;
      continue;
    }

    if (line.trim().startsWith('|')) {
      const result = _renderXlsxTable(sheet, row, sectionLines, i, config, t, renderOpts, maxCols, globalSemantic);
      row = result.row; i = result.nextIndex;
      tableCount += result.newTables;
      if (!firstTableHeaderRow && result.headerRow) firstTableHeaderRow = result.headerRow;
      continue;
    }

    if (line.trim().match(/^!\[/)) { i++; continue; }

    if (line.trim().startsWith('- ')) {
      if (!skipProse) row = t.writeBullet(sheet, row, stripMarkdown(line.trim().substring(2)), maxCols);
      i++; continue;
    }

    if (line.trim().match(/^\d+\.\s/)) {
      if (!skipProse) row = t.writeBullet(sheet, row, stripMarkdown(line.trim().replace(/^\d+\.\s/, '')), maxCols);
      i++; continue;
    }

    const labelMatch = line.trim().match(/^\*\*([^*]+):\*\*\s*(.*)?$/);
    if (labelMatch) {
      if (!skipProse) {
        row = t.writeText(sheet, row, `${labelMatch[1]}: ${stripMarkdown(labelMatch[2] || '')}`, maxCols);
      }
      i++; continue;
    }

    if (line.trim()) {
      if (!skipProse) row = t.writeText(sheet, row, stripMarkdown(line.trim()), maxCols);
    }
    i++;
  }

  _applySheetFormatting(sheet, firstTableHeaderRow, tableCount, maxCols, xlsxConfig, t);

  return { maxCols, tableCount };
}

// A4 가로 인쇄 기준 최대 컬럼 너비 합계 (Excel 문자 폭 단위)
const MAX_TOTAL_WIDTH_LANDSCAPE = 140;
const MAX_TOTAL_WIDTH_PORTRAIT = 95;

/** 최소 너비 */
const MIN_COL_WIDTH = 8;

function normalizeWidths(widths, orientation) {
  return _normalizeSheetWidths(widths, orientation) || widths;
}

function _normalizeSheetWidths(widths, orientation) {
  const maxWidth = orientation === 'portrait' ? MAX_TOTAL_WIDTH_PORTRAIT : MAX_TOTAL_WIDTH_LANDSCAPE;
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= maxWidth) return null;

  const scale = maxWidth / total;
  const result = widths.map(w => Math.max(MIN_COL_WIDTH, Math.floor(w * scale)));

  let excess = result.reduce((a, b) => a + b, 0) - maxWidth;
  if (excess > 0) {
    const indices = result.map((w, i) => i).sort((a, b) => result[b] - result[a]);
    for (const idx of indices) {
      if (excess <= 0) break;
      if (result[idx] > MIN_COL_WIDTH) {
        const reduce = Math.min(excess, result[idx] - MIN_COL_WIDTH);
        result[idx] -= reduce;
        excess -= reduce;
      }
    }
  }
  return result;
}

function calculateXlsxWidths(headers, tableWidthsConfig, docType) {
  const headerStr = headers.join('|');

  const configMatch = matchPatternLocal(headerStr, headers.length, tableWidthsConfig);
  if (configMatch) return normalizeWidths(configMatch);

  const smallHeaders = ['No', '코드', '필수', '길이', '타입', '값', '버전', '시작', '결과', '단계'];
  const mediumHeaders = ['날짜', '작성자', '변경 내용', '구분', '조건', '비고', '코드명'];
  const largeHeaders = ['설명', '내용', '용도', '항목', '규격', '정의', '비고'];

  const weights = headers.map(h => {
    const header = h.trim();
    if (smallHeaders.some(s => header.includes(s))) return 1;
    if (mediumHeaders.some(m => header.includes(m))) return 2;
    if (largeHeaders.some(l => header.includes(l))) return 4;
    return 2;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalWidth = 120;
  return weights.map(w => Math.max(8, Math.round((w / totalWeight) * totalWidth)));
}

function matchPatternLocal(headerStr, headerCount, widthsMap) {
  for (const [pattern, widths] of Object.entries(widthsMap)) {
    const keywords = pattern.split('|').map(k => k.trim());
    const allMatch = keywords.every(k => headerStr.includes(k));
    if (allMatch && widths.length === headerCount) {
      return widths;
    }
  }
  return null;
}

// ============================================================
// 커스텀 시트 렌더링 (xlsx.sheets[])
// ============================================================

/**
 * xlsx.sheets[] 배열의 커스텀 시트를 렌더링
 * @param {Object} wb - ExcelJS Workbook
 * @param {Object[]} sheetsConfig - xlsx.sheets[] 배열
 * @param {string} markdown - 전처리된 마크다운
 * @param {Object} config - doc-config
 * @param {Object} t - 템플릿 API
 */
function renderCustomSheets(wb, sheetsConfig, markdown, config, t) {
  const xlsxConfig = config.xlsx || {};
  const orientation = xlsxConfig.orientation || 'landscape';

  for (const sheetDef of sheetsConfig) {
    const sheetName = sheetDef.name || 'Sheet';
    const sheet = t.addSheet(wb, sheetName, { orientation });

    // 시트의 소스 섹션 추출
    let sectionLines;
    if (sheetDef.source) {
      sectionLines = extractSectionLines(markdown, sheetDef.source);
    } else {
      sectionLines = markdown.split('\n');
    }

    // sections[] 가 정의되어 있으면 세밀하게 렌더링
    if (sheetDef.sections && sheetDef.sections.length > 0) {
      let row = 1;
      for (const section of sheetDef.sections) {
        row = renderCustomSection(sheet, row, section, sectionLines, config, t, sheetDef);
      }
    } else {
      // sections[] 없으면 전체 섹션을 기본 렌더링
      const sectionOpts = {
        columnDefs: sheetDef.columnDefs || {},
        summaryRow: !!sheetDef.summaryRow,
        semanticColors: xlsxConfig.semanticColors || false,
      };
      renderSection(sheet, sectionLines, config, t, sectionOpts);
    }

    // 시트별 freeze/autoFilter 설정 (sections에서 이미 처리 안 된 경우)
    const sheetFreeze = sheetDef.freezeHeader !== undefined ? sheetDef.freezeHeader : (xlsxConfig.freezeHeaders !== false);
    const sheetAutoFilter = sheetDef.autoFilter !== undefined ? sheetDef.autoFilter : (xlsxConfig.autoFilter !== false);

    // 단일 테이블이면 freeze/filter 적용 (시트에 _lastTable이 있는 경우)
    if (sheet._lastTable && sheetFreeze) {
      t.freezeHeaderRow(sheet, sheet._lastTable.headerRowNum);
    }
    if (sheet._lastTable && sheetAutoFilter) {
      t.applyAutoFilter(sheet, 1, sheet._lastTable.headers.length, sheet._lastTable.headerRowNum);
    }
  }
}

/**
 * 커스텀 섹션 1개를 렌더링
 */
function renderCustomSection(sheet, row, section, sectionLines, config, t, sheetDef) {
  const type = section.type || 'table';
  const xlsxConfig = config.xlsx || {};
  const globalSemantic = xlsxConfig.semanticColors || false;

  switch (type) {
    case 'kpi-cards': {
      if (!section.cards || !section.cards.length) return row;
      let col = 1;
      const kpiRow = row;
      for (const card of section.cards) {
        // valueFrom: "키|값" 형태에서 MD 테이블의 해당 키-값을 추출
        let value = card.value;
        if (card.valueFrom) {
          value = extractValueFromTable(sectionLines, card.valueFrom) || card.value || '';
        }
        const result = t.writeKpiCard(sheet, kpiRow, col, {
          title: card.title,
          value,
          subtitle: card.subtitle,
          trend: card.trend,
          color: card.color || 'primary',
        });
        col = result.nextCol + 1; // 카드 사이 1열 간격
      }
      return kpiRow + 2 + 1; // KPI 카드 2행 + 1행 여백
    }

    case 'title': {
      const level = section.level || 3;
      row = t.writeTitle(sheet, row, section.text || '', level);
      return row;
    }

    case 'text': {
      row = t.writeText(sheet, row, section.text || '');
      return row;
    }

    case 'merged-header': {
      if (section.ranges) {
        row = t.writeMergedHeader(sheet, row, section.ranges);
      }
      return row;
    }

    case 'table': {
      // 섹션 소스 추출 (section.source가 있으면 하위 섹션만)
      let tableSourceLines = sectionLines;
      if (section.source) {
        tableSourceLines = extractSectionLines(
          sectionLines.join('\n'),
          section.source
        );
      }

      const columnDefs = section.columnDefs || sheetDef.columnDefs || {};
      const summaryRow = section.summaryRow || false;
      const enableSemantic = globalSemantic || !!section.semanticColors;

      // renderSection 호출하되 확장 옵션 전달
      const result = renderSection(sheet, tableSourceLines, config, t, {
        columnDefs,
        summaryRow,
        semanticColors: enableSemantic,
        customSemanticMap: section.customSemanticMap,
      });

      // freeze/autoFilter 개별 설정
      if (section.freezeHeader !== undefined) {
        if (section.freezeHeader && sheet._lastTable) {
          t.freezeHeaderRow(sheet, sheet._lastTable.headerRowNum);
        }
      }
      if (section.autoFilter !== undefined) {
        if (section.autoFilter && sheet._lastTable) {
          t.applyAutoFilter(sheet, 1, sheet._lastTable.headers.length, sheet._lastTable.headerRowNum);
        }
      }

      // row 위치는 sheet의 실제 마지막 행 + 1
      let maxRow = 1;
      sheet.eachRow((r, rowNumber) => { if (rowNumber > maxRow) maxRow = rowNumber; });
      return maxRow + 1;
    }

    default:
      return row;
  }
}

/**
 * MD 테이블에서 "키|값" 형태로 값 추출
 * 예: "총 호출 수|값" → 테이블에서 "총 호출 수" 행의 "값" 컬럼
 */
function extractValueFromTable(lines, valueFrom) {
  const parts = valueFrom.split('|').map(s => s.trim());
  if (parts.length < 2) return null;

  const rowKey = parts[0];
  const colKey = parts[1];

  // 테이블 찾기
  let i = 0;
  while (i < lines.length) {
    if (lines[i] && lines[i].trim().startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = core.parseTable(tableLines);
      if (parsed.length >= 2) {
        const headers = parsed[0];
        const colIdx = headers.findIndex(h => h.trim().includes(colKey));
        if (colIdx >= 0) {
          for (let r = 1; r < parsed.length; r++) {
            if (parsed[r][0] && parsed[r][0].trim().includes(rowKey)) {
              return parsed[r][colIdx] ? parsed[r][colIdx].trim() : null;
            }
          }
        }
      }
    } else {
      i++;
    }
  }
  return null;
}

// ============================================================
// 메인 빌드 함수
// ============================================================

/**
 * config JSON으로 XLSX 빌드 + 저장
 */
async function buildAndSave(config, projectRoot) {
  const baseDir = projectRoot || path.resolve(__dirname, '..');
  const xlsxConfig = config.xlsx || {};

  // 테마 해석 + 템플릿 로드
  const templateName = config.template || 'data-spec';
  const themeConfig = core.resolveTheme(config, baseDir);
  const t = loadXlsxTemplate(templateName, themeConfig);

  // 문서 정보
  const docInfo = config.docInfo || {};

  // 원본 읽기
  const sourcePath = path.join(baseDir, config.source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`원본 파일을 찾을 수 없습니다: ${sourcePath}`);
  }
  let markdown = fs.readFileSync(sourcePath, 'utf-8');

  // H1 + 메타데이터 + 목차 제거
  const h1Pattern = config.h1CleanPattern || null;
  const untilPattern = config.headerCleanUntil || '## 변경 이력';
  let contentCleaned = core.cleanMarkdownHeader(markdown, h1Pattern, untilPattern);

  // fallback: cleanMarkdownHeader가 실패하면 첫 H2까지 강제 제거
  if (contentCleaned.match(/^#\s+[^\n]/m)) {
    const firstH2 = contentCleaned.indexOf('\n## ');
    if (firstH2 > 0) {
      contentCleaned = contentCleaned.substring(firstH2 + 1);
    }
  }

  // 워크북 생성
  console.log(`Converting ${path.basename(config.source)} to XLSX...`);
  const wb = t.createWorkbook();

  // 표지 시트
  if (xlsxConfig.coverSheet !== false) {
    t.addCoverSheet(wb, docInfo);
  }

  // ── 커스텀 시트 (xlsx.sheets[]) vs 기존 sheetMapping ──
  if (xlsxConfig.sheets && xlsxConfig.sheets.length > 0) {
    // v2: AI가 설계한 커스텀 시트 구조
    renderCustomSheets(wb, xlsxConfig.sheets, contentCleaned, config, t);
  } else {
    // 기존: sheetMapping 기반 자동 분할
    const mapping = xlsxConfig.sheetMapping || 'h2';
    const sections = splitSections(contentCleaned, mapping, {
      skipSheets: xlsxConfig.skipSheets || [],
    });

    const orientation = xlsxConfig.orientation || 'landscape';
    const sheetResults = [];
    for (const section of sections) {
      const sheet = t.addSheet(wb, section.title, { orientation });
      const result = renderSection(sheet, section.lines, config, t, {
        semanticColors: xlsxConfig.semanticColors || false,
      });
      sheetResults.push({ sheet, result, name: sheet.name });
    }

    // 빈 시트 자동 제거
    for (const { sheet } of sheetResults) {
      if (sheet.rowCount < 3) {
        let hasContent = false;
        for (let r = 1; r <= sheet.rowCount; r++) {
          const row = sheet.getRow(r);
          if (row.getCell(1).value) { hasContent = true; break; }
        }
        if (!hasContent) {
          wb.removeWorksheet(sheet.id);
        }
      }
    }
  }

  // 출력 경로
  let outputFile = config.output;
  if (outputFile.includes('{version}')) {
    outputFile = outputFile.replace('{version}', docInfo.version || 'v1.0');
  }
  const outputPath = path.join(baseDir, outputFile);

  // 출력 디렉토리 확인
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 저장
  await t.saveWorkbook(wb, outputPath);
  console.log(`Done! → ${outputPath}`);

  return { outputPath };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  buildAndSave,
  splitSections,
  renderSection,
  calculateXlsxWidths,
  loadXlsxTemplate,
  extractSectionLines,
  renderCustomSheets,
};

/**
 * converter-xlsx.js — Markdown → XLSX 변환 엔진
 *
 * converter-core.js의 유틸리티(parseTable, calculateTableWidths, cleanMarkdownHeader, resolveTheme)를 재사용.
 * doc-config JSON과 함께 사용하여 XLSX 문서를 생성한다.
 *
 * 사용법: const xlsx = require('./converter-xlsx');
 *         xlsx.buildAndSave(config, projectRoot);
 */

const fs = require('fs');
const path = require('path');
const core = require('./converter-core');

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
 * @param {string} title - 시트 제목
 * @param {string[]} [customSkip] - 추가 스킵 제목 (doc-config xlsx.skipSheets)
 * @returns {boolean}
 */
function shouldSkipSheet(title, customSkip) {
  const lower = title.toLowerCase().replace(/^\d+\.\s*/, ''); // "1. 개요" → "개요"
  if (DEFAULT_SKIP_TITLES.includes(lower)) return true;
  if (customSkip && customSkip.some(s => lower === s.toLowerCase())) return true;
  return false;
}

/**
 * 마크다운을 섹션(시트) 배열로 분할
 * @param {string} markdown - 전처리된 마크다운
 * @param {string} mapping - 'h2' | 'h3' | 'single' | 'table'
 * @param {Object} [opts] - 옵션
 * @param {string[]} [opts.skipSheets] - 추가 스킵 시트 제목
 * @returns {Array<{title: string, lines: string[]}>}
 */
function splitSections(markdown, mapping, opts) {
  const lines = markdown.split('\n');
  const customSkip = (opts && opts.skipSheets) || [];

  if (mapping === 'single') {
    return [{ title: '데이터', lines }];
  }

  if (mapping === 'table') {
    // 테이블마다 시트
    const sections = [];
    let currentLines = [];
    let currentTitle = '일반';
    let lastTableHeader = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 제목 추적 (시트명 결정용)
      if (line.startsWith('## ')) {
        currentTitle = line.substring(3).trim();
      } else if (line.startsWith('### ')) {
        currentTitle = line.substring(4).trim();
      }

      // 테이블 시작 감지
      if (line.trim().startsWith('|')) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i]);
          i++;
        }
        i--; // for 루프가 i++ 하므로

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
    // H3 기준 분할 (시트명: "H2 - H3")
    const sections = [];
    let currentH2 = '';
    let currentSection = null;

    for (const line of lines) {
      if (line.startsWith('## ')) {
        if (currentSection) sections.push(currentSection);
        currentH2 = line.substring(3).trim();
        currentSection = null; // H2 단독으로는 시트 만들지 않음
      } else if (line.startsWith('### ')) {
        if (currentSection) sections.push(currentSection);
        const h3Title = line.substring(4).trim();
        const sheetTitle = currentH2 ? `${currentH2} - ${h3Title}` : h3Title;
        currentSection = { title: sheetTitle, lines: [] };
      } else {
        if (!currentSection) {
          // H3 이전 콘텐츠: H2가 있으면 H2 시트를 만들어서 담기
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
      if (!currentSection) {
        // H2 이전 콘텐츠는 버린다 (H1, 메타데이터, 목차 등)
        // cleanMarkdownHeader가 처리하지 못한 잔여물
        continue;
      }
      currentSection.lines.push(line);
    }
  }
  if (currentSection) sections.push(currentSection);

  return sections.filter(s => !shouldSkipSheet(s.title, customSkip));
}

/**
 * 섹션 내용을 시트에 렌더링
 */
function renderSection(sheet, sectionLines, config, t) {
  const tableWidthsConfig = config.tableWidths || {};
  const xlsxConfig = config.xlsx || {};
  const freezeHeaders = xlsxConfig.freezeHeaders !== false;
  const autoFilter = xlsxConfig.autoFilter !== false;
  const skipProse = xlsxConfig.skipProse !== false; // 기본: true (산문 스킵)
  const docType = config._docType || undefined;

  // 사전 스캔: 시트 내 최대 컬럼 수 파악 (테이블 헤더에서)
  let maxCols = 3; // 최소 3열 보장
  {
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
  }

  let row = 1;
  let i = 0;
  let firstTableHeaderRow = null;
  let tableCount = 0;

  while (i < sectionLines.length) {
    const line = sectionLines[i];

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue; }

    // --- 구분선 스킵
    if (line.trim() === '---') { i++; continue; }

    // # H1 스킵 (잔여물)
    if (line.startsWith('# ') && !line.startsWith('## ')) { i++; continue; }

    // ### H3 제목
    if (line.startsWith('### ')) {
      row = t.writeTitle(sheet, row, stripMarkdown(line.substring(4).trim()), 3, maxCols);
      i++; continue;
    }

    // #### H4 제목
    if (line.startsWith('#### ')) {
      row = t.writeTitle(sheet, row, stripMarkdown(line.substring(5).trim()), 4, maxCols);
      i++; continue;
    }

    // > 인용문 (blockquote)
    if (line.startsWith('> ')) {
      let quoteText = stripMarkdown(line.substring(2).trim());
      i++;
      while (i < sectionLines.length && sectionLines[i].startsWith('> ')) {
        quoteText += ' ' + stripMarkdown(sectionLines[i].substring(2).trim());
        i++;
      }
      if (quoteText.startsWith('주의') || quoteText.startsWith('중요')) {
        row = t.writeWarningBox(sheet, row, quoteText, maxCols);
      } else {
        row = t.writeInfoBox(sheet, row, quoteText, maxCols);
      }
      row++;
      continue;
    }

    // ```코드블록```
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < sectionLines.length && !sectionLines[i].trim().startsWith('```')) {
        codeLines.push(sectionLines[i]);
        i++;
      }
      i++; // 닫는 ``` 스킵
      if (codeLines.length > 0) {
        row = t.writeCodeBlock(sheet, row, codeLines, maxCols);
        row++;
      }
      continue;
    }

    // 테이블 | ... |
    if (line.trim().startsWith('|')) {
      const tableLines = [];
      while (i < sectionLines.length && sectionLines[i].trim().startsWith('|')) {
        tableLines.push(sectionLines[i]);
        i++;
      }

      const rows = core.parseTable(tableLines);
      if (rows.length >= 2) {
        const headers = rows[0];
        const dataRows = rows.slice(1);

        const widths = calculateXlsxWidths(headers, tableWidthsConfig, docType);

        tableCount++;
        if (!firstTableHeaderRow) {
          firstTableHeaderRow = row;
        }

        row = t.writeTable(sheet, row, headers, widths, dataRows);

        row++;
      }
      continue;
    }

    // ![이미지](경로) 스킵 (XLSX에서는 이미지 미지원)
    if (line.trim().match(/^!\[/)) { i++; continue; }

    // - 불릿 포인트
    if (line.trim().startsWith('- ')) {
      if (!skipProse) {
        row = t.writeBullet(sheet, row, stripMarkdown(line.trim().substring(2)), maxCols);
      }
      i++; continue;
    }

    // 숫자. 목록
    if (line.trim().match(/^\d+\.\s/)) {
      if (!skipProse) {
        row = t.writeBullet(sheet, row, stripMarkdown(line.trim().replace(/^\d+\.\s/, '')), maxCols);
      }
      i++; continue;
    }

    // **라벨:** 텍스트
    const labelMatch = line.trim().match(/^\*\*([^*]+):\*\*\s*(.*)?$/);
    if (labelMatch) {
      if (!skipProse) {
        const label = labelMatch[1] + ':';
        const content = stripMarkdown(labelMatch[2] || '');
        row = t.writeText(sheet, row, `${label} ${content}`, maxCols);
      }
      i++; continue;
    }

    // 일반 텍스트 (skipProse=true → 스킵)
    if (line.trim()) {
      if (!skipProse) {
        row = t.writeText(sheet, row, stripMarkdown(line.trim()), maxCols);
      }
    }
    i++;
  }

  // 테이블이 1개인 시트에서만 헤더 고정 + 자동 필터
  // 여러 테이블이면 첫 번째만 고정/필터되어 오히려 혼란
  if (tableCount === 1 && firstTableHeaderRow) {
    if (freezeHeaders) {
      t.freezeHeaderRow(sheet, firstTableHeaderRow);
    }
    if (autoFilter) {
      t.applyAutoFilter(sheet, 1, maxCols, firstTableHeaderRow);
    }
  }

  // 시트 레벨 컬럼 너비 정규화 (writeTable의 "only increase" 누적 방지)
  // 여러 테이블이 같은 시트에 있을 때 컬럼 너비가 누적되어 A4 초과 가능
  {
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

  return { maxCols, tableCount };
}

// A4 가로 인쇄 기준 최대 컬럼 너비 합계 (Excel 문자 폭 단위)
// 297mm - 좌우 마진 3.8cm = 259mm, ~2mm/char ≈ 130, 여유 포함 140
const MAX_TOTAL_WIDTH = 140;

/** 최소 너비 */
const MIN_COL_WIDTH = 8;

/**
 * 너비 배열이 MAX_TOTAL_WIDTH를 초과하면 비례 축소
 * 최소 너비 8 보장 + 잔여 초과분은 큰 컬럼에서 차감
 */
function normalizeWidths(widths) {
  return _normalizeSheetWidths(widths) || widths;
}

/**
 * 시트 레벨 너비 정규화 (공통 로직)
 * @returns {number[]|null} 정규화된 너비 또는 변경 불필요 시 null
 */
function _normalizeSheetWidths(widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= MAX_TOTAL_WIDTH) return null;

  // 1차: 비례 축소 (최소값 보장)
  const scale = MAX_TOTAL_WIDTH / total;
  const result = widths.map(w => Math.max(MIN_COL_WIDTH, Math.floor(w * scale)));

  // 2차: 최소값 보장으로 인한 초과분을 큰 컬럼에서 차감
  let excess = result.reduce((a, b) => a + b, 0) - MAX_TOTAL_WIDTH;
  if (excess > 0) {
    // 큰 컬럼부터 1씩 감소
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

/**
 * XLSX용 테이블 너비 계산 (Excel 문자 폭 단위)
 * doc-config의 tableWidths가 있으면 그대로 사용 (이미 문자 폭 단위).
 * 없으면 가중치 기반으로 자동 계산.
 * 최종적으로 A4 가로 인쇄 범위를 초과하면 비례 축소.
 */
function calculateXlsxWidths(headers, tableWidthsConfig, docType) {
  const headerStr = headers.join('|');

  // 1. doc-config에 정의된 패턴 매칭
  const configMatch = core.matchPattern
    ? matchPatternLocal(headerStr, headers.length, tableWidthsConfig)
    : null;
  if (configMatch) return normalizeWidths(configMatch);

  // 2. 가중치 기반 기본 너비 (Excel 문자 폭 단위, 총 ~120)
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
  const totalWidth = 120; // Excel 문자 폭 합계 기준
  return weights.map(w => Math.max(8, Math.round((w / totalWeight) * totalWidth)));
}

/**
 * 패턴 매칭 (converter-core의 matchPattern 로컬 버전)
 */
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
// 메인 빌드 함수
// ============================================================

/**
 * config JSON으로 XLSX 빌드 + 저장
 * @param {Object} config - doc-config JSON
 * @param {string} [projectRoot] - 프로젝트 루트 (기본: lib/../)
 * @returns {Promise<{outputPath: string}>}
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

  // fallback: cleanMarkdownHeader가 실패하면 (H1이 남아있으면) 첫 H2까지 강제 제거
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

  // 마크다운 → 섹션 분할
  const mapping = xlsxConfig.sheetMapping || 'h2';
  const sections = splitSections(contentCleaned, mapping, {
    skipSheets: xlsxConfig.skipSheets || [],
  });

  // 각 섹션을 시트로 렌더링
  const sheetResults = [];
  for (const section of sections) {
    const sheet = t.addSheet(wb, section.title);
    const result = renderSection(sheet, section.lines, config, t);
    sheetResults.push({ sheet, result, name: sheet.name });
  }

  // 빈 시트 자동 제거 (테이블 0개 + 행 3 미만)
  for (const { sheet } of sheetResults) {
    if (sheet.rowCount < 3) {
      // 테이블이 있는지 확인 (헤더 fill이 있으면 테이블 존재)
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
};

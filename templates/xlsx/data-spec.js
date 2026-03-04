/**
 * XLSX Template — Data Specification (데이터 명세)
 *
 * Factory pattern: module.exports = function createTemplate(theme) { return {...} }
 * 테마에서 colors와 fonts만 사용. sizes는 Excel 표준 고정값 사용 (DOCX 반포인트 단위 무시).
 *
 * Excel 표준 기준:
 *   - 기본 폰트: Malgun Gothic 10pt (Calibri 11pt 동등)
 *   - 기본 행 높이: 15pt (10pt 폰트 기준)
 *   - 기본 컬럼 너비: 8.43 문자
 *   - 헤더 행 높이: 20pt
 */

const ExcelJS = require('exceljs');

const DEFAULT_COLORS = {
  primary: '0E2841',
  white: 'FFFFFF',
  altRow: 'F2F2F2',
  border: 'D9D9D9',
  text: '333333',
  textLight: '808080',
  infoBox: 'DAEEF3',
  infoBoxText: '0E2841',
  warningBox: 'FFF2CC',
  warningBoxText: '8B4513',
  accent: 'E97132',
};

const DEFAULT_FONTS = { default: 'Malgun Gothic', code: 'Consolas' };

// Excel 전용 사이즈 (pt 단위, DOCX 테마 sizes 무시)
const XLSX_SIZES = {
  coverTitle: 18,
  coverSubtitle: 12,
  coverInfo: 10,
  h3: 11,
  h4: 10,
  header: 10,
  body: 10,
  code: 9,
};

// Excel 전용 행 높이 (pt 단위)
const ROW_HEIGHTS = {
  header: 20,
  body: 16,
  h3: 24,
  coverTitle: 30,
  coverSubtitle: 20,
  coverInfo: 18,
};

function createTemplate(theme = {}) {
  const C = { ...DEFAULT_COLORS, ...(theme.colors || {}) };
  const F = { ...DEFAULT_FONTS, ...(theme.fonts || {}) };
  // sizes는 DOCX 테마를 무시하고 Excel 전용 고정값 사용
  const S = XLSX_SIZES;

  // ── 공통 스타일 헬퍼 ──

  const thinBorder = {
    style: 'thin',
    color: { argb: 'FF' + C.border },
  };
  const allBorders = {
    top: thinBorder,
    bottom: thinBorder,
    left: thinBorder,
    right: thinBorder,
  };

  function headerFill() {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.primary } };
  }
  function altRowFill() {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.altRow } };
  }

  function headerFont() {
    return { name: F.default, size: S.header, bold: true, color: { argb: 'FF' + C.white } };
  }
  function bodyFont(size, opts = {}) {
    return { name: F.default, size: size || S.body, color: { argb: 'FF' + C.text }, ...opts };
  }

  // ── Public API ──

  function createWorkbook() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'gendocs';
    wb.created = new Date();
    return wb;
  }

  async function saveWorkbook(wb, filePath) {
    await wb.xlsx.writeFile(filePath);
  }

  /**
   * 시트 추가 (이름 31자 제한 + 특수문자 치환)
   */
  function addSheet(wb, name) {
    let safeName = name
      .replace(/[\\/*?\[\]:]/g, ' ')
      .trim()
      .substring(0, 31);
    if (!safeName) safeName = 'Sheet';
    // 중복 이름 방지
    let finalName = safeName;
    let idx = 2;
    while (wb.worksheets.some(ws => ws.name === finalName)) {
      const suffix = ` (${idx})`;
      finalName = safeName.substring(0, 31 - suffix.length) + suffix;
      idx++;
    }
    const sheet = wb.addWorksheet(finalName);
    // 인쇄 설정: A4 가로, 커스텀 여백 0.5in, 가로 중앙 정렬
    sheet.pageSetup = {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    };
    // 뷰 설정: 그리드라인 OFF (모던 클린 스타일)
    sheet.views = [{ zoomScale: 100, showGridLines: false }];
    // 인쇄 푸터: 페이지 번호
    sheet.headerFooter = { oddFooter: '&C&P / &N' };
    return sheet;
  }

  /**
   * 표지 시트 (제목, 버전, 작성자 등)
   */
  function addCoverSheet(wb, docInfo) {
    const sheet = addSheet(wb, '표지');

    // 컬럼 너비
    sheet.getColumn(1).width = 3;
    sheet.getColumn(2).width = 16;
    sheet.getColumn(3).width = 40;
    sheet.getColumn(4).width = 3;

    let row = 2; // 1 빈 행 후 시작

    // 제목
    const titleRow = sheet.getRow(row);
    titleRow.height = ROW_HEIGHTS.coverTitle;
    sheet.mergeCells(row, 2, row, 3);
    const titleCell = titleRow.getCell(2);
    titleCell.value = docInfo.title || '문서 제목';
    titleCell.font = { name: F.default, size: S.coverTitle, bold: true, color: { argb: 'FF' + C.primary } };
    titleCell.alignment = { vertical: 'middle' };
    row += 1;

    // 부제목
    if (docInfo.subtitle) {
      const subRow = sheet.getRow(row);
      subRow.height = ROW_HEIGHTS.coverSubtitle;
      sheet.mergeCells(row, 2, row, 3);
      const subCell = subRow.getCell(2);
      subCell.value = docInfo.subtitle;
      subCell.font = { name: F.default, size: S.coverSubtitle, color: { argb: 'FF' + C.textLight } };
      subCell.alignment = { vertical: 'middle' };
      row += 1;
    }

    row += 1; // 빈 줄 1행

    // 문서 정보 테이블
    const infoFields = [
      ['버전', docInfo.version],
      ['작성자', docInfo.author],
      ['회사', docInfo.company],
      ['작성일', docInfo.createdDate],
      ['최종 수정일', docInfo.modifiedDate],
    ].filter(([, v]) => v);

    for (const [label, value] of infoFields) {
      const r = sheet.getRow(row);
      r.height = ROW_HEIGHTS.coverInfo;
      const labelCell = r.getCell(2);
      labelCell.value = label;
      labelCell.font = bodyFont(S.coverInfo, { bold: true });
      labelCell.border = allBorders;
      labelCell.fill = altRowFill();
      labelCell.alignment = { vertical: 'middle' };

      const valCell = r.getCell(3);
      valCell.value = value;
      valCell.font = bodyFont(S.coverInfo);
      valCell.border = allBorders;
      valCell.alignment = { vertical: 'middle' };
      row++;
    }

    return sheet;
  }

  /**
   * 타이틀 행 (H3/H4 → A열에 텍스트, 병합 없음)
   */
  function writeTitle(sheet, row, text, level, colCount) {
    const r = sheet.getRow(row);
    r.height = ROW_HEIGHTS.h3;
    const cell = r.getCell(1);
    cell.value = text;
    const size = level <= 3 ? S.h3 : S.h4;
    const isBold = level <= 3;
    cell.font = { name: F.default, size, bold: isBold, color: { argb: 'FF' + C.primary } };
    cell.alignment = { vertical: 'bottom' };
    if (level <= 3) {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF' + C.primary } } };
    }
    return row + 1;
  }

  /**
   * 일반 텍스트 행
   */
  function writeText(sheet, row, text, colCount) {
    const cell = sheet.getRow(row).getCell(1);
    cell.value = text;
    cell.font = bodyFont(S.body);
    cell.alignment = { vertical: 'middle', wrapText: true };
    return row + 1;
  }

  /**
   * 불릿 텍스트 행
   */
  function writeBullet(sheet, row, text, colCount) {
    const cell = sheet.getRow(row).getCell(1);
    cell.value = '  • ' + text;
    cell.font = bodyFont(S.body);
    cell.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
    return row + 1;
  }

  /**
   * 정보 박스 (파란 배경)
   */
  function writeInfoBox(sheet, row, text, colCount) {
    const cols = colCount || 6;
    sheet.mergeCells(row, 1, row, cols);
    const cell = sheet.getRow(row).getCell(1);
    cell.value = 'ℹ ' + text;
    cell.font = { name: F.default, size: S.body, color: { argb: 'FF' + C.infoBoxText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.infoBox } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = allBorders;
    return row + 1;
  }

  /**
   * 경고 박스 (노란 배경)
   */
  function writeWarningBox(sheet, row, text, colCount) {
    const cols = colCount || 6;
    sheet.mergeCells(row, 1, row, cols);
    const cell = sheet.getRow(row).getCell(1);
    cell.value = '⚠ ' + text;
    cell.font = { name: F.default, size: S.body, color: { argb: 'FF' + C.warningBoxText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.warningBox } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = allBorders;
    return row + 1;
  }

  /**
   * 테이블 작성 (헤더 + 데이터 행)
   * @param {ExcelJS.Worksheet} sheet
   * @param {number} startRow
   * @param {string[]} headers
   * @param {number[]} widths - Excel 문자 폭 단위
   * @param {string[][]} rows - 데이터 행
   * @returns {number} 다음 행 번호
   */
  function writeTable(sheet, startRow, headers, widths, rows) {
    let r = startRow;

    // 열 너비 설정
    for (let c = 0; c < headers.length; c++) {
      const col = sheet.getColumn(c + 1);
      const newWidth = widths[c] || 15;
      if (!col.width || col.width < newWidth) {
        col.width = newWidth;
      }
    }

    // 헤더 행 (하단 medium 테두리로 데이터와 시각적 분리)
    const headerRow = sheet.getRow(r);
    headerRow.height = ROW_HEIGHTS.header;
    const headerBottomBorder = { style: 'medium', color: { argb: 'FF' + C.primary } };
    for (let c = 0; c < headers.length; c++) {
      const cell = headerRow.getCell(c + 1);
      cell.value = headers[c];
      cell.font = headerFont();
      cell.fill = headerFill();
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { top: thinBorder, bottom: headerBottomBorder, left: thinBorder, right: thinBorder };
    }
    r++;

    // 데이터 행
    for (let ri = 0; ri < rows.length; ri++) {
      const dataRow = sheet.getRow(r);
      dataRow.height = ROW_HEIGHTS.body;
      const isAlt = ri % 2 === 1;
      for (let c = 0; c < headers.length; c++) {
        const cell = dataRow.getCell(c + 1);
        cell.value = (rows[ri] && rows[ri][c]) || '';
        cell.font = bodyFont(S.body);
        if (isAlt) {
          cell.fill = altRowFill();
        }
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.border = allBorders;
      }
      r++;
    }

    return r;
  }

  /**
   * 자동 필터 적용
   */
  function applyAutoFilter(sheet, fromCol, toCol, headerRow) {
    sheet.autoFilter = {
      from: { row: headerRow, column: fromCol },
      to: { row: headerRow, column: toCol },
    };
  }

  /**
   * 헤더 행 고정 (freeze panes)
   */
  function freezeHeaderRow(sheet, row) {
    sheet.views = [{ state: 'frozen', ySplit: row, zoomScale: 100, showGridLines: false }];
  }

  /**
   * 열 너비 설정
   */
  function setColumnWidths(sheet, widths) {
    for (let i = 0; i < widths.length; i++) {
      sheet.getColumn(i + 1).width = widths[i];
    }
  }

  /**
   * 코드 블록 행 (모노스페이스 회색 배경)
   */
  function writeCodeBlock(sheet, row, codeLines, colCount) {
    const cols = colCount || 6;
    for (const line of codeLines) {
      sheet.mergeCells(row, 1, row, cols);
      const cell = sheet.getRow(row).getCell(1);
      cell.value = line;
      cell.font = { name: F.code, size: S.code, color: { argb: 'FF333333' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
      cell.alignment = { vertical: 'middle' };
      row++;
    }
    return row;
  }

  return {
    createWorkbook,
    saveWorkbook,
    addSheet,
    addCoverSheet,
    writeTitle,
    writeText,
    writeBullet,
    writeInfoBox,
    writeWarningBox,
    writeTable,
    writeCodeBlock,
    applyAutoFilter,
    freezeHeaderRow,
    setColumnWidths,
  };
}

module.exports = createTemplate;

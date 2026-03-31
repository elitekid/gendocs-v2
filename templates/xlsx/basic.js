/**
 * XLSX Template — Basic (기본)
 *
 * data-spec의 심플 버전. 표지 시트 없이 데이터만.
 * Factory pattern: module.exports = function createTemplate(theme) { return {...} }
 *
 * Excel 표준 기준: Malgun Gothic 10pt, 행 높이 16pt
 * 모던 스타일: 그리드라인 OFF, 커스텀 여백, 헤더 medium 하단 테두리
 */

const ExcelJS = require('exceljs');
const xlsxUtils = require('../../lib/xlsx-utils');

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

// Excel 전용 사이즈 (DOCX 테마 sizes 무시)
const XLSX_SIZES = {
  h3: 11, h4: 10, header: 10, body: 10, code: 9,
  kpiValue: 22, kpiTitle: 10, kpiSubtitle: 9,
};
const ROW_HEIGHTS = {
  header: 20, body: 16, h3: 24, summary: 20,
  kpiTop: 32, kpiBottom: 18,
};

function createTemplate(theme = {}) {
  const C = { ...DEFAULT_COLORS, ...(theme.colors || {}) };
  const F = { ...DEFAULT_FONTS, ...(theme.fonts || {}) };
  const S = XLSX_SIZES;

  const thinBorder = { style: 'thin', color: { argb: 'FF' + C.border } };
  const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

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

  function createWorkbook() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'gendocs';
    wb.created = new Date();
    return wb;
  }

  async function saveWorkbook(wb, filePath) {
    await wb.xlsx.writeFile(filePath);
  }

  function addSheet(wb, name, opts) {
    const sheetOpts = opts || {};
    let safeName = name.replace(/[\\/*?\[\]:]/g, ' ').trim().substring(0, 31);
    if (!safeName) safeName = 'Sheet';
    let finalName = safeName;
    let idx = 2;
    while (wb.worksheets.some(ws => ws.name === finalName)) {
      const suffix = ` (${idx})`;
      finalName = safeName.substring(0, 31 - suffix.length) + suffix;
      idx++;
    }
    const sheet = wb.addWorksheet(finalName);
    const orientation = sheetOpts.orientation || 'landscape';
    sheet.pageSetup = {
      paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    };
    sheet.views = [{ zoomScale: 100, showGridLines: false }];
    sheet.headerFooter = { oddFooter: '&C&P / &N' };
    return sheet;
  }

  function addCoverSheet() { return null; }

  function writeTitle(sheet, row, text, level) {
    const r = sheet.getRow(row);
    r.height = ROW_HEIGHTS.h3;
    const cell = r.getCell(1);
    cell.value = text;
    cell.font = { name: F.default, size: level <= 3 ? S.h3 : S.h4, bold: level <= 3, color: { argb: 'FF' + C.primary } };
    cell.alignment = { vertical: 'bottom' };
    if (level <= 3) {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF' + C.primary } } };
    }
    return row + 1;
  }

  function writeText(sheet, row, text) {
    const cell = sheet.getRow(row).getCell(1);
    cell.value = text;
    cell.font = bodyFont(S.body);
    cell.alignment = { vertical: 'middle', wrapText: true };
    return row + 1;
  }

  function writeBullet(sheet, row, text) {
    const cell = sheet.getRow(row).getCell(1);
    cell.value = '  • ' + text;
    cell.font = bodyFont(S.body);
    cell.alignment = { vertical: 'middle', wrapText: true };
    return row + 1;
  }

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

  function writeTable(sheet, startRow, headers, widths, rows, opts) {
    const options = opts || {};
    const columnDefs = options.columnDefs || {};
    const enableSemantic = options.semanticColors || false;
    const enableRichText = options.richText !== false;
    let r = startRow;

    for (let c = 0; c < headers.length; c++) {
      const col = sheet.getColumn(c + 1);
      const newWidth = widths[c] || 15;
      if (!col.width || col.width < newWidth) col.width = newWidth;
    }

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
    const headerRowNum = r;
    r++;

    const dataStartRow = r;

    for (let ri = 0; ri < rows.length; ri++) {
      const dataRow = sheet.getRow(r);
      dataRow.height = ROW_HEIGHTS.body;
      const isAlt = ri % 2 === 1;
      for (let c = 0; c < headers.length; c++) {
        const cell = dataRow.getCell(c + 1);
        const rawValue = (rows[ri] && rows[ri][c]) || '';
        const headerName = headers[c].trim();
        const colDef = columnDefs[headerName] || {};
        const colType = colDef.type || 'text';

        if (colType !== 'text' && colType !== 'status' && colType !== 'code') {
          if (colDef.formula) {
            const formulaStr = xlsxUtils.resolveFormula(
              colDef.formula, headers, headerName, r, null
            );
            cell.value = { formula: formulaStr };
          } else {
            const converted = xlsxUtils.convertCellValue(rawValue, colType);
            cell.value = converted.value;
            if (converted.numFmt) cell.numFmt = converted.numFmt;
          }
        } else if (enableRichText && rawValue) {
          const richValue = xlsxUtils.parseInlineMarkdown(rawValue, {
            defaultFont: F.default, codeFont: F.code, fontSize: S.body, colors: { text: C.text },
          });
          cell.value = richValue;
        } else {
          cell.value = rawValue;
        }

        cell.font = bodyFont(S.body);
        if (isAlt) cell.fill = altRowFill();
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.border = allBorders;

        if (colType === 'number' || colType === 'percentage' || colType === 'date') {
          cell.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
        }
        if (colType === 'code') {
          cell.font = { name: F.code, size: S.body, color: { argb: 'FF' + C.text } };
        }

        if (colType === 'status' || (enableSemantic && typeof cell.value === 'string')) {
          xlsxUtils.applySemanticColor(cell, String(rawValue), options.customSemanticMap);
        }
      }
      r++;
    }

    const dataEndRow = r - 1;
    sheet._lastTable = { headerRowNum, dataStartRow, dataEndRow, headers, columnDefs };

    return r;
  }

  function writeSummaryRow(sheet, row, overrides) {
    const tableInfo = sheet._lastTable;
    if (!tableInfo) return row;

    const ov = overrides || {};
    const label = ov.label || '합계';
    const headers = tableInfo.headers;
    const colDefs = ov.columnDefs || tableInfo.columnDefs || {};
    const dataStartRow = tableInfo.dataStartRow;
    const dataEndRow = tableInfo.dataEndRow;

    const summaryR = sheet.getRow(row);
    summaryR.height = ROW_HEIGHTS.summary;

    let labelWritten = false;
    for (let c = 0; c < headers.length; c++) {
      const cell = summaryR.getCell(c + 1);
      const headerName = headers[c].trim();
      const colDef = colDefs[headerName] || {};
      const summaryFn = colDef.summary;

      if (summaryFn) {
        const cl = xlsxUtils.colLetter(c);
        const range = `${cl}${dataStartRow}:${cl}${dataEndRow}`;
        let formula;
        switch (summaryFn) {
          case 'sum': formula = `SUM(${range})`; break;
          case 'average': formula = `AVERAGE(${range})`; break;
          case 'count': formula = `COUNTA(${range})`; break;
          case 'min': formula = `MIN(${range})`; break;
          case 'max': formula = `MAX(${range})`; break;
          default: formula = null;
        }
        if (formula) {
          cell.value = { formula };
          if (colDef.type === 'percentage') cell.numFmt = '0.0%';
          else if (colDef.type === 'number') cell.numFmt = '#,##0';
        }
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
      } else if (!labelWritten) {
        cell.value = label;
        labelWritten = true;
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      } else {
        cell.value = '';
        cell.alignment = { vertical: 'middle' };
      }

      cell.font = bodyFont(S.body, { bold: true });
      cell.border = {
        top: { style: 'medium', color: { argb: 'FF' + C.primary } },
        bottom: thinBorder, left: thinBorder, right: thinBorder,
      };
    }
    return row + 1;
  }

  function writeKpiCard(sheet, startRow, startCol, card) {
    const colSpan = 2;
    const endCol = startCol + colSpan - 1;

    let bgColor, fgColor;
    switch (card.color) {
      case 'primary': bgColor = C.primary; fgColor = C.white; break;
      case 'accent': bgColor = C.accent; fgColor = C.white; break;
      case 'success': bgColor = '375623'; fgColor = 'FFFFFF'; break;
      case 'error': bgColor = 'C62828'; fgColor = 'FFFFFF'; break;
      default: bgColor = card.color || C.primary; fgColor = C.white;
    }

    sheet.mergeCells(startRow, startCol, startRow, endCol);
    const valueRow = sheet.getRow(startRow);
    valueRow.height = ROW_HEIGHTS.kpiTop;
    const valueCell = valueRow.getCell(startCol);
    valueCell.value = card.value != null ? card.value : '';
    valueCell.font = { name: F.default, size: S.kpiValue, bold: true, color: { argb: 'FF' + fgColor } };
    valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgColor } };
    valueCell.alignment = { vertical: 'bottom', horizontal: 'center' };
    valueCell.border = { top: thinBorder, left: thinBorder, right: thinBorder };

    const subtitleRowNum = startRow + 1;
    sheet.mergeCells(subtitleRowNum, startCol, subtitleRowNum, endCol);
    const subRow = sheet.getRow(subtitleRowNum);
    subRow.height = ROW_HEIGHTS.kpiBottom;
    const subCell = subRow.getCell(startCol);
    let titleText = card.title || '';
    if (card.subtitle) titleText += `  (${card.subtitle})`;
    if (card.trend) {
      const arrow = card.trend === 'up' ? '↑' : card.trend === 'down' ? '↓' : '';
      titleText += ` ${arrow}`;
    }
    subCell.value = titleText;
    subCell.font = { name: F.default, size: S.kpiTitle, color: { argb: 'FF' + fgColor } };
    subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgColor } };
    subCell.alignment = { vertical: 'top', horizontal: 'center' };
    subCell.border = { bottom: thinBorder, left: thinBorder, right: thinBorder };

    return { nextRow: subtitleRowNum + 1, nextCol: endCol + 1 };
  }

  function writeMergedHeader(sheet, row, mergeRanges) {
    const r = sheet.getRow(row);
    r.height = ROW_HEIGHTS.header;
    for (const range of mergeRanges) {
      if (range.fromCol !== range.toCol) {
        sheet.mergeCells(row, range.fromCol, row, range.toCol);
      }
      const cell = r.getCell(range.fromCol);
      cell.value = range.text;
      cell.font = headerFont();
      cell.fill = headerFill();
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
    }
    return row + 1;
  }

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

  function applyAutoFilter(sheet, fromCol, toCol, headerRow) {
    sheet.autoFilter = { from: { row: headerRow, column: fromCol }, to: { row: headerRow, column: toCol } };
  }

  function freezeHeaderRow(sheet, row) {
    sheet.views = [{ state: 'frozen', ySplit: row, zoomScale: 100, showGridLines: false }];
  }

  function setColumnWidths(sheet, widths) {
    for (let i = 0; i < widths.length; i++) sheet.getColumn(i + 1).width = widths[i];
  }

  return {
    createWorkbook, saveWorkbook, addSheet, addCoverSheet,
    writeTitle, writeText, writeBullet, writeInfoBox, writeWarningBox,
    writeTable, writeSummaryRow, writeKpiCard, writeMergedHeader,
    writeCodeBlock, applyAutoFilter, freezeHeaderRow, setColumnWidths,
  };
}

module.exports = createTemplate;

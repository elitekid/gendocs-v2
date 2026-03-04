/**
 * validate-xlsx.js — XLSX 구조 검증
 *
 * exceljs로 XLSX를 읽어 구조 분석 + 이슈 감지.
 * JSON 출력 (validate-docx.py와 동일 패턴): stats, issues, sheets
 *
 * 사용법: node tools/validate-xlsx.js output/문서.xlsx --json
 *         node tools/validate-xlsx.js output/문서.xlsx
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

async function validateXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const issues = [];
  const sheetDetails = [];

  let totalRows = 0;
  let totalTables = 0;
  let totalCells = 0;

  for (const sheet of wb.worksheets) {
    const sheetInfo = {
      name: sheet.name,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
      tables: 0,
      headerRows: [],
    };

    // 시트 이름 길이 검사
    if (sheet.name.length > 31) {
      issues.push({
        severity: 'WARN',
        type: 'SHEET_NAME_TOO_LONG',
        sheet: sheet.name,
        message: `시트명이 31자 초과: "${sheet.name}" (${sheet.name.length}자)`,
      });
    }

    // 빈 시트 검사
    if (sheet.rowCount === 0) {
      issues.push({
        severity: 'WARN',
        type: 'EMPTY_SHEET',
        sheet: sheet.name,
        message: `빈 시트: "${sheet.name}"`,
      });
      sheetDetails.push(sheetInfo);
      continue;
    }

    // 데이터가 1행만 있는 시트 (표지 등은 제외)
    if (sheet.rowCount <= 1 && sheet.name !== '표지') {
      issues.push({
        severity: 'INFO',
        type: 'MINIMAL_SHEET',
        sheet: sheet.name,
        message: `시트에 데이터가 거의 없음: "${sheet.name}" (${sheet.rowCount}행)`,
      });
    }

    // 헤더행 감지 + 테이블 카운트
    let hasTableHeader = false;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // 헤더행 감지: fill이 있고, 글자가 bold인 행
      let filledCells = 0;
      let boldCells = 0;
      let nonEmptyCells = 0;

      row.eachCell({ includeEmpty: false }, (cell) => {
        nonEmptyCells++;
        if (cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb &&
            cell.fill.fgColor.argb !== 'FF000000' && cell.fill.fgColor.argb !== '00000000') {
          filledCells++;
        }
        if (cell.font && cell.font.bold) {
          boldCells++;
        }
      });

      if (nonEmptyCells >= 2 && filledCells >= 2 && boldCells >= 2) {
        sheetInfo.headerRows.push(rowNumber);
        sheetInfo.tables++;
        hasTableHeader = true;
      }

      totalCells += nonEmptyCells;
    });

    // 테이블 헤더 없음 검사 (표지 제외)
    if (!hasTableHeader && sheet.name !== '표지') {
      issues.push({
        severity: 'INFO',
        type: 'MISSING_HEADER',
        sheet: sheet.name,
        message: `테이블 헤더를 감지하지 못함: "${sheet.name}"`,
      });
    }

    // 좁은 컬럼 검사
    for (let c = 1; c <= sheet.columnCount; c++) {
      const col = sheet.getColumn(c);
      if (col.width && col.width < 5) {
        issues.push({
          severity: 'INFO',
          type: 'NARROW_COLUMN',
          sheet: sheet.name,
          message: `좁은 컬럼: "${sheet.name}" 열 ${c} (너비 ${col.width})`,
        });
      }
    }

    totalRows += sheet.rowCount;
    totalTables += sheetInfo.tables;
    sheetDetails.push(sheetInfo);
  }

  // 콘텐츠 부족 검사
  if (totalTables === 0) {
    issues.push({
      severity: 'WARN',
      type: 'CONTENT_MISSING',
      message: '전체 워크북에 테이블 헤더가 없습니다',
    });
  }

  const stats = {
    sheets: wb.worksheets.length,
    totalRows,
    totalTables,
    totalCells,
    warnCount: issues.filter(i => i.severity === 'WARN').length,
    infoCount: issues.filter(i => i.severity === 'INFO').length,
  };

  return { stats, issues, sheets: sheetDetails };
}

// ── CLI ──

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('사용법: node tools/validate-xlsx.js <file.xlsx> [--json]');
    process.exit(0);
  }

  const filePath = path.resolve(args[0]);
  const jsonMode = args.includes('--json');

  if (!fs.existsSync(filePath)) {
    console.error(`[ERROR] 파일 없음: ${filePath}`);
    process.exit(1);
  }

  const report = await validateXlsx(filePath);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nXLSX 검증 결과: ${path.basename(filePath)}`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`  시트: ${report.stats.sheets}개`);
    console.log(`  전체 행: ${report.stats.totalRows}`);
    console.log(`  테이블: ${report.stats.totalTables}개`);
    console.log(`  WARN: ${report.stats.warnCount}건`);
    console.log(`  INFO: ${report.stats.infoCount}건`);

    if (report.issues.length > 0) {
      console.log(`\n이슈:`);
      for (const issue of report.issues) {
        console.log(`  [${issue.severity}] ${issue.message}`);
      }
    }

    console.log(`\n시트 상세:`);
    for (const s of report.sheets) {
      console.log(`  "${s.name}" — ${s.rows}행, ${s.columns}열, 테이블 ${s.tables}개`);
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(1);
  });
}

module.exports = { validateXlsx };

/**
 * Generic Converter 진입점
 *
 * 사용법: node lib/convert.js doc-configs/api-spec.json
 *         node lib/convert.js doc-configs/api-spec.json --validate
 *
 * 포맷: config.format 또는 output 확장자로 자동 감지
 *   - .docx → DOCX (기본)
 *   - .xlsx → XLSX
 */

const fs = require('fs');
const path = require('path');
const core = require('./converter-core');
const xlsx = require('./converter-xlsx');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('사용법: node lib/convert.js <config.json> [--validate]');
    console.log('');
    console.log('  config.json    doc-configs/ 내 문서 설정 파일');
    console.log('  --validate     변환 후 자동 검증 실행');
    console.log('');
    console.log('예시:');
    console.log('  node lib/convert.js doc-configs/api-spec.json');
    console.log('  node lib/convert.js doc-configs/api-spec.json --validate');
    process.exit(0);
  }

  const configPath = path.resolve(args[0]);
  const doValidate = args.includes('--validate');

  if (!fs.existsSync(configPath)) {
    console.error(`[ERROR] 설정 파일을 찾을 수 없습니다: ${configPath}`);
    process.exit(1);
  }

  // config 로드
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  config._docType = path.basename(configPath, '.json'); // patterns.json byDocType 매칭용
  const projectRoot = path.resolve(__dirname, '..');

  // 포맷 감지
  const format = config.format || (config.output && config.output.endsWith('.xlsx') ? 'xlsx' : 'docx');

  // 빌드
  let result;
  if (format === 'xlsx') {
    result = await xlsx.buildAndSave(config, projectRoot);
  } else {
    result = await core.buildAndSave(config, projectRoot);
  }

  // 검증 (선택)
  if (doValidate) {
    const { execSync } = require('child_process');

    if (format === 'xlsx') {
      // XLSX 검증
      const validateCmd = `node tools/validate-xlsx.js "${result.outputPath}" --json`;
      console.log(`\nValidating: ${validateCmd}`);
      try {
        const output = execSync(validateCmd, { cwd: projectRoot, encoding: 'utf-8' });
        const report = JSON.parse(output);

        const warns = report.issues.filter(i => i.severity === 'WARN');
        const infos = report.issues.filter(i => i.severity === 'INFO');

        console.log(`\n검증 결과: ${report.stats.sheets}시트, WARN ${warns.length}건, INFO ${infos.length}건`);

        if (warns.length > 0) {
          console.log('\n[WARN 항목]');
          for (const w of warns) {
            console.log(`  ${w.sheet || '-'}: ${w.message}`);
          }
        }

        const reportPath = result.outputPath.replace('.xlsx', '.validate.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
        console.log(`\n검증 리포트: ${reportPath}`);
      } catch (err) {
        console.error('[ERROR] 검증 실패:', err.message);
      }
    } else {
      // DOCX 검증
      const validateCmd = `python -X utf8 tools/validate-docx.py "${result.outputPath}" --json`;
      console.log(`\nValidating: ${validateCmd}`);
      try {
        const output = execSync(validateCmd, { cwd: projectRoot, encoding: 'utf-8' });
        const report = JSON.parse(output);

        const warns = report.issues.filter(i => i.severity === 'WARN');
        const infos = report.issues.filter(i => i.severity === 'INFO');

        console.log(`\n검증 결과: ${report.stats.estimatedPages}p, WARN ${warns.length}건, INFO ${infos.length}건`);

        if (warns.length > 0) {
          console.log('\n[WARN 항목]');
          for (const w of warns) {
            console.log(`  p.${w.page || '-'}: ${w.message}`);
          }
        }

        const reportPath = result.outputPath.replace('.docx', '.validate.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
        console.log(`\n검증 리포트: ${reportPath}`);
      } catch (err) {
        console.error('[ERROR] 검증 실패:', err.message);
      }
    }
  }
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * tests/verify-ir-coverage.js
 *
 * doc-config의 모든 설정 키가 IR 스키마 필드로 매핑 가능한지 검증.
 * Phase 1 완료 시점에서 매핑 테이블의 완전성만 확인.
 * 실제 변환은 Phase 2(md-parser)에서 구현.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const EXAMPLES = [
  'examples/sample-api/doc-config.json',
  'examples/sample-batch/doc-config.json',
  'examples/sample-code-def/doc-config.json',
];

// doc-config 키 → IR 매핑 테이블
const MAPPING = {
  // 직접 매핑 (ir.meta.*)
  'source':         { ir: '파서 입력 경로', note: 'IR 외부' },
  'output':         { ir: '렌더러 출력 경로', note: 'IR 외부' },
  'template':       { ir: 'ir.styles (테마 프리셋)', note: '간접' },
  'theme':          { ir: 'ir.styles.theme', note: '직접' },
  'format':         { ir: '렌더러 선택', note: 'IR 외부' },
  'docInfo':        { ir: 'ir.meta.*', note: '직접 (title, version, author 등)' },
  '_meta':          { ir: '내부 메타데이터', note: 'IR 외부' },

  // 파서 옵션 (IR 외부)
  'h1CleanPattern':   { ir: '파서 옵션', note: 'IR 외부' },
  'headerCleanUntil': { ir: '파서 옵션', note: 'IR 외부' },

  // IR에 직접 포함되는 것
  'tableWidths':    { ir: 'table.columns[].width', note: 'DXA→pt 변환 (Phase 2)', phase: 2 },
  'pageBreaks':     { ir: 'ir.breakRules[]', note: 'breakRule 변환 (Phase 3)', phase: 3 },
  'images':         { ir: 'content[] image 노드', note: '직접', phase: 2 },
  'diagrams':       { ir: 'content[] image 노드 (렌더링 후)', note: 'transformer', phase: 2 },
  'style':          { ir: 'ir.styles 오버라이드', note: '직접', phase: 2 },
  'orientation':    { ir: 'ir.layout.orientation', note: '직접' },

  // XLSX 전용
  'xlsx':           { ir: 'ir.sheets[] / ir.extensions.xlsx', note: '직접', phase: 2 },
};

function main() {
  let totalKeys = 0;
  let coveredKeys = 0;
  let uncoveredKeys = [];
  let passed = true;

  for (const configPath of EXAMPLES) {
    const fullPath = path.join(PROJECT_ROOT, configPath);
    if (!fs.existsSync(fullPath)) {
      console.log(`  SKIP: ${configPath} (없음)`);
      continue;
    }

    const config = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    const topKeys = Object.keys(config);

    console.log(`\n  === ${path.basename(configPath)} (${topKeys.length}개 키) ===`);

    for (const key of topKeys) {
      totalKeys++;
      const mapping = MAPPING[key];
      if (mapping) {
        coveredKeys++;
        const phaseNote = mapping.phase ? ` [Phase ${mapping.phase}]` : '';
        console.log(`    OK: ${key} → ${mapping.ir}${phaseNote}`);
      } else {
        uncoveredKeys.push(`${path.basename(configPath)}:${key}`);
        console.log(`    ?? : ${key} — 매핑 없음`);
        passed = false;
      }
    }
  }

  console.log(`\n  === 요약 ===`);
  console.log(`  전체 키: ${totalKeys}, 커버: ${coveredKeys}, 미커버: ${uncoveredKeys.length}`);

  if (uncoveredKeys.length > 0) {
    console.log(`  미커버 키: ${uncoveredKeys.join(', ')}`);
    console.log(`\n  FAIL — 매핑 테이블에 누락된 키가 있습니다.`);
    process.exit(1);
  } else {
    console.log(`\n  PASS — 모든 doc-config 키가 IR로 매핑 가능합니다.`);
  }
}

main();

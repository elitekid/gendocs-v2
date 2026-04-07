#!/usr/bin/env node
/**
 * md-parser 비교 테스트
 *
 * examples 2개(DOCX)를 대상으로 소스 MD의 구조를 분석하여
 * md-parser parse()가 올바르게 파싱하는지 검증한다.
 *
 * 비교 기준:
 *  1. MD 테이블 그룹 수 = IR table 노드 수
 *  2. MD 코드블록 수 = IR codeBlock 노드 수
 *  3. MD 헤딩 수 = IR headings 배열 길이
 *  4. IR content가 비어있지 않음
 *
 * 기존 convertMarkdownToElements()는 DOCX 객체를 반환하므로
 * 의미적 역분류가 부정확하다. 대신 소스 MD의 구조적 카운트와 비교한다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/parsers/md-parser');
const core = require('../lib/converter-core');

const EXAMPLES = [
  'examples/sample-api',
  'examples/sample-batch',
];

const projectRoot = path.join(__dirname, '..');
let allPassed = true;

/**
 * 소스 MD에서 구조적 카운트 추출
 */
function analyzeMarkdown(md) {
  const lines = md.split('\n');

  // 테이블 그룹 수
  let tableGroups = 0;
  let inTable = false;
  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      if (!inTable) { tableGroups++; inTable = true; }
    } else {
      inTable = false;
    }
  }

  // 코드블록 수
  let codeBlocks = 0;
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) { codeBlocks++; inCode = false; }
      else { inCode = true; }
    }
  }

  // 헤딩 수 (H1~H5)
  let headings = 0;
  for (const line of lines) {
    if (line.match(/^#{1,5}\s/)) headings++;
  }

  // 블록인용 그룹 수
  let blockquotes = 0;
  let inQuote = false;
  for (const line of lines) {
    if (line.startsWith('> ')) {
      if (!inQuote) { blockquotes++; inQuote = true; }
    } else {
      inQuote = false;
    }
  }

  return { tableGroups, codeBlocks, headings, blockquotes };
}

for (const exDir of EXAMPLES) {
  const configPath = path.join(projectRoot, exDir, 'doc-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const sourcePath = path.join(projectRoot, config.source);
  const rawMd = fs.readFileSync(sourcePath, 'utf-8');

  const cleanedMd = core.cleanMarkdownHeader(rawMd, config.h1CleanPattern, config.headerCleanUntil);
  const theme = core.resolveTheme(config, projectRoot);

  // 소스 분석
  const mdStats = analyzeMarkdown(cleanedMd);

  // IR 변환
  const irResult = parse(cleanedMd, {
    images: config.images,
    tableWidths: config.tableWidths,
    docType: config._docType,
    orientation: config.orientation || theme.orientation || 'landscape',
    pageMargin: theme.pageMargin,
    baseDir: projectRoot,
  });

  // IR 카운트
  const irCounts = { table: 0, codeBlock: 0, callout: 0 };
  for (const node of irResult.content) {
    if (irCounts[node.type] !== undefined) irCounts[node.type]++;
  }

  // 비교
  const checks = [];

  // 1. 테이블 수 일치
  const tableOk = mdStats.tableGroups === irCounts.table;
  checks.push({ name: 'table', ok: tableOk, expected: mdStats.tableGroups, actual: irCounts.table });

  // 2. 코드블록 수 일치 (이미지 섹션 내 스킵된 코드블록은 차이 허용)
  const codeOk = Math.abs(mdStats.codeBlocks - irCounts.codeBlock) <= (config.images?.sectionMap ? Object.keys(config.images.sectionMap).length : 0);
  checks.push({ name: 'codeBlock', ok: codeOk, expected: mdStats.codeBlocks, actual: irCounts.codeBlock });

  // 3. 헤딩 수 일치
  const headingOk = mdStats.headings === irResult.headings.length;
  checks.push({ name: 'heading', ok: headingOk, expected: mdStats.headings, actual: irResult.headings.length });

  // 4. content 비어있지 않음
  const nonEmpty = irResult.content.length > 0;
  checks.push({ name: 'nonEmpty', ok: nonEmpty, expected: '>0', actual: irResult.content.length });

  // 5. 블록인용 수 일치
  const quoteOk = mdStats.blockquotes === irCounts.callout;
  checks.push({ name: 'callout', ok: quoteOk, expected: mdStats.blockquotes, actual: irCounts.callout });

  const passed = checks.every(c => c.ok);
  console.log(`\n  ${passed ? '✓' : '✗'} ${exDir}`);
  for (const c of checks) {
    console.log(`    ${c.ok ? '✓' : '✗'} ${c.name}: expected ${c.expected}, got ${c.actual}`);
  }

  if (!passed) allPassed = false;
}

console.log(`\n  ${allPassed ? 'PASS' : 'FAIL'} — 비교 테스트 ${allPassed ? '통과' : '실패'}`);
if (!allPassed) process.exit(1);

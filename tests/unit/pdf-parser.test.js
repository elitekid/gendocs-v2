const assert = require('assert');
const fs = require('fs');
const path = require('path');

// pymupdf 확인 + 테스트 PDF 존재 확인
const testPdf = path.join(__dirname, '_test_sample.pdf');
let available = false;
try {
  require('child_process').execSync('python -c "import fitz"', { stdio: 'pipe' });
  available = fs.existsSync(testPdf);
} catch { /* noop */ }

if (!available) {
  console.log('  ⊘ pdf-parser.test.js (pymupdf 미설치 또는 테스트 PDF 없음 — 스킵)');
} else {
  const { parse } = require('../../lib/parsers/pdf-parser');

  // 1. 반환 구조
  {
    const r = parse(testPdf);
    assert.ok(Array.isArray(r.content), 'content는 배열');
    assert.ok(Array.isArray(r.headings), 'headings는 배열');
    assert.ok(Array.isArray(r.warnings), 'warnings는 배열');
  }

  // 2. heading 감지
  {
    const r = parse(testPdf);
    assert.ok(r.headings.length >= 1, `heading 1개 이상: ${r.headings.length}`);
  }

  // 3. paragraph 존재
  {
    const r = parse(testPdf);
    const paras = r.content.filter(n => n.type === 'paragraph');
    assert.ok(paras.length >= 1, `paragraph 1개 이상: ${paras.length}`);
  }

  console.log('  ✓ pdf-parser.test.js (3건 통과)');
}

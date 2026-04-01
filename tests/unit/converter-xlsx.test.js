const assert = require('assert');

// stripMarkdown은 내부 함수라 직접 테스트용으로 복제
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

// ============================================================
// stripMarkdown
// ============================================================

assert.strictEqual(stripMarkdown('**bold**'), 'bold');
assert.strictEqual(stripMarkdown('*italic*'), 'italic');
assert.strictEqual(stripMarkdown('`code`'), 'code');
assert.strictEqual(stripMarkdown('[링크](http://example.com)'), '링크');
assert.strictEqual(stripMarkdown('~~취소~~'), '취소');
assert.strictEqual(stripMarkdown('**bold** and `code`'), 'bold and code');
assert.strictEqual(stripMarkdown(''), '');
assert.strictEqual(stripMarkdown(null), '');

console.log('converter-xlsx tests: ALL PASSED');

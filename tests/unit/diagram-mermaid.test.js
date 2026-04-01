const assert = require('assert');
const {
  _classifyState, _extractSequenceParticipants, buildMermaidConfig
} = require('../../lib/diagram/mermaid');

// ============================================================
// _classifyState
// ============================================================

assert.strictEqual(_classifyState('성공'), 'success');
assert.strictEqual(_classifyState('SUCCESS'), 'success');
assert.strictEqual(_classifyState('완료'), 'success');
assert.strictEqual(_classifyState('실패'), 'failure');
assert.strictEqual(_classifyState('FAILED'), 'failure');
assert.strictEqual(_classifyState('오류'), 'failure');
assert.strictEqual(_classifyState('만료'), 'warning');
assert.strictEqual(_classifyState('EXPIRED'), 'warning');
assert.strictEqual(_classifyState('대기'), 'neutral');
assert.strictEqual(_classifyState('처리중'), 'neutral');
assert.strictEqual(_classifyState('일반상태'), 'neutral');

// ============================================================
// _extractSequenceParticipants
// ============================================================

const seq1 = `
sequenceDiagram
    participant A as 클라이언트
    participant B as 서버
    participant C as DB
    A->>B: 요청
    B->>C: 쿼리
`;
const participants1 = _extractSequenceParticipants(seq1);
assert.deepStrictEqual(participants1, ['A', 'B', 'C']);

// participant 선언 없어도 A->>B 패턴에서 추출
const seq2 = `
sequenceDiagram
    A->>B: 요청
`;
const participants2 = _extractSequenceParticipants(seq2);
assert.deepStrictEqual(participants2, ['A', 'B']);

// ============================================================
// buildMermaidConfig
// ============================================================

// null 입력 → null
assert.strictEqual(buildMermaidConfig(null), null);

// 유효한 테마 → themeVariables 포함
const config = buildMermaidConfig({
  colors: { primary: '1B3664', secondary: '4472C4', accent: 'ED7D31', text: '000000', white: 'FFFFFF' }
});
assert.ok(config !== null);
assert.ok(config.themeVariables);
assert.ok(config.themeVariables.primaryColor);

console.log('diagram-mermaid tests: ALL PASSED');

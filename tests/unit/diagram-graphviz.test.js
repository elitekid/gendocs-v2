const assert = require('assert');
const { _mapToThemeColor, _buildColorFamilyMap } = require('../../lib/diagram/graphviz');

// ============================================================
// _buildColorFamilyMap — themeConfig에서 familyMap 생성
// ============================================================

const themeConfig = {
  colors: { primary: '44546A', secondary: '4472C4', accent: 'ED7D31', altRow: 'E7E6E6' },
  slots: { accent1: '4472C4', accent2: 'ED7D31', accent3: '70AD47' },
};
const familyMap = _buildColorFamilyMap(themeConfig);
assert.ok(familyMap.info);
assert.ok(familyMap.error);
assert.ok(familyMap.warning);
assert.ok(familyMap.success);
assert.ok(familyMap.neutral);

// ============================================================
// _mapToThemeColor
// ============================================================

// 연한 파랑 (hue ~210, l > 0.65) → info
const blueResult = _mapToThemeColor('E8EEF4', familyMap);
assert.strictEqual(blueResult, familyMap.info);

// 연한 초록 (hue ~120, l > 0.65) → success
const greenResult = _mapToThemeColor('D6FFD6', familyMap);
assert.strictEqual(greenResult, familyMap.success);

// 진한 색 (l < 0.65) → '#' + hex (치환 안 함)
const darkResult = _mapToThemeColor('1B3664', familyMap);
assert.strictEqual(darkResult, '#1B3664');

console.log('diagram-graphviz tests: ALL PASSED');

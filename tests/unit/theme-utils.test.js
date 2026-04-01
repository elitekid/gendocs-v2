const assert = require('assert');
const { lightenHex, hexToHsl, hslToHex, deriveColors } = require('../../lib/theme-utils');

// ============================================================
// hexToHsl / hslToHex 왕복
// ============================================================

function roundtrip(hex) {
  const [h, s, l] = hexToHsl(hex);
  const result = hslToHex(h, s, l);
  // # 제거 후 비교 (1/256 오차 허용)
  const orig = hex.replace('#', '').toUpperCase();
  const conv = result.replace('#', '').toUpperCase();
  for (let i = 0; i < 6; i += 2) {
    const o = parseInt(orig.substring(i, i + 2), 16);
    const c = parseInt(conv.substring(i, i + 2), 16);
    assert.ok(Math.abs(o - c) <= 1, `roundtrip ${hex}: channel ${i/2} — ${o} vs ${c}`);
  }
}

roundtrip('1B3664');
roundtrip('FF0000');
roundtrip('00FF00');
roundtrip('0000FF');
roundtrip('FFFFFF');
roundtrip('000000');
roundtrip('44546A');
roundtrip('ED7D31');

// 무채색
const [h0, s0, l0] = hexToHsl('808080');
assert.strictEqual(s0, 0);
assert.ok(Math.abs(l0 - 0.502) < 0.01);

// ============================================================
// lightenHex
// ============================================================

// factor 0 → 원래 색상
const light0 = lightenHex('000000', 0);
assert.strictEqual(light0, '#000000');

// factor 1 → 흰색
const light1 = lightenHex('000000', 1);
assert.strictEqual(light1, '#ffffff');

// 흰색에 lighten → 여전히 흰색
const lightW = lightenHex('FFFFFF', 0.5);
assert.strictEqual(lightW, '#ffffff');

// 중간값
const lightM = lightenHex('000000', 0.5);
const r = parseInt(lightM.substring(1, 3), 16);
assert.ok(r >= 127 && r <= 128);

// ============================================================
// deriveColors
// ============================================================

const slots = {
  dk1: '000000', lt1: 'FFFFFF',
  dk2: '44546A', lt2: 'E7E6E6',
  accent1: '4472C4', accent2: 'ED7D31',
  accent3: 'A5A5A5', accent4: 'FFC000',
  accent5: '5B9BD5', accent6: '70AD47',
  hlink: '0563C1', folHlink: '954F72',
};

const colors = deriveColors(slots);

// 직접 매핑 확인
assert.strictEqual(colors.primary, '44546A');
assert.strictEqual(colors.secondary, '4472C4');
assert.strictEqual(colors.accent, 'ED7D31');
assert.strictEqual(colors.text, '000000');
assert.strictEqual(colors.white, 'FFFFFF');
assert.strictEqual(colors.altRow, 'E7E6E6');

// 파생 값 존재 확인
assert.ok(colors.textLight);
assert.ok(colors.border);
assert.ok(colors.infoBox);
assert.ok(colors.warningBox);

// 고정값
assert.strictEqual(colors.codeDarkBg, '1E1E1E');
assert.strictEqual(colors.codeDarkBorder, '3C3C3C');

// overrides 적용
const colorsOvr = deriveColors(slots, { codeDarkBg: '2D2D2D' });
assert.strictEqual(colorsOvr.codeDarkBg, '2D2D2D');
assert.strictEqual(colorsOvr.primary, '44546A'); // 나머지는 그대로

console.log('theme-utils tests: ALL PASSED');

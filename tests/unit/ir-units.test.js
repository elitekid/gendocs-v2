const assert = require('assert');
const units = require('../../lib/ir/units');

// ============================================================
// pt ↔ DXA
// ============================================================

assert.strictEqual(units.ptToDxa(72), 1440, 'ptToDxa: 72pt = 1440 DXA (1 inch)');
assert.strictEqual(units.ptToDxa(54), 1080, 'ptToDxa: 54pt = 1080 DXA (기존 상하 여백)');
assert.strictEqual(units.dxaToPt(1440), 72, 'dxaToPt: 1440 DXA = 72pt');
assert.strictEqual(units.dxaToPt(12960), 648, 'dxaToPt: 12960 DXA = 648pt');

// ============================================================
// pt ↔ EMU
// ============================================================

assert.strictEqual(units.ptToEmu(72), 914400, 'ptToEmu: 72pt = 914400 EMU (1 inch)');
assert.strictEqual(units.emuToPt(914400), 72, 'emuToPt: 914400 EMU = 72pt');

// ============================================================
// pt ↔ half-point (DOCX 폰트)
// ============================================================

assert.strictEqual(units.ptToHalfPt(10), 20, 'ptToHalfPt: 10pt = 20 half-pt');
assert.strictEqual(units.ptToHalfPt(12), 24, 'ptToHalfPt: 12pt = 24 half-pt');
assert.strictEqual(units.halfPtToPt(20), 10, 'halfPtToPt: 20 = 10pt');

// ============================================================
// pt ↔ hundredths-pt (PPTX 폰트)
// ============================================================

assert.strictEqual(units.ptToHundredthsPt(10), 1000, 'ptToHundredthsPt: 10pt = 1000');
assert.strictEqual(units.hundredthsPtToPt(1000), 10, 'hundredthsPtToPt: 1000 = 10pt');

// ============================================================
// 왕복 변환 (round-trip) — 오차 범위 검증
// ============================================================

function assertClose(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: ${actual} vs ${expected} (tol ${tolerance})`);
}

// DXA 왕복 (정수 반올림으로 ±0.05pt 오차 가능)
[72, 54, 10, 12.5].forEach(pt => {
  assertClose(units.dxaToPt(units.ptToDxa(pt)), pt, 0.05, `DXA roundtrip ${pt}pt`);
});

// EMU 왕복 (높은 정밀도)
[72, 10, 12.5].forEach(pt => {
  assertClose(units.emuToPt(units.ptToEmu(pt)), pt, 0.001, `EMU roundtrip ${pt}pt`);
});

// half-pt 왕복
[10, 12, 14.5].forEach(pt => {
  assertClose(units.halfPtToPt(units.ptToHalfPt(pt)), pt, 0.5, `half-pt roundtrip ${pt}pt`);
});

// px 왕복
[72, 10].forEach(pt => {
  assertClose(units.pxToPt(units.ptToPx(pt)), pt, 0.001, `px roundtrip ${pt}pt`);
});

// ============================================================
// 반올림 — DXA/EMU/half-pt는 정수 반환
// ============================================================

assert.strictEqual(Number.isInteger(units.ptToDxa(10.3)), true, 'ptToDxa returns integer');
assert.strictEqual(units.ptToDxa(10.3), 206, 'ptToDxa(10.3) = 206');
assert.strictEqual(Number.isInteger(units.ptToEmu(10.3)), true, 'ptToEmu returns integer');
assert.strictEqual(units.ptToEmu(10.3), 130810, 'ptToEmu(10.3) = 130810');
assert.strictEqual(Number.isInteger(units.ptToHalfPt(10.3)), true, 'ptToHalfPt returns integer');
assert.strictEqual(units.ptToHalfPt(10.3), 21, 'ptToHalfPt(10.3) = 21');

// dxaToPt는 소수 가능
assert.strictEqual(units.dxaToPt(207), 10.35, 'dxaToPt(207) = 10.35');

// ============================================================
// 색상 변환
// ============================================================

assert.strictEqual(units.hexToArgb('44546A'), 'FF44546A', 'hexToArgb default alpha');
assert.strictEqual(units.hexToArgb('44546A', '80'), '8044546A', 'hexToArgb custom alpha');
assert.strictEqual(units.hexToArgb('#44546A'), 'FF44546A', 'hexToArgb strips #');
assert.strictEqual(units.argbToHex('FF44546A'), '44546A', 'argbToHex');

// hex → ARGB → hex 왕복
assert.strictEqual(units.argbToHex(units.hexToArgb('1B3664')), '1B3664', 'ARGB roundtrip');

// hexToRgbFloat
const rgb = units.hexToRgbFloat('FF0000');
assert.strictEqual(rgb[0], 1, 'red channel = 1');
assert.strictEqual(rgb[1], 0, 'green channel = 0');
assert.strictEqual(rgb[2], 0, 'blue channel = 0');

const rgb2 = units.hexToRgbFloat('44546A');
assertClose(rgb2[0], 0.267, 0.001, 'hex 44546A red');
assertClose(rgb2[1], 0.329, 0.001, 'hex 44546A green');
assertClose(rgb2[2], 0.416, 0.001, 'hex 44546A blue');

// rgbFloatToHex
assert.strictEqual(units.rgbFloatToHex([1, 0, 0]), 'FF0000', 'rgbFloatToHex red');

// hex → rgbFloat → hex 왕복 (반올림 ±1)
['44546A', '1B3664', 'ED7D31', 'FFFFFF', '000000'].forEach(hex => {
  const back = units.rgbFloatToHex(units.hexToRgbFloat(hex));
  for (let i = 0; i < 6; i += 2) {
    const o = parseInt(hex.substring(i, i + 2), 16);
    const c = parseInt(back.substring(i, i + 2), 16);
    assert.ok(Math.abs(o - c) <= 1, `rgbFloat roundtrip ${hex}: ch${i/2} ${o} vs ${c}`);
  }
});

// ============================================================
// 줄 간격
// ============================================================

assert.strictEqual(units.lineSpacingMultipleToDocx(1.0), 240, 'line spacing 1.0 = 240');
assert.strictEqual(units.lineSpacingMultipleToDocx(1.15), 276, 'line spacing 1.15 = 276');
assert.strictEqual(units.lineSpacingMultipleToDocx(1.5), 360, 'line spacing 1.5 = 360');
assert.strictEqual(units.lineSpacingMultipleToDocx(2.0), 480, 'line spacing 2.0 = 480');
assert.strictEqual(units.docxToLineSpacingMultiple(240), 1.0, 'docx 240 = 1.0');

// ============================================================
// mm / inch 변환
// ============================================================

assertClose(units.ptToMm(72), 25.4, 0.1, 'ptToMm: 72pt ≈ 25.4mm');
assertClose(units.mmToPt(25.4), 72, 0.1, 'mmToPt: 25.4mm ≈ 72pt');
assert.strictEqual(units.ptToInches(72), 1, 'ptToInches: 72pt = 1 inch');
assert.strictEqual(units.inchesToPt(1), 72, 'inchesToPt: 1 inch = 72pt');

// ============================================================
// 표준 상수
// ============================================================

assert.deepStrictEqual(units.A4_PORTRAIT, { width: 595, height: 842 }, 'A4 portrait');
assert.deepStrictEqual(units.A4_LANDSCAPE, { width: 842, height: 595 }, 'A4 landscape');
assert.deepStrictEqual(units.US_LETTER_PORTRAIT, { width: 612, height: 792 }, 'US Letter portrait');
assert.deepStrictEqual(units.US_LETTER_LANDSCAPE, { width: 792, height: 612 }, 'US Letter landscape');

// LEGACY 상수
assert.strictEqual(units.LEGACY_PAGE_WIDTH_PORTRAIT_DXA, 12240, 'legacy portrait DXA');
assert.strictEqual(units.LEGACY_PAGE_WIDTH_LANDSCAPE_DXA, 15840, 'legacy landscape DXA');
assert.strictEqual(units.LEGACY_CONTENT_WIDTH_LANDSCAPE_DXA, 12960, 'legacy content landscape DXA');
assert.strictEqual(units.LEGACY_CONTENT_WIDTH_PORTRAIT_DXA, 9360, 'legacy content portrait DXA');

// LEGACY ↔ pt 정합성
assert.strictEqual(units.dxaToPt(units.LEGACY_DEFAULT_MARGIN_LR_DXA), units.DEFAULT_MARGIN_LR_PT,
  'LEGACY_MARGIN_LR DXA → pt = DEFAULT_MARGIN_LR_PT');

// ISO A4 DXA 근사 검증
assertClose(units.ptToDxa(units.A4_PORTRAIT.width), 11900, 10, 'A4 portrait width ≈ 11906 DXA');

console.log('ir-units tests: ALL PASSED');

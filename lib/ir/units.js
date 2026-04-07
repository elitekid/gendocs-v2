/**
 * lib/ir/units.js — IR 단위 변환 유틸리티
 *
 * IR 표준 단위: pt (길이), hex 6자리 (색상), pt (폰트).
 * 렌더러가 출력 시 이 모듈로 변환한다.
 *
 * 참조: docs/architecture/02-unit-systems.md
 */
'use strict';

// ═══════════════════════════════════════
// pt ↔ DXA (1 DXA = 1/20 pt)
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} DXA (정수) */
function ptToDxa(pt) { return Math.round(pt * 20); }

/** @param {number} dxa @returns {number} pt */
function dxaToPt(dxa) { return dxa / 20; }

// ═══════════════════════════════════════
// pt ↔ EMU (1 EMU = 1/12700 pt)
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} EMU (정수) */
function ptToEmu(pt) { return Math.round(pt * 12700); }

/** @param {number} emu @returns {number} pt */
function emuToPt(emu) { return emu / 12700; }

// ═══════════════════════════════════════
// pt ↔ half-point (DOCX 폰트 크기)
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} half-point (정수) */
function ptToHalfPt(pt) { return Math.round(pt * 2); }

/** @param {number} hp @returns {number} pt */
function halfPtToPt(hp) { return hp / 2; }

// ═══════════════════════════════════════
// pt ↔ hundredths-point (PPTX 폰트 크기)
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} hundredths-pt (정수) */
function ptToHundredthsPt(pt) { return Math.round(pt * 100); }

/** @param {number} hp @returns {number} pt */
function hundredthsPtToPt(hp) { return hp / 100; }

// ═══════════════════════════════════════
// pt ↔ px (96dpi 기준)
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} px */
function ptToPx(pt) { return pt * (96 / 72); }

/** @param {number} px @returns {number} pt */
function pxToPt(px) { return px * (72 / 96); }

// ═══════════════════════════════════════
// pt ↔ mm
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} mm */
function ptToMm(pt) { return pt * 0.3528; }

/** @param {number} mm @returns {number} pt */
function mmToPt(mm) { return mm / 0.3528; }

// ═══════════════════════════════════════
// pt ↔ inches
// ═══════════════════════════════════════

/** @param {number} pt @returns {number} inches */
function ptToInches(pt) { return pt / 72; }

/** @param {number} inches @returns {number} pt */
function inchesToPt(inches) { return inches * 72; }

// ═══════════════════════════════════════
// 색상 변환
// ═══════════════════════════════════════

/**
 * hex 6자리 → ARGB 8자리 (XLSX용)
 * @param {string} hex - "44546A" (# 없이)
 * @param {string} [alpha="FF"]
 * @returns {string} "FF44546A"
 */
function hexToArgb(hex, alpha = 'FF') {
  return alpha + hex.replace(/^#/, '').toUpperCase();
}

/**
 * ARGB 8자리 → hex 6자리
 * @param {string} argb - "FF44546A"
 * @returns {string} "44546A"
 */
function argbToHex(argb) {
  return argb.substring(2).toUpperCase();
}

/**
 * hex 6자리 → RGB float 배열 (PDF용)
 * @param {string} hex - "44546A"
 * @returns {number[]} [r, g, b] 각 0~1
 */
function hexToRgbFloat(hex) {
  const h = hex.replace(/^#/, '');
  return [
    parseInt(h.substring(0, 2), 16) / 255,
    parseInt(h.substring(2, 4), 16) / 255,
    parseInt(h.substring(4, 6), 16) / 255,
  ];
}

/**
 * RGB float 배열 → hex 6자리
 * @param {number[]} rgb - [r, g, b] 각 0~1
 * @returns {string} "44546A"
 */
function rgbFloatToHex(rgb) {
  return rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ═══════════════════════════════════════
// DOCX 줄 간격
// ═══════════════════════════════════════

/**
 * 배수 줄간격 → DOCX w:line 값 (240 = 1배)
 * @param {number} multiple - 1.0, 1.15, 1.5, 2.0 등
 * @returns {number}
 */
function lineSpacingMultipleToDocx(multiple) {
  return Math.round(multiple * 240);
}

/**
 * DOCX w:line 값 → 배수
 * @param {number} docxValue
 * @returns {number}
 */
function docxToLineSpacingMultiple(docxValue) {
  return docxValue / 240;
}

// ═══════════════════════════════════════
// 표준 상수
// ═══════════════════════════════════════

/** ISO A4 세로 (pt) */
const A4_PORTRAIT = Object.freeze({ width: 595, height: 842 });

/** ISO A4 가로 (pt) */
const A4_LANDSCAPE = Object.freeze({ width: 842, height: 595 });

/** US Letter 세로 (pt) */
const US_LETTER_PORTRAIT = Object.freeze({ width: 612, height: 792 });

/** US Letter 가로 (pt) */
const US_LETTER_LANDSCAPE = Object.freeze({ width: 792, height: 612 });

// 기존 gendocs 코드 호환 상수 (DXA)
// converter-core.js, professional.js에서 사용 중인 값

/** 기존 코드 portrait 페이지 너비 DXA (US Letter) */
const LEGACY_PAGE_WIDTH_PORTRAIT_DXA = 12240;

/** 기존 코드 landscape 페이지 너비 DXA */
const LEGACY_PAGE_WIDTH_LANDSCAPE_DXA = 15840;

/** 기존 코드 기본 좌우 여백 DXA */
const LEGACY_DEFAULT_MARGIN_LR_DXA = 1440;

/** 기존 코드 portrait content 너비 DXA (12240 - 1440*2 = 9360) */
const LEGACY_CONTENT_WIDTH_PORTRAIT_DXA = 9360;

/** 기존 코드 landscape content 너비 DXA (15840 - 1440*2 = 12960) */
const LEGACY_CONTENT_WIDTH_LANDSCAPE_DXA = 12960;

/** 기존 코드 좌우 여백의 pt 환산 (1440 DXA = 72pt = 1inch) */
const DEFAULT_MARGIN_LR_PT = 72;

/** 기존 코드 상하 여백의 pt 환산 (1080 DXA = 54pt) */
const DEFAULT_MARGIN_TB_PT = 54;

// ═══════════════════════════════════════
// exports
// ═══════════════════════════════════════

module.exports = {
  // pt 변환
  ptToDxa, dxaToPt,
  ptToEmu, emuToPt,
  ptToHalfPt, halfPtToPt,
  ptToHundredthsPt, hundredthsPtToPt,
  ptToPx, pxToPt,
  ptToMm, mmToPt,
  ptToInches, inchesToPt,

  // 색상 변환
  hexToArgb, argbToHex,
  hexToRgbFloat, rgbFloatToHex,

  // 줄 간격
  lineSpacingMultipleToDocx, docxToLineSpacingMultiple,

  // 상수
  A4_PORTRAIT, A4_LANDSCAPE,
  US_LETTER_PORTRAIT, US_LETTER_LANDSCAPE,
  LEGACY_PAGE_WIDTH_PORTRAIT_DXA, LEGACY_PAGE_WIDTH_LANDSCAPE_DXA,
  LEGACY_DEFAULT_MARGIN_LR_DXA,
  LEGACY_CONTENT_WIDTH_PORTRAIT_DXA, LEGACY_CONTENT_WIDTH_LANDSCAPE_DXA,
  DEFAULT_MARGIN_LR_PT, DEFAULT_MARGIN_TB_PT,
};

/**
 * theme-utils.js — 테마 색상 유틸리티
 *
 * Word 12슬롯(dk1/lt1/dk2/lt2/accent1-6/hlink/folHlink)에서
 * 30키 colors 객체를 파생하는 순수 함수 모듈.
 *
 * 사용법:
 *   const { deriveColors, isV2Theme, tint, shade } = require('./theme-utils');
 *   const colors = deriveColors(theme.slots, theme.overrides);
 */

// ============================================================
// 색상 변환 유틸리티 (diagram-renderer.js에서 공유)
// ============================================================

/**
 * 진한 hex 색상을 밝게 만든다 (white 방향 혼합)
 * @param {string} hex - "1B3664" (# 없이)
 * @param {number} factor - 0~1 (1에 가까울수록 흰색)
 * @returns {string} "#D6E4F0" (# 포함)
 */
function lightenHex(hex, factor) {
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const lr = Math.round(r + (255 - r) * factor);
  const lg = Math.round(g + (255 - g) * factor);
  const lb = Math.round(b + (255 - b) * factor);
  return '#' + [lr, lg, lb].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** hex("1B3664") → [h, s, l] (h: 0~360, s/l: 0~1) */
function hexToHsl(hex) {
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

/** [h, s, l] → "#1B3664" (# 포함) */
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return '#' + [r + m, g + m, b + m]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

// ============================================================
// tint / shade — Word 표준 색상 파생
// ============================================================

/**
 * hex 색상을 white 방향으로 혼합 (Word tint)
 * @param {string} hex - "44546A" (# 없이, 6자리)
 * @param {number} factor - 0~1 (0=원색, 1=흰색)
 * @returns {string} "A1B2C3" (# 없이, 6자리)
 */
function tint(hex, factor) {
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const tr = Math.round(r + (255 - r) * factor);
  const tg = Math.round(g + (255 - g) * factor);
  const tb = Math.round(b + (255 - b) * factor);
  return [tr, tg, tb].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * hex 색상을 black 방향으로 혼합 (Word shade)
 * @param {string} hex - "ED7D31" (# 없이, 6자리)
 * @param {number} factor - 0~1 (0=원색, 1=검정)
 * @returns {string} "7A4019" (# 없이, 6자리)
 */
function shade(hex, factor) {
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const sr = Math.round(r * (1 - factor));
  const sg = Math.round(g * (1 - factor));
  const sb = Math.round(b * (1 - factor));
  return [sr, sg, sb].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// 12슬롯 → 30키 파생
// ============================================================

/**
 * Word 12슬롯에서 30키 colors 객체를 파생한다.
 * @param {Object} slots - { dk1, lt1, dk2, lt2, accent1, accent2, accent3, accent4, accent5, accent6, hlink, folHlink }
 * @param {Object} [overrides={}] - 파생 결과를 부분 덮어쓰기
 * @returns {Object} - 30키 colors 객체 (# 없이, 6자리 hex)
 */
function deriveColors(slots, overrides = {}) {
  const colors = {
    // 직접 매핑
    primary: slots.dk2,
    secondary: slots.accent1,
    accent: slots.accent2,
    text: slots.dk1,
    white: slots.lt1,
    altRow: slots.lt2,

    // tint/shade 파생
    textLight: tint(slots.dk1, 0.50),
    textDark: shade(slots.dk1, 0.20),
    border: tint(slots.dk2, 0.70),
    codeBorder: tint(slots.dk2, 0.60),
    codeBlock: tint(slots.dk2, 0.85),
    infoBox: tint(slots.dk2, 0.85),
    infoBoxBorder: slots.dk2,
    warningBox: tint(slots.accent2, 0.88),
    warningBoxBorder: slots.accent2,
    warningBoxText: shade(slots.accent2, 0.45),
    inlineCode: slots.dk2,
    headerFooter: tint(slots.dk1, 0.50),

    // 고정값 (모든 테마 공통)
    codeDarkBg: '1E1E1E',
    codeDarkBorder: '3C3C3C',

    // tint/shade 파생 (UI 요소)
    jsonBg: tint(slots.dk1, 0.93),
    flowBoxBorder: tint(slots.dk1, 0.50),
    flowBoxBg: tint(slots.dk1, 0.93),
    flowBlockBorder: tint(slots.dk2, 0.75),
    flowBlockBg: tint(slots.dk2, 0.95),
  };

  // overrides 적용
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) {
      colors[key] = value;
    }
  }

  return colors;
}

// ============================================================
// 테마 버전 감지 + v1 마이그레이션
// ============================================================

/**
 * 테마가 v2(slots 기반)인지 확인
 * @param {Object} theme - 테마 JSON
 * @returns {boolean}
 */
function isV2Theme(theme) {
  return theme && theme.version === 2 && theme.slots != null;
}

/**
 * v1 테마(colors 30키)를 v2 구조로 자동 변환
 * v1 colors에서 12슬롯을 역추출하여 v2 형태로 리턴.
 * 정확한 역변환은 불가능하므로 최선 추정.
 * @param {Object} v1Theme - 기존 v1 테마 JSON
 * @returns {Object} - v2 형태 테마 (slots + overrides)
 */
function migrateV1Theme(v1Theme) {
  const c = v1Theme.colors || {};

  const slots = {
    dk1: c.text || '333333',
    lt1: c.white || 'FFFFFF',
    dk2: c.primary || '44546A',
    lt2: c.altRow || 'E7E6E6',
    accent1: c.secondary || '4472C4',
    accent2: c.accent || 'ED7D31',
    accent3: 'A5A5A5',
    accent4: 'FFC000',
    accent5: '5B9BD5',
    accent6: '70AD47',
    hlink: '0563C1',
    folHlink: '954F72',
  };

  // v1에서 직접 지정된 값 중 파생으로 재현 불가능한 것을 overrides로 보존
  const derived = deriveColors(slots);
  const overrides = {};
  for (const [key, value] of Object.entries(c)) {
    if (value && derived[key] && value.toUpperCase() !== derived[key].toUpperCase()) {
      overrides[key] = value;
    }
  }

  return {
    name: v1Theme.name,
    displayName: v1Theme.displayName,
    version: 2,
    slots,
    fonts: v1Theme.fonts,
    sizes: v1Theme.sizes,
    syntax: v1Theme.syntax,
    overrides,
  };
}

module.exports = {
  // 색상 변환 (diagram-renderer.js와 공유)
  lightenHex,
  hexToHsl,
  hslToHex,

  // Word 표준 파생
  tint,
  shade,
  deriveColors,

  // 테마 버전
  isV2Theme,
  migrateV1Theme,
};

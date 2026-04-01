/**
 * graphviz.js — Graphviz 다이어그램 렌더러 + 테마 주입
 *
 * diagram-renderer.js에서 분리된 모듈.
 */

const fs = require('fs');
const path = require('path');
const { hexToHsl, lightenHex } = require('../theme-utils');
const { svgToPng } = require('./svg-utils');

// ============================================================
// Graphviz 하드코딩 색상 → 테마 대응 치환
// ============================================================

/** 하드코딩된 fillcolor를 테마 대응 색상으로 치환 */
function _replaceGraphvizColors(code, themeConfig) {
  const familyMap = _buildColorFamilyMap(themeConfig);

  return code.replace(/fillcolor\s*=\s*"(#?[0-9A-Fa-f]{6})"/g, (match, rawHex) => {
    const hex = rawHex.replace('#', '').toUpperCase();
    const replacement = _mapToThemeColor(hex, familyMap);
    return `fillcolor="${replacement}"`;
  });
}

/** 색상 가족 → 테마 대응색 매핑 테이블 생성 */
function _buildColorFamilyMap(themeConfig) {
  const c = themeConfig.colors || {};
  const slots = themeConfig.slots;

  if (slots) {
    return {
      info:    lightenHex(slots.accent1 || '156082', 0.75),
      error:   lightenHex(slots.accent2 || 'E97132', 0.72),
      warning: lightenHex(slots.accent2 || 'E97132', 0.88),   // accent2의 매우 밝은 tint (피치/크림)
      success: lightenHex(slots.accent3 || '196B24', 0.75),
      neutral: '#' + (c.altRow || 'F2F2F2'),
    };
  }

  // v1 fallback
  return {
    info:    lightenHex(c.secondary || c.primary || '4472C4', 0.75),
    error:   lightenHex(c.accent || 'E97132', 0.72),
    warning: lightenHex(c.accent || 'FFC000', 0.88),
    success: lightenHex('4EA72E', 0.75),
    neutral: '#' + (c.altRow || 'F2F2F2'),
  };
}

/**
 * Graphviz rounded box path의 corner radius를 조절
 * Graphviz SVG는 rounded box를 <path d="M...C..."> 형태로 그림 (rx/ry 없음)
 * filled path 중 좌표 20개 이상인 것을 rounded rect로 판별하여
 * bounding box 추출 → 원하는 radius의 Q(quadratic) 커브 path로 재생성
 */
function _adjustCornerRadius(svg, radius) {
  return svg.replace(/<path (fill="(?!none)[^"]*" stroke="[^"]*"[^>]*) d="(M[^"]+)"\/>/g, (match, attrs, d) => {
    const nums = d.match(/-?[\d.]+/g);
    if (!nums || nums.length < 20) return match;

    const coords = nums.map(Number);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < coords.length; i += 2) {
      if (i + 1 < coords.length) {
        minX = Math.min(minX, coords[i]);
        maxX = Math.max(maxX, coords[i]);
        minY = Math.min(minY, coords[i + 1]);
        maxY = Math.max(maxY, coords[i + 1]);
      }
    }

    const r = Math.min(radius, (maxX - minX) / 2, (maxY - minY) / 2);
    const newD = [
      `M${(maxX - r).toFixed(2)},${minY.toFixed(2)}`,
      `L${(minX + r).toFixed(2)},${minY.toFixed(2)}`,
      `Q${minX.toFixed(2)},${minY.toFixed(2)} ${minX.toFixed(2)},${(minY + r).toFixed(2)}`,
      `L${minX.toFixed(2)},${(maxY - r).toFixed(2)}`,
      `Q${minX.toFixed(2)},${maxY.toFixed(2)} ${(minX + r).toFixed(2)},${maxY.toFixed(2)}`,
      `L${(maxX - r).toFixed(2)},${maxY.toFixed(2)}`,
      `Q${maxX.toFixed(2)},${maxY.toFixed(2)} ${maxX.toFixed(2)},${(maxY - r).toFixed(2)}`,
      `L${maxX.toFixed(2)},${(minY + r).toFixed(2)}`,
      `Q${maxX.toFixed(2)},${minY.toFixed(2)} ${(maxX - r).toFixed(2)},${minY.toFixed(2)}`,
      'Z'
    ].join(' ');

    return `<path ${attrs} d="${newD}"/>`;
  });
}

/** 개별 hex → 색상 가족 감지 → 테마 대응색 반환 */
function _mapToThemeColor(hex, familyMap) {
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const [h, s, l] = hexToHsl(hex);

  // 연한 색상 (l > 0.65)만 치환 — 진한 색상은 사용자 의도가 강함
  if (l > 0.65) {
    if (s < 0.08) return familyMap.neutral;                 // 무채색 (회색)
    if (h >= 180 && h <= 250) return familyMap.info;        // 파랑 계열
    if ((h >= 0 && h <= 20) || h >= 340) return familyMap.error;  // 빨강/핑크 계열
    if (h >= 40 && h <= 70) return familyMap.warning;       // 노랑/황색 계열
    if (h >= 80 && h <= 170) return familyMap.success;      // 녹색 계열
    return familyMap.info; // 기본
  }

  // 진한 색상은 그대로 유지
  return '#' + hex;
}

// ============================================================
// Graphviz 테마 주입
// ============================================================

/**
 * DOT 소스에 테마 속성을 주입한다.
 * - 레이아웃 속성 (margin, penwidth, pad): 사용자가 미지정 시 항상 주입
 * - 색상 속성 (fillcolor, bgcolor 등): 사용자가 이미 지정한 경우 건드리지 않음
 */
function injectGraphvizTheme(code, themeConfig) {
  if (!themeConfig || !themeConfig.colors) return code;

  const c = themeConfig.colors;
  const fonts = themeConfig.fonts || {};
  const fontName = fonts.default || 'Malgun Gothic';

  const hasUserColors = /\b(?:fillcolor|bgcolor)\s*=/i.test(code);
  const hasUserMargin = /\bmargin\s*=/i.test(code);
  const hasUserPenwidth = /\bpenwidth\s*=/i.test(code);
  const hasUserPad = /\bpad\s*=/i.test(code);
  const hasUserSize = /\bsize\s*=/i.test(code);
  const hasUserRatio = /\bratio\s*=/i.test(code);
  const hasUserSplines = /\bsplines\s*=/i.test(code);
  const hasUserStyle = /\bstyle\s*=/i.test(code);
  // --- 레이아웃 속성 (항상 주입, 사용자 미지정 시) ---
  // WASM Graphviz는 한국어 글자 폭을 과소평가하므로 넉넉한 margin + 작은 fontsize 필요
  // fontsize는 항상 주입: 사용자의 node[fontsize=N]이 뒤에 오면 자동 오버라이드됨
  const layoutAttrs = [];
  if (!hasUserSize) {
    const isPortrait = themeConfig && themeConfig.orientation === 'portrait';
    layoutAttrs.push(`    size="${isPortrait ? '5,7' : '9,5'}"`);
  }
  if (!hasUserRatio) {
    layoutAttrs.push('    ratio=compress');
  }
  if (!hasUserSplines) {
    layoutAttrs.push('    splines=ortho');
  }
  if (!hasUserPad) {
    layoutAttrs.push(`    pad="0.3"`);
  }
  const nodeLayoutParts = [];
  if (!hasUserMargin) nodeLayoutParts.push('margin="0.12,0.08"');
  if (!hasUserPenwidth) nodeLayoutParts.push('penwidth="1.2"');
  if (!hasUserStyle) nodeLayoutParts.push('style="rounded,filled"');
  nodeLayoutParts.push('fontsize="10"');
  const edgeLayoutParts = [];
  if (!hasUserPenwidth) edgeLayoutParts.push('penwidth="1.2"');
  edgeLayoutParts.push('arrowsize="0.8"');
  edgeLayoutParts.push('fontsize="9"');

  if (nodeLayoutParts.length > 0) {
    layoutAttrs.push(`    node [${nodeLayoutParts.join(' ')}]`);
  }
  if (edgeLayoutParts.length > 0) {
    layoutAttrs.push(`    edge [${edgeLayoutParts.join(' ')}]`);
  }

  // --- 색상 속성 ---
  const colorAttrs = [];
  const nodeText = '#' + c.text;
  const edgeColor = '#' + c.secondary;

  if (!hasUserColors) {
    // 사용자 색상 없음 → 전체 테마 색상 주입
    const [gpH, gpS] = hexToHsl(c.primary);
    const [gsH, gsS] = hexToHsl(c.secondary);
    const gAnchor = (gsS > gpS && gpS < 0.20) ? c.secondary : c.primary;
    const nodeFill = lightenHex(gAnchor, 0.70);
    const nodeBorder = '#' + c.primary;

    colorAttrs.push(`    bgcolor="#FFFFFF"`);
    colorAttrs.push(`    fontname="${fontName}"`);
    colorAttrs.push(`    fontsize="12"`);
    colorAttrs.push(`    fontcolor="${nodeText}"`);
    colorAttrs.push(`    node [style="rounded,filled" fillcolor="${nodeFill}" color="${nodeBorder}" fontcolor="${nodeText}" fontname="${fontName}" fontsize="10"]`);
    colorAttrs.push(`    edge [color="${edgeColor}" fontcolor="${nodeText}" fontname="${fontName}" fontsize="9"]`);
  } else {
    // 사용자 fillcolor 있음 → 폰트/엣지 스타일만 주입 + 하드코딩 색상을 테마 대응색으로 치환
    colorAttrs.push(`    bgcolor="#FFFFFF"`);
    colorAttrs.push(`    fontname="${fontName}"`);
    colorAttrs.push(`    fontcolor="${nodeText}"`);
    colorAttrs.push(`    node [fontcolor="${nodeText}" fontname="${fontName}"]`);
    colorAttrs.push(`    edge [color="${edgeColor}" fontcolor="${nodeText}" fontname="${fontName}"]`);

    code = _replaceGraphvizColors(code, themeConfig);
  }

  const themeBlock = '\n' + [...layoutAttrs, ...colorAttrs].join('\n') + '\n';

  // digraph name { 또는 graph name { 뒤에 삽입
  const insertRe = /^(\s*(?:di)?graph\s+[^{]*\{)/m;
  const match = code.match(insertRe);
  if (match) {
    const insertPos = match.index + match[0].length;
    return code.substring(0, insertPos) + themeBlock + code.substring(insertPos);
  }

  return code;
}

// ============================================================
// Graphviz 렌더러
// ============================================================

const graphvizRenderer = {
  extensions: ['dot', 'graphviz'],
  _browser: null,
  isAvailable() {
    try { require.resolve('@hpcc-js/wasm-graphviz'); return true; }
    catch { return false; }
  },
  async render(code, outputPath, options) {
    const { Graphviz } = require('@hpcc-js/wasm-graphviz');
    const graphviz = await Graphviz.load();

    // 테마 색상/레이아웃 주입
    code = injectGraphvizTheme(code, options.themeConfig);

    // WASM Graphviz 한국어 폰트 폭 보정:
    // WASM에 CJK 폰트 메트릭이 없어 노드 크기가 과소 계산됨.
    // 전략: (1) fontsize를 1.8배 팽창시켜 레이아웃 계산 → 노드가 한글 폭에 맞게 커짐
    //        (2) SVG에서 원래 fontsize 복원 → 텍스트 크기는 정상, 노드만 넉넉
    //        (3) puppeteer HTML에서 CSS font-family 강제 → 깔끔한 폰트 렌더링
    const CJK_FACTOR = 1.2;
    const hasCJK = /[\u3000-\u9fff\uac00-\ud7af]/.test(code);

    const originalFonts = new Set();
    code.replace(/fontname\s*=\s*"([^"]+)"/g, (_, name) => { originalFonts.add(name); });
    const primaryFont = [...originalFonts][0] || 'Malgun Gothic';

    // 레이아웃용 DOT: Courier + fontsize 팽창 (CJK 있을 때)
    // CJK 폰트 폭 보정: Courier 치환 없이 fontsize만 팽창 → SVG에서 복원
    // Courier 치환을 하면 모노스페이스 폭 과대로 박스가 넓어지므로 원본 폰트 유지
    let layoutCode = code;
    if (hasCJK && CJK_FACTOR > 1.0) {
      layoutCode = layoutCode.replace(/fontsize\s*=\s*"?(\d+(?:\.\d+)?)"?/g, (m, sz) => {
        return `fontsize="${(parseFloat(sz) * CJK_FACTOR).toFixed(0)}"`;
      });
    }

    let svg = graphviz.dot(layoutCode, 'svg');

    // SVG 복원: 팽창 fontsize → 원래 크기, 폰트는 puppeteer CSS로 강제
    svg = svg.replace(/font-family="[^"]*"/g, `font-family="${primaryFont}"`);
    if (hasCJK && CJK_FACTOR > 1.0) {
      svg = svg.replace(/font-size="(\d+(?:\.\d+)?)"/g, (m, sz) => {
        return `font-size="${(parseFloat(sz) / CJK_FACTOR).toFixed(2)}"`;
      });
    }

    // SVG 후처리: rounded box corner radius 조절 (Graphviz 기본 r≈6 → r=3)
    svg = _adjustCornerRadius(svg, 3);

    // SVG → PNG: puppeteer로 변환 (CSS로 폰트 강제 적용)
    const scale = options.scale || 2;
    const png = await svgToPng(svg, scale, primaryFont);
    fs.writeFileSync(outputPath, png);
  }
};

module.exports = {
  _replaceGraphvizColors,
  _buildColorFamilyMap,
  _adjustCornerRadius,
  _mapToThemeColor,
  injectGraphvizTheme,
  graphvizRenderer,
};

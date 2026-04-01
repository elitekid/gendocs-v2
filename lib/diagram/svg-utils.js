/**
 * svg-utils.js — SVG/PNG 변환 유틸리티 + 파이 팔레트
 *
 * diagram-renderer.js에서 분리된 모듈.
 */

const { hexToHsl, hslToHex } = require('../theme-utils');

// ============================================================
// 파이 차트 팔레트
// ============================================================

/**
 * 테마 primary 색상으로부터 파이 차트용 다색 팔레트 생성
 * hue를 회전시켜 다양하되 톤(채도/밝기)을 통일
 * @param {string} primaryHex - "1B3664" (# 없이)
 * @param {number} count - 생성할 색상 수
 * @returns {string[]} ["#1B3664", "#1B5664", ...] (# 포함)
 */
function generatePiePalette(primaryHex, count) {
  const [h, s, l] = hexToHsl(primaryHex);
  // 채도를 보고서에 적합한 범위로 조정 (너무 진하지도 연하지도 않게)
  const palS = Math.max(0.30, Math.min(s, 0.65));
  // hue 간격: 인접 hue들을 고르게 분포 (±범위를 count에 맞게)
  const hueSpread = Math.min(200, count * 28); // 최대 200도 범위
  const palette = [];
  for (let i = 0; i < count; i++) {
    const offset = (i / (count - 1) - 0.5) * hueSpread; // -spread/2 ~ +spread/2
    const pieH = h + offset;
    // 밝기를 단계적으로 변화: 진 → 중 → 연 반복
    const pieL = 0.35 + (i % 3) * 0.12;
    palette.push(hslToHex(pieH, palS, pieL));
  }
  return palette;
}

// ============================================================
// SVG → PNG 변환 (puppeteer)
// ============================================================

let _puppeteerBrowser = null;

/**
 * SVG 문자열을 PNG Buffer로 변환한다.
 * puppeteer 브라우저 인스턴스를 재사용하여 성능 최적화.
 */
async function svgToPng(svgString, scale, fontFamily) {
  const puppeteer = require('puppeteer');

  // 브라우저 재사용
  if (!_puppeteerBrowser || !_puppeteerBrowser.isConnected()) {
    _puppeteerBrowser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  const page = await _puppeteerBrowser.newPage();

  try {
    // <svg> 태그에서만 width/height 추출 (자식 요소의 속성과 혼동 방지)
    const svgTagMatch = svgString.match(/<svg\b[^>]*>/);
    const svgTag = svgTagMatch ? svgTagMatch[0] : '';
    const widthMatch = svgTag.match(/width="(\d+(?:\.\d+)?)(?:pt|px)?"/);
    const heightMatch = svgTag.match(/height="(\d+(?:\.\d+)?)(?:pt|px)?"/);
    const isPt = svgTag.includes('pt"');
    const ptToPx = isPt ? 1.333 : 1;

    let svgWidth, svgHeight;
    if (widthMatch && heightMatch) {
      svgWidth = Math.ceil(parseFloat(widthMatch[1]) * ptToPx);
      svgHeight = Math.ceil(parseFloat(heightMatch[1]) * ptToPx);
    } else {
      // Fallback: viewBox에서 추출 (Mermaid SVG: width="100%" + viewBox)
      const viewBoxMatch = svgTag.match(/viewBox="([^"]+)"/);
      if (viewBoxMatch) {
        const parts = viewBoxMatch[1].split(/[\s,]+/).map(Number);
        if (parts.length >= 4) {
          svgWidth = Math.ceil(parts[2]);
          svgHeight = Math.ceil(parts[3]);
        }
      }
      svgWidth = svgWidth || 800;
      svgHeight = svgHeight || 600;
    }

    // 가로비가 극단적인 다이어그램 (> 5:1)에 세로 패딩 추가
    // portrait 페이지에서 폭에 맞춰 축소해도 텍스트가 읽히도록 보장
    const MAX_ASPECT_RATIO = 5;
    const aspectRatio = svgWidth / svgHeight;
    let renderHeight = svgHeight;
    let paddingTop = 0;
    if (aspectRatio > MAX_ASPECT_RATIO) {
      renderHeight = Math.ceil(svgWidth / MAX_ASPECT_RATIO);
      paddingTop = Math.floor((renderHeight - svgHeight) / 2);
    }

    await page.setViewport({
      width: svgWidth * scale,
      height: renderHeight * scale,
      deviceScaleFactor: scale,
    });

    // SVG를 HTML에 임베드하여 렌더링
    // fontFamily가 지정되면 CSS로 강제 적용 (SVG 속성보다 우선)
    const fontCss = fontFamily
      ? `text, .node text, .edge text, .graph text { font-family: "${fontFamily}", "Malgun Gothic", sans-serif !important; }`
      : '';
    const paddingCss = paddingTop > 0 ? `padding-top: ${paddingTop}px;` : '';
    const html = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 0; background: white; ${paddingCss} }
  svg { width: ${svgWidth}px; height: ${svgHeight}px; }
  ${fontCss}
</style></head>
<body>${svgString}</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: svgWidth, height: renderHeight },
      omitBackground: false,
    });

    return png;
  } finally {
    await page.close();
  }
}

/**
 * puppeteer 브라우저 인스턴스를 정리한다.
 * processDiagrams 종료 시 호출.
 */
async function closeBrowser() {
  if (_puppeteerBrowser && _puppeteerBrowser.isConnected()) {
    await _puppeteerBrowser.close().catch(() => {});
    _puppeteerBrowser = null;
  }
}

module.exports = { generatePiePalette, svgToPng, closeBrowser };

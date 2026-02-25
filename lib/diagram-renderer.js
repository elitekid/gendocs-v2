/**
 * diagram-renderer.js — MD 내 다이어그램 코드블록 자동 렌더링
 *
 * 사용법 (converter-core.js에서):
 *   const { processDiagrams } = require('./diagram-renderer');
 *   const result = await processDiagrams(markdown, config, baseDir, themeConfig);
 *   // result.markdown — 코드블록이 이미지 참조로 치환된 MD
 *   // result.diagramFiles — 생성된 PNG 파일 경로 배열
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ============================================================
// 테마 매핑 유틸리티
// ============================================================

/**
 * 진한 hex 색상을 밝게 만든다 (노드 배경용)
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

/**
 * gendocs 테마 색상 → Mermaid themeVariables 매핑
 * @param {Object|null} themeConfig - resolveTheme() 결과
 * @returns {Object|null} Mermaid JSON config 또는 null
 */
function buildMermaidConfig(themeConfig) {
  if (!themeConfig || !themeConfig.colors) return null;

  const c = themeConfig.colors;
  const fonts = themeConfig.fonts || {};

  // primary hue 기준으로 인접 hue 3색 생성 (톤 통일, 색상 다양)
  const [pH, pS, pL] = hexToHsl(c.primary);
  const palS = Math.max(0.25, Math.min(pS, 0.55)); // 보고서용 적당한 채도

  // 노드 배경용 3색: primary, +45°, +90° (밝은 톤)
  const nodeBg1 = hslToHex(pH, palS, 0.85);
  const nodeBg2 = hslToHex(pH + 45, palS, 0.85);
  const nodeBg3 = hslToHex(pH + 90, palS, 0.88);
  // 노드 테두리용 3색: 진한 톤
  const nodeBd1 = hslToHex(pH, palS, 0.30);
  const nodeBd2 = hslToHex(pH + 45, palS, 0.35);
  const nodeBd3 = hslToHex(pH + 90, palS, 0.40);

  // 파이 차트용 8색: 넓은 hue 범위 + 밝기 변화
  const piePalette = generatePiePalette(c.primary, 8);

  return {
    theme: 'base',
    themeVariables: {
      // 노드 (flowchart, class diagram 등) — 3색 구분
      primaryColor: nodeBg1,
      primaryBorderColor: nodeBd1,
      primaryTextColor: '#' + c.text,
      secondaryColor: nodeBg2,
      secondaryBorderColor: nodeBd2,
      secondaryTextColor: '#' + c.text,
      tertiaryColor: nodeBg3,
      tertiaryBorderColor: nodeBd3,
      tertiaryTextColor: '#' + c.text,

      // 라인 + 화살표
      lineColor: nodeBd1,

      // 시퀀스 다이어그램 참여자
      actorBkg: '#' + c.primary,
      actorBorder: '#' + c.primary,
      actorTextColor: '#' + c.white,
      activationBorderColor: nodeBd2,
      activationBkgColor: nodeBg2,
      signalColor: '#' + c.text,
      signalTextColor: '#' + c.text,

      // 노트 — 인접 hue로 참여자와 구분
      noteBkgColor: hslToHex(pH + 50, palS * 0.5, 0.92),
      noteBorderColor: hslToHex(pH + 50, palS, 0.45),
      noteTextColor: '#' + c.text,

      // 라벨 + 텍스트
      labelTextColor: '#' + c.text,
      labelBoxBkgColor: '#' + c.white,

      // 섹션 (gantt 등) — 2색 교대
      sectionBkgColor: nodeBg1,
      sectionBkgColor2: nodeBg2,
      altSectionBkgColor: nodeBg3,

      // 폰트
      fontFamily: fonts.default || 'Malgun Gothic',

      // ER 다이어그램
      entityBorder: nodeBd1,

      // 파이 차트 — hue 회전 다색 팔레트
      pie1: piePalette[0],
      pie2: piePalette[1],
      pie3: piePalette[2],
      pie4: piePalette[3],
      pie5: piePalette[4],
      pie6: piePalette[5],
      pie7: piePalette[6],
      pie8: piePalette[7],
      pieOuterStrokeWidth: '1px',
      pieOuterStrokeColor: '#' + c.border,
      pieStrokeColor: '#FFFFFF',
      pieStrokeWidth: '2px',
    }
  };
}

// ============================================================
// 다색 주입: flowchart/state 노드에 교대 색상 클래스 추가
// ============================================================

/**
 * Mermaid 소스에 classDef + class 구문을 주입하여 단색 렌더링 방지.
 * flowchart/stateDiagram 노드에 primary/secondary/tertiary 색상을 round-robin 배정.
 * 이미 classDef가 있거나 노드가 1개 이하면 건드리지 않는다.
 */
function injectMultiColor(code, mermaidConfig) {
  if (!mermaidConfig || !mermaidConfig.themeVariables) return code;
  // 사용자가 직접 스타일링한 경우 건드리지 않음
  if (/^\s*classDef\s/m.test(code)) return code;

  const firstLine = code.trim().split('\n')[0].trim().toLowerCase();
  const tv = mermaidConfig.themeVariables;

  const palette = [
    { fill: tv.primaryColor, stroke: tv.primaryBorderColor, text: tv.primaryTextColor },
    { fill: tv.secondaryColor, stroke: tv.secondaryBorderColor, text: tv.secondaryTextColor },
    { fill: tv.tertiaryColor, stroke: tv.tertiaryBorderColor, text: tv.tertiaryTextColor },
  ];

  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph')) {
    return _injectFlowchartColors(code, palette);
  }
  if (firstLine.startsWith('statediagram')) {
    return _injectStateColors(code, palette);
  }
  return code;
}

/** flowchart/graph 노드에 교대 색상 주입 */
function _injectFlowchartColors(code, palette) {
  const KEYWORDS = new Set([
    'flowchart', 'graph', 'subgraph', 'end', 'classDef', 'class',
    'click', 'style', 'linkStyle', 'direction',
    'TB', 'TD', 'BT', 'RL', 'LR',
  ]);

  const nodes = [];
  const seen = new Set();

  // nodeId 뒤에 shape bracket이 오는 패턴: A[text], B{text}, C(text), D([text]) 등
  const re = /(?:^|[\s;])([A-Za-z_]\w*)\s*(?:\[\[|\[\/|\[\\|\[\(|\[|{{|\{|\(\[|\(\(|\()/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const id = m[1];
    if (!KEYWORDS.has(id) && !seen.has(id)) {
      seen.add(id);
      nodes.push(id);
    }
  }

  if (nodes.length <= 1) return code;

  const defs = palette.map((c, i) =>
    `    classDef c${i} fill:${c.fill},stroke:${c.stroke},color:${c.text}`
  );

  const groups = {};
  nodes.forEach((node, i) => {
    const ci = i % palette.length;
    if (!groups[ci]) groups[ci] = [];
    groups[ci].push(node);
  });

  const assigns = Object.entries(groups).map(([ci, list]) =>
    `    class ${list.join(',')} c${ci}`
  );

  return code + '\n' + defs.join('\n') + '\n' + assigns.join('\n');
}

/** stateDiagram 상태에 교대 색상 주입 */
function _injectStateColors(code, palette) {
  const states = new Set();

  // 전이에서 상태명 추출: StateA --> StateB : label
  const transRe = /^\s*(?:\[\*\]|(\S+))\s*-->\s*(?:\[\*\]|(\S+))/gm;
  let m;
  while ((m = transRe.exec(code)) !== null) {
    if (m[1]) states.add(m[1]);
    if (m[2]) states.add(m[2].replace(/\s*:.*$/, '')); // 라벨 제거
  }

  // state "desc" as name
  const stateDefRe = /^\s*state\s+"[^"]*"\s+as\s+(\S+)/gm;
  while ((m = stateDefRe.exec(code)) !== null) {
    states.add(m[1]);
  }

  const stateList = [...states];
  if (stateList.length <= 1) return code;

  // 상태별 색상 클래스 할당
  const stateClassMap = {};
  stateList.forEach((state, i) => {
    stateClassMap[state] = `c${i % palette.length}`;
  });

  const hasNonAscii = stateList.some(s => /[^\x00-\x7F]/.test(s));

  const defs = palette.map((c, i) =>
    `    classDef c${i} fill:${c.fill},stroke:${c.stroke},color:${c.text}`
  );

  if (hasNonAscii) {
    // 비-ASCII 이름 → :::className 인라인 구문 사용
    // 각 상태의 첫 등장에만 :::cN 추가
    const applied = new Set();
    const lines = code.split('\n');
    const modifiedLines = lines.map(line => {
      // 전이 라인만 수정: A --> B : label
      if (!line.includes('-->')) return line;
      let modified = line;
      for (const [state, cls] of Object.entries(stateClassMap)) {
        if (applied.has(state)) continue;
        // 상태명 뒤에 :::cls 추가 (이미 ::: 있으면 건너뜀)
        const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[\\s\\[])(${escaped})(?=\\s|$|:::)`, 'g');
        if (re.test(modified)) {
          // :::가 이미 붙어있는지 확인
          const attachRe = new RegExp(`(^|[\\s\\[])(${escaped})(?!:::)(?=\\s|$)`, 'g');
          if (attachRe.test(modified)) {
            modified = modified.replace(attachRe, `$1$2:::${cls}`);
            applied.add(state);
          }
        }
      }
      return modified;
    });
    return modifiedLines.join('\n') + '\n' + defs.join('\n');
  }

  // ASCII 이름 → 기존 class 구문 사용
  const groups = {};
  stateList.forEach((state, i) => {
    const ci = i % palette.length;
    if (!groups[ci]) groups[ci] = [];
    groups[ci].push(state);
  });

  const assigns = Object.entries(groups).map(([ci, list]) =>
    `    class ${list.join(',')} c${ci}`
  );

  return code + '\n' + defs.join('\n') + '\n' + assigns.join('\n');
}

// ============================================================
// 렌더러 등록
// ============================================================

const RENDERERS = {};

// Mermaid 렌더러
RENDERERS.mermaid = {
  extensions: ['mermaid'],
  _mmdcPath: null,
  isAvailable() {
    // node_modules/.bin/mmdc 경로로 직접 확인
    const binName = process.platform === 'win32' ? 'mmdc.cmd' : 'mmdc';
    const binPath = path.join(__dirname, '..', 'node_modules', '.bin', binName);
    if (fs.existsSync(binPath)) {
      this._mmdcPath = binPath;
      return true;
    }
    return false;
  },
  async render(code, outputPath, options) {
    const mmdc = this._mmdcPath;

    // 테마 설정: themeConfig → Mermaid JSON config, 없으면 기본 -t 플래그
    let tmpConfigPath = null;
    const mermaidConfig = buildMermaidConfig(options.themeConfig);
    if (mermaidConfig) {
      tmpConfigPath = outputPath.replace(/\.png$/, '.mermaid-config.json');
      fs.writeFileSync(tmpConfigPath, JSON.stringify(mermaidConfig), 'utf-8');
      // 다색 주입: flowchart/state 노드에 교대 색상 클래스 추가
      code = injectMultiColor(code, mermaidConfig);
    }

    const tmpInput = outputPath.replace(/\.png$/, '.mmd');
    fs.writeFileSync(tmpInput, code, 'utf-8');

    const args = [
      '-i', tmpInput,
      '-o', outputPath,
      '-w', String(options.width || 1024),
      '-b', options.backgroundColor || 'white',
      '-s', String(options.scale || 2),
    ];

    if (tmpConfigPath) {
      args.push('-c', tmpConfigPath);
    } else {
      args.push('-t', options.theme || 'default');
    }

    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(mmdc, args, {
        timeout: 30000,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code !== 0) reject(new Error(`Mermaid render failed (exit ${code}): ${stderr}`));
        else resolve();
      });
      proc.on('error', err => reject(new Error(`Mermaid spawn failed: ${err.message}`)));
    });

    // 임시 파일 정리
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (tmpConfigPath && fs.existsSync(tmpConfigPath)) fs.unlinkSync(tmpConfigPath);
  }
};

// Graphviz 렌더러
RENDERERS.graphviz = {
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
    const CJK_FACTOR = 1.8;
    const hasCJK = /[\u3000-\u9fff\uac00-\ud7af]/.test(code);

    const originalFonts = new Set();
    code.replace(/fontname\s*=\s*"([^"]+)"/g, (_, name) => { originalFonts.add(name); });
    const primaryFont = [...originalFonts][0] || 'Malgun Gothic';

    // 레이아웃용 DOT: Courier + fontsize 팽창 (CJK 있을 때)
    let layoutCode = code.replace(/fontname\s*=\s*"(?!Courier\b)([^"]+)"/g, 'fontname="Courier"');
    if (hasCJK) {
      layoutCode = layoutCode.replace(/fontsize\s*=\s*"?(\d+(?:\.\d+)?)"?/g, (m, sz) => {
        return `fontsize="${(parseFloat(sz) * CJK_FACTOR).toFixed(0)}"`;
      });
    }

    let svg = graphviz.dot(layoutCode, 'svg');

    // SVG 복원: Courier → 원래 폰트, 팽창 fontsize → 원래 크기
    svg = svg.replace(/font-family="Courier[^"]*"/g, `font-family="${primaryFont}"`);
    if (hasCJK) {
      svg = svg.replace(/font-size="(\d+(?:\.\d+)?)"/g, (m, sz) => {
        return `font-size="${(parseFloat(sz) / CJK_FACTOR).toFixed(2)}"`;
      });
    }

    // SVG → PNG: puppeteer로 변환 (CSS로 폰트 강제 적용)
    const scale = options.scale || 2;
    const png = await svgToPng(svg, scale, primaryFont);
    fs.writeFileSync(outputPath, png);
  }
};

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
  // --- 레이아웃 속성 (항상 주입, 사용자 미지정 시) ---
  // WASM Graphviz는 한국어 글자 폭을 과소평가하므로 넉넉한 margin + 작은 fontsize 필요
  // fontsize는 항상 주입: 사용자의 node[fontsize=N]이 뒤에 오면 자동 오버라이드됨
  const layoutAttrs = [];
  if (!hasUserPad) {
    layoutAttrs.push(`    pad="0.3"`);
  }
  const nodeLayoutParts = [];
  if (!hasUserMargin) nodeLayoutParts.push('margin="0.5,0.2"');
  if (!hasUserPenwidth) nodeLayoutParts.push('penwidth="1.8"');
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

  // --- 색상 속성 (사용자 커스텀 없을 때만) ---
  const colorAttrs = [];
  if (!hasUserColors) {
    const nodeFill = lightenHex(c.primary, 0.70);
    const nodeBorder = '#' + c.primary;
    const nodeText = '#' + c.text;
    const edgeColor = '#' + c.secondary;

    colorAttrs.push(`    bgcolor="#FFFFFF"`);
    colorAttrs.push(`    fontname="${fontName}"`);
    colorAttrs.push(`    fontsize="12"`);
    colorAttrs.push(`    fontcolor="${nodeText}"`);
    colorAttrs.push(`    node [style="filled" fillcolor="${nodeFill}" color="${nodeBorder}" fontcolor="${nodeText}" fontname="${fontName}" fontsize="10"]`);
    colorAttrs.push(`    edge [color="${edgeColor}" fontcolor="${nodeText}" fontname="${fontName}" fontsize="9"]`);
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
    // SVG에서 viewBox 또는 width/height 추출
    const widthMatch = svgString.match(/width="(\d+(?:\.\d+)?)(?:pt|px)?"/);
    const heightMatch = svgString.match(/height="(\d+(?:\.\d+)?)(?:pt|px)?"/);
    // Graphviz SVG는 pt 단위 → px 변환 (1pt = 1.333px)
    const isPt = svgString.includes('width="') && svgString.includes('pt"');
    const ptToPx = isPt ? 1.333 : 1;
    const svgWidth = widthMatch ? Math.ceil(parseFloat(widthMatch[1]) * ptToPx) : 800;
    const svgHeight = heightMatch ? Math.ceil(parseFloat(heightMatch[1]) * ptToPx) : 600;

    await page.setViewport({
      width: svgWidth * scale,
      height: svgHeight * scale,
      deviceScaleFactor: scale,
    });

    // SVG를 HTML에 임베드하여 렌더링
    // fontFamily가 지정되면 CSS로 강제 적용 (SVG 속성보다 우선)
    const fontCss = fontFamily
      ? `text, .node text, .edge text, .graph text { font-family: "${fontFamily}", "Malgun Gothic", sans-serif !important; }`
      : '';
    const html = `<!DOCTYPE html>
<html><head><style>
  body { margin: 0; padding: 0; background: white; }
  svg { width: ${svgWidth}px; height: ${svgHeight}px; }
  ${fontCss}
</style></head>
<body>${svgString}</body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: svgWidth, height: svgHeight },
      omitBackground: false,
    });

    return png;
  } finally {
    await page.close();
  }
}

// ============================================================
// 태그 → 렌더러 매핑
// ============================================================

/**
 * 코드블록 언어 태그로 적합한 렌더러를 찾는다
 * @param {string} langTag - 코드블록 언어 태그 (mermaid, dot, graphviz 등)
 * @returns {{name: string, renderer: Object}|null}
 */
function getRenderer(langTag) {
  const tag = langTag.toLowerCase().trim();
  for (const [name, renderer] of Object.entries(RENDERERS)) {
    if (renderer.extensions.includes(tag)) return { name, renderer };
  }
  return null;
}

// ============================================================
// 메인: MD 스캔 + 렌더링 + 치환
// ============================================================

/**
 * 마크다운 내 다이어그램 코드블록을 스캔하여 PNG로 렌더링하고,
 * 코드블록을 이미지 참조(![desc](path))로 치환한다.
 *
 * @param {string} markdown - 원본 마크다운
 * @param {Object} config - doc-config JSON
 * @param {string} baseDir - 프로젝트 루트 디렉토리
 * @param {Object|null} [themeConfig] - resolveTheme() 결과 (Mermaid 색상 매핑용)
 * @returns {Promise<{markdown: string, diagramFiles: string[], diagramCount: number}>}
 */
async function processDiagrams(markdown, config, baseDir, themeConfig) {
  const diagramConfig = config.diagrams || {};

  // enabled가 명시적으로 false이면 스킵
  if (diagramConfig.enabled === false) {
    return { markdown, diagramFiles: [], diagramCount: 0 };
  }

  const outputSubdir = diagramConfig.outputDir || '.diagrams';
  const diagramDir = path.join(baseDir, 'output', outputSubdir);

  // 출력 디렉토리 생성
  fs.mkdirSync(diagramDir, { recursive: true });

  const diagramFiles = [];
  let diagramIndex = 0;

  // 코드블록 정규식: ```lang\n...code...\n```
  const codeBlockRegex = /^```(\S+)\s*\n([\s\S]*?)^```\s*$/gm;

  const replacements = [];
  let match;

  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const langTag = match[1];
    const code = match[2];
    const fullMatch = match[0];
    const startIndex = match.index;

    const result = getRenderer(langTag);
    if (!result) continue; // 일반 코드블록 → 스킵

    // 다이어그램 위 줄에서 <!-- diagram: ... --> 주석 탐색 (빈 줄 건너뜀)
    // 이 주석이 있을 때만 렌더링 (opt-in), 없으면 일반 코드블록으로 취급
    const beforeBlock = markdown.substring(0, startIndex);
    const linesAbove = beforeBlock.split('\n');
    let description = null;
    let commentLineIndex = -1; // 주석 줄의 linesAbove 내 인덱스
    for (let li = linesAbove.length - 1; li >= 0 && li >= linesAbove.length - 5; li--) {
      const trimmed = linesAbove[li].trim();
      if (!trimmed) continue; // 빈 줄 건너뜀
      const descMatch = trimmed.match(/^<!--\s*diagram:\s*(.+?)\s*-->$/);
      if (descMatch) { description = descMatch[1]; commentLineIndex = li; }
      break; // 첫 비어있지 않은 줄에서 중단
    }

    // <!-- diagram: --> 주석이 없으면 일반 코드블록으로 취급 (하위 호환)
    if (!description) continue;

    const { name, renderer } = result;
    if (!renderer.isAvailable()) {
      console.warn(`[WARN] ${name} renderer not available, skipping diagram block`);
      continue;
    }

    diagramIndex++;
    const filename = `diagram_${diagramIndex}_${name}.png`;
    const outputPath = path.join(diagramDir, filename);

    const options = {
      width: diagramConfig.width || 1024,
      height: diagramConfig.height || 768,
      scale: diagramConfig.scale || 2,
      theme: diagramConfig.theme || 'default',
      backgroundColor: diagramConfig.backgroundColor || 'white',
      themeConfig: diagramConfig.theme ? null : themeConfig,  // 명시적 theme 우선
    };

    // 주석 줄 시작 위치 계산 (주석~코드블록 전체를 치환하기 위해)
    let commentStart = startIndex;
    if (commentLineIndex >= 0) {
      commentStart = linesAbove.slice(0, commentLineIndex).join('\n').length;
      if (commentLineIndex > 0) commentStart += 1; // 줄바꿈 문자
    }

    replacements.push({
      fullMatch,
      startIndex,
      commentStart,
      description,
      outputPath,
      filename,
      renderer,
      code,
      options,
      name,
    });
  }

  if (replacements.length === 0) {
    return { markdown, diagramFiles: [], diagramCount: 0 };
  }

  // 렌더링 실행 (순차 — Puppeteer 브라우저 재사용을 위해)
  for (const r of replacements) {
    try {
      console.log(`  Rendering ${r.name} diagram ${r.filename}...`);
      await r.renderer.render(r.code, r.outputPath, r.options);
      diagramFiles.push(r.outputPath);
      r.success = true;
    } catch (err) {
      console.error(`  [ERROR] ${r.name} render failed: ${err.message}`);
      r.success = false;
    }
  }

  // puppeteer 브라우저 정리 (Graphviz SVG→PNG 렌더링에 사용)
  if (_puppeteerBrowser && _puppeteerBrowser.isConnected()) {
    await _puppeteerBrowser.close().catch(() => {});
    _puppeteerBrowser = null;
  }

  // MD 치환 (뒤에서부터 → 인덱스 무효화 방지)
  // 주석줄(<!-- diagram: -->) + 사이 빈 줄 + 코드블록 전체를 이미지 참조로 교체
  let modifiedMarkdown = markdown;
  for (const r of [...replacements].reverse()) {
    if (!r.success) continue;
    const relativePath = path.relative(baseDir, r.outputPath).replace(/\\/g, '/');
    const imageRef = `![${r.description}](${relativePath})`;
    const replaceFrom = r.commentStart;
    const replaceTo = r.startIndex + r.fullMatch.length;
    modifiedMarkdown = modifiedMarkdown.substring(0, replaceFrom)
      + imageRef
      + modifiedMarkdown.substring(replaceTo);
  }

  return {
    markdown: modifiedMarkdown,
    diagramFiles,
    diagramCount: replacements.filter(r => r.success).length,
  };
}

/**
 * 다이어그램 코드블록이 마크다운에 존재하는지 빠르게 확인
 * @param {string} markdown
 * @returns {boolean}
 */
function hasDiagramBlocks(markdown) {
  return /^```(?:mermaid|dot|graphviz|d2|diagram:\w+)/m.test(markdown);
}

module.exports = { processDiagrams, getRenderer, hasDiagramBlocks, RENDERERS, buildMermaidConfig, lightenHex, hexToHsl, hslToHex, generatePiePalette, injectMultiColor, injectGraphvizTheme, svgToPng };

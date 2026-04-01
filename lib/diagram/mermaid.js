/**
 * mermaid.js — Mermaid 다이어그램 렌더러 + 색상 주입
 *
 * diagram-renderer.js에서 분리된 모듈.
 */

const fs = require('fs');
const path = require('path');
const { lightenHex, hexToHsl, hslToHex } = require('../theme-utils');
const { svgToPng, generatePiePalette } = require('./svg-utils');

// ============================================================
// 테마 매핑 유틸리티
// ============================================================

/**
 * gendocs 테마 색상 → Mermaid themeVariables 매핑
 * @param {Object|null} themeConfig - resolveTheme() 결과
 * @returns {Object|null} Mermaid JSON config 또는 null
 */
function buildMermaidConfig(themeConfig) {
  if (!themeConfig || !themeConfig.colors) return null;

  const c = themeConfig.colors;
  const fonts = themeConfig.fonts || {};

  // 팔레트 hue 앵커: primary/secondary 중 채도가 높은 쪽 선택
  // v2 테마에서 dk2(primary)는 중립 암색일 수 있고, accent1(secondary)이 실제 색상 아이덴티티
  const [pH, pS] = hexToHsl(c.primary);
  const [sH, sS] = hexToHsl(c.secondary);
  const useSecondary = sS > pS && pS < 0.20; // primary 채도 < 20%이면 secondary 사용
  const anchorH = useSecondary ? sH : pH;
  const anchorS = useSecondary ? sS : pS;
  const palS = Math.max(0.25, Math.min(anchorS, 0.55)); // 보고서용 적당한 채도

  // 노드 배경용 3색: anchor hue, +45°, +90° (밝은 톤)
  const nodeBg1 = hslToHex(anchorH, palS, 0.85);
  const nodeBg2 = hslToHex(anchorH + 45, palS, 0.85);
  const nodeBg3 = hslToHex(anchorH + 90, palS, 0.88);
  // 노드 테두리용 3색: 진한 톤
  const nodeBd1 = hslToHex(anchorH, palS, 0.30);
  const nodeBd2 = hslToHex(anchorH + 45, palS, 0.35);
  const nodeBd3 = hslToHex(anchorH + 90, palS, 0.40);

  // 파이 차트용 8색: anchor 기반 hue 범위 + 밝기 변화
  const pieAnchor = useSecondary ? c.secondary : c.primary;
  const piePalette = generatePiePalette(pieAnchor, 8);

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
      noteBkgColor: hslToHex(anchorH + 50, palS * 0.5, 0.92),
      noteBorderColor: hslToHex(anchorH + 50, palS, 0.45),
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
 * Mermaid 소스에 색상 주입하여 단색 렌더링 방지.
 * - flowchart: classDef + class 구문 주입 (3색 교대)
 * - stateDiagram: 의미론적 색상 (success/failure/warning/neutral)
 * - sequenceDiagram: SVG 후처리로 참여자별 개별 색상 (render 단계에서 처리)
 * 이미 classDef가 있거나 노드가 1개 이하면 건드리지 않는다.
 * @param {Object|null} themeConfig - resolveTheme() 결과 (slots 접근용, 선택적)
 */
function injectMultiColor(code, mermaidConfig, themeConfig) {
  if (!mermaidConfig || !mermaidConfig.themeVariables) return code;

  const firstLine = code.trim().split('\n')[0].trim().toLowerCase();
  const tv = mermaidConfig.themeVariables;

  // 시퀀스 다이어그램: SVG 후처리에서 참여자별 개별 색상 적용 (소스 수정 불필요)
  if (firstLine.startsWith('sequencediagram')) {
    return code;
  }

  // 사용자가 직접 스타일링한 경우 건드리지 않음
  if (/^\s*classDef\s/m.test(code)) return code;

  const palette = [
    { fill: tv.primaryColor, stroke: tv.primaryBorderColor, text: tv.primaryTextColor },
    { fill: tv.secondaryColor, stroke: tv.secondaryBorderColor, text: tv.secondaryTextColor },
    { fill: tv.tertiaryColor, stroke: tv.tertiaryBorderColor, text: tv.tertiaryTextColor },
  ];

  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph')) {
    return _injectFlowchartColors(code, palette);
  }
  if (firstLine.startsWith('statediagram')) {
    return _injectStateColors(code, palette, themeConfig);
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

// 상태명 → 의미론적 카테고리 분류
const STATE_SEMANTICS = {
  success: ['COMPLETED', 'SUCCESS', 'DONE', 'APPROVED', 'ACTIVE', 'ACCEPTED', 'OK',
            '완료', '성공', '승인', '활성'],
  failure: ['FAILED', 'ERROR', 'REJECTED', 'DENIED', 'ABORTED', 'BROKEN',
            '실패', '오류', '거절', '거부'],
  warning: ['EXPIRED', 'TIMEOUT', 'CANCELLED', 'SUSPENDED', 'CLOSED', 'TERMINATED',
            '만료', '취소', '중단', '종료'],
};

function _classifyState(stateName) {
  const upper = stateName.toUpperCase();
  for (const [category, keywords] of Object.entries(STATE_SEMANTICS)) {
    if (keywords.some(kw => upper.includes(kw))) return category;
  }
  return 'neutral';
}

/**
 * stateDiagram 상태에 의미론적 색상 주입.
 * SUCCESS→녹색, FAILURE→적색, WARNING→황색, NEUTRAL→테마 primary.
 * v2 테마 slots 사용 가능 시 accent3(녹)/accent2(주황) 활용.
 * @param {Array} palette - 기본 3색 (fallback)
 * @param {Object|null} themeConfig - resolveTheme() 결과 (slots 접근용)
 */
function _injectStateColors(code, palette, themeConfig) {
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

  // 의미론적 색상 팔레트 생성
  const semanticPalette = _buildStatePalette(themeConfig, palette);

  // 상태별 색상 클래스 할당 (의미론적)
  const stateClassMap = {};
  let neutralIdx = 0;
  stateList.forEach(state => {
    const category = _classifyState(state);
    if (category === 'neutral') {
      // neutral 상태는 기본 palette 색상 교대
      stateClassMap[state] = `n${neutralIdx % 2}`;
      neutralIdx++;
    } else {
      stateClassMap[state] = category;
    }
  });

  const hasNonAscii = stateList.some(s => /[^\x00-\x7F]/.test(s));

  // classDef 생성 (의미론적 + neutral 2색)
  const defs = [
    `    classDef success fill:${semanticPalette.success.fill},stroke:${semanticPalette.success.stroke},color:${semanticPalette.success.text}`,
    `    classDef failure fill:${semanticPalette.failure.fill},stroke:${semanticPalette.failure.stroke},color:${semanticPalette.failure.text}`,
    `    classDef warning fill:${semanticPalette.warning.fill},stroke:${semanticPalette.warning.stroke},color:${semanticPalette.warning.text}`,
    `    classDef n0 fill:${semanticPalette.neutral0.fill},stroke:${semanticPalette.neutral0.stroke},color:${semanticPalette.neutral0.text}`,
    `    classDef n1 fill:${semanticPalette.neutral1.fill},stroke:${semanticPalette.neutral1.stroke},color:${semanticPalette.neutral1.text}`,
  ];

  if (hasNonAscii) {
    // 비-ASCII 이름 → :::className 인라인 구문 사용
    const applied = new Set();
    const lines = code.split('\n');
    const modifiedLines = lines.map(line => {
      if (!line.includes('-->')) return line;
      let modified = line;
      for (const [state, cls] of Object.entries(stateClassMap)) {
        if (applied.has(state)) continue;
        const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[\\s\\[])(${escaped})(?=\\s|$|:::)`, 'g');
        if (re.test(modified)) {
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

  // ASCII 이름 → class 구문 사용
  const classGroups = {};
  stateList.forEach(state => {
    const cls = stateClassMap[state];
    if (!classGroups[cls]) classGroups[cls] = [];
    classGroups[cls].push(state);
  });

  const assigns = Object.entries(classGroups).map(([cls, list]) =>
    `    class ${list.join(',')} ${cls}`
  );

  return code + '\n' + defs.join('\n') + '\n' + assigns.join('\n');
}

/**
 * 상태 다이어그램용 의미론적 색상 팔레트 생성.
 * v2 테마 slots 사용 시 accent 슬롯에서 파생, v1은 고정색 사용.
 */
function _buildStatePalette(themeConfig, fallbackPalette) {
  const textColor = (themeConfig && themeConfig.colors && themeConfig.colors.text)
    ? '#' + themeConfig.colors.text : '#333333';
  const slots = themeConfig && themeConfig.slots;

  if (slots) {
    // v2 테마: accent 슬롯에서 의미론적 색상 파생
    const successHex = slots.accent3 || slots.accent6 || '196B24'; // green
    const failureHex = slots.accent2 || 'E97132'; // orange-red
    const warningHex = slots.accent2 || 'E97132'; // accent2의 밝은 tint → 따뜻한 황색 계열
    const neutral0Hex = slots.accent1 || '156082'; // teal
    const neutral1Hex = slots.dk2 || '0E2841'; // dark blue

    return {
      success: { fill: lightenHex(successHex, 0.72), stroke: lightenHex(successHex, 0.25), text: textColor },
      failure: { fill: lightenHex(failureHex, 0.72), stroke: lightenHex(failureHex, 0.25), text: textColor },
      warning: { fill: lightenHex(warningHex, 0.85), stroke: lightenHex(warningHex, 0.35), text: textColor },
      neutral0: { fill: lightenHex(neutral0Hex, 0.78), stroke: lightenHex(neutral0Hex, 0.30), text: textColor },
      neutral1: { fill: lightenHex(neutral1Hex, 0.82), stroke: lightenHex(neutral1Hex, 0.35), text: textColor },
    };
  }

  // v1 또는 테마 없음: 고정 의미론적 색상
  return {
    success: { fill: '#D4EDDA', stroke: '#28A745', text: textColor },
    failure: { fill: '#F8D7DA', stroke: '#DC3545', text: textColor },
    warning: { fill: '#FFF3CD', stroke: '#FFC107', text: textColor },
    neutral0: fallbackPalette[0] || { fill: '#D6EAF8', stroke: '#2E86C1', text: textColor },
    neutral1: fallbackPalette[1] || { fill: '#E8DAEF', stroke: '#7D3C98', text: textColor },
  };
}

// ============================================================
// 시퀀스 다이어그램 SVG 후처리 (참여자별 개별 색상)
// ============================================================

/**
 * Mermaid 소스에서 시퀀스 다이어그램 참여자 ID를 선언 순서대로 추출.
 * @param {string} code - Mermaid sequenceDiagram 소스
 * @returns {string[]} - 참여자 ID 배열 (선언 순서)
 */
function _extractSequenceParticipants(code) {
  const participants = [];
  const seen = new Set();

  // 명시적 선언: participant X as Label, actor X as Label
  const declRe = /^\s*(?:participant|actor)\s+(\S+)(?:\s+as\s+.+)?$/gm;
  let m;
  while ((m = declRe.exec(code)) !== null) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); participants.push(id); }
  }

  // 명시적 선언이 없으면 메시지에서 추출
  if (participants.length === 0) {
    const msgRe = /^\s*(\S+?)\s*(?:->>|-->>|->|-->|-[x)>])\s*[+-]?\s*(\S+?)\s*:/gm;
    while ((m = msgRe.exec(code)) !== null) {
      for (const id of [m[1], m[2]]) {
        if (!seen.has(id)) { seen.add(id); participants.push(id); }
      }
    }
  }

  return participants;
}

/**
 * Mermaid 소스에서 participant ID → 표시명 매핑을 추출한다.
 * 예: "participant A as 하나원큐" → { "A": "하나원큐" }
 */
function _extractParticipantAliases(code) {
  const aliases = {};
  const re = /^\s*(?:participant|actor)\s+(\S+)\s+as\s+(.+)$/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    aliases[m[1]] = m[2].trim();
  }
  return aliases;
}

/**
 * 테마 accent 슬롯에서 참여자별 고유 색상 생성.
 * 각 색상은 중간~진한 톤 (lightness 0.28~0.42)으로 흰색 텍스트 가독성 보장.
 * @param {Object} themeConfig - resolveTheme() 결과
 * @param {number} count - 필요한 색상 수
 * @returns {{fill: string, stroke: string}[]}
 */
function _generateParticipantColors(themeConfig, count) {
  const slots = themeConfig && themeConfig.slots;
  const colors = themeConfig && themeConfig.colors;

  let sourceHexes;
  if (slots) {
    // dk2, accent1, accent3, accent5, accent4, accent6 순서 (차분한 톤 우선)
    // 네이비/블루 계열 우선, 강한 색상(주황/라임) 후순위
    sourceHexes = [
      slots.dk2, slots.accent1, slots.accent3,
      slots.accent5, slots.accent4, slots.accent6,
      slots.accent2,
    ].filter(Boolean);
  } else if (colors) {
    sourceHexes = [colors.secondary, colors.primary, colors.accent].filter(Boolean);
  } else {
    sourceHexes = ['156082', '0E2841', '0F9ED5', '196B24', 'A02B93'];
  }

  const result = [];
  for (let i = 0; i < count; i++) {
    const srcIdx = i % sourceHexes.length;
    const hex = sourceHexes[srcIdx];
    const [h, s, l] = hexToHsl(hex);

    // 반복 사이클에서 hue 회전 (중복 방지)
    const cycle = Math.floor(i / sourceHexes.length);
    const hueShift = cycle * 20;

    // 밝기 0.30~0.48 범위 (차분한 톤, 흰색 텍스트 가독성 유지)
    let targetL;
    if (l < 0.20) targetL = 0.33;
    else if (l > 0.50) targetL = 0.40;
    else targetL = Math.max(0.28, Math.min(0.48, l));

    // 무채색(grey)은 그대로, 유채색은 적절한 채도 (차분한 톤)
    const targetS = s < 0.05 ? s : Math.max(0.20, Math.min(0.50, s));
    const targetH = h + hueShift;

    const fill = hslToHex(targetH, targetS, targetL);
    const stroke = hslToHex(targetH, targetS, Math.max(0.15, targetL - 0.08));

    result.push({ fill, stroke });
  }

  return result;
}

/**
 * Mermaid 시퀀스 다이어그램 SVG에서 참여자별 개별 색상을 적용한다.
 * 각 participant의 actor rect(top/bottom)에 고유 색상을 부여하고
 * 텍스트를 흰색으로 변경한다.
 *
 * @param {string} svgContent - Mermaid가 생성한 SVG 문자열
 * @param {Object} themeConfig - resolveTheme() 결과
 * @param {string[]} participantOrder - 참여자 ID 순서 배열
 * @returns {string} - 색상이 적용된 SVG
 */
function _recolorSequenceParticipants(svgContent, themeConfig, participantOrder, participantColors, aliases) {
  if (!participantOrder || participantOrder.length === 0) return svgContent;

  const pColors = _generateParticipantColors(themeConfig, participantOrder.length);
  const colorMap = {};
  participantOrder.forEach((id, i) => { colorMap[id] = pColors[i]; });

  // participantColors 오버라이드: 표시명 기준으로 특정 참여자 브랜드 색상 적용
  if (participantColors && aliases) {
    for (const id of participantOrder) {
      const displayName = aliases[id] || id;
      const overrideHex = participantColors[displayName];
      if (overrideHex) {
        const hex = overrideHex.replace('#', '');
        const [h, s, l] = hexToHsl(hex);
        colorMap[id] = {
          fill: '#' + hex,
          stroke: hslToHex(h, s, Math.max(0.10, l - 0.10)),
        };
      }
    }
  }

  let result = svgContent;

  // 1. Actor rect 색상 교체 — inline style로 CSS 오버라이드
  result = result.replace(/<rect\b([^>]*?)(\s*\/?>)/g, (match, attrs, close) => {
    if (!/class="actor\b/.test(attrs)) return match;
    const nameMatch = attrs.match(/name="([^"]+)"/);
    if (!nameMatch) return match;

    const name = nameMatch[1];
    const color = colorMap[name];
    if (!color) return match;

    // 기존 fill/stroke presentation attribute 제거 후 inline style 추가
    let newAttrs = attrs
      .replace(/\s*fill="[^"]*"/g, '')
      .replace(/\s*stroke="[^"]*"/g, '');

    return `<rect${newAttrs} style="fill:${color.fill}; stroke:${color.stroke};"${close}`;
  });

  // 2. Actor 텍스트를 흰색으로 변경 (중간톤 배경 + 흰색 텍스트)
  // 2a. CSS 규칙 교체 (#my-svg 프리픽스 포함)
  result = result.replace(
    /(text\.actor\s*>\s*tspan\s*\{[^}]*?)fill:\s*[^;]+;/g,
    '$1fill:white !important;'
  );
  // 2b. actor 클래스 text의 기존 inline style에 fill:white 추가
  result = result.replace(/<text\b([^>]*class="actor[^"]*"[^>]*)style="([^"]*)">/g, (match, before, style) => {
    return `<text${before}style="${style} fill:white;">`;
  });
  // 2c. actor text 하위 tspan에 직접 inline fill 주입 (가장 확실)
  result = result.replace(/(<text[^>]*class="actor[^"]*"[^>]*>)\s*(<tspan\b)([^>]*>)/g, (match, textTag, tspanOpen, tspanRest) => {
    return `${textTag}${tspanOpen} fill="white" style="fill:white;"${tspanRest}`;
  });

  // 3. Mermaid SVG width="100%" → 고정 픽셀 (svgToPng 호환)
  if (result.includes('width="100%"')) {
    const vbMatch = result.match(/viewBox="([^"]+)"/);
    if (vbMatch) {
      const parts = vbMatch[1].split(/[\s,]+/).map(Number);
      if (parts.length >= 4) {
        // <svg> 태그에서만 width 교체 + height 추가
        result = result.replace(/(<svg\b[^>]*?)width="100%"/, `$1width="${parts[2]}"`);
        const svgTag = result.match(/<svg\b[^>]*>/);
        if (svgTag && !svgTag[0].includes('height="')) {
          result = result.replace(/<svg\b/, `<svg height="${parts[3]}"`);
        }
      }
    }
  }

  return result;
}

// ============================================================
// Mermaid 렌더러
// ============================================================

const mermaidRenderer = {
  extensions: ['mermaid'],
  _mmdcPath: null,
  isAvailable() {
    // node_modules/.bin/mmdc 경로로 직접 확인
    const binName = process.platform === 'win32' ? 'mmdc.cmd' : 'mmdc';
    const binPath = path.join(__dirname, '..', '..', 'node_modules', '.bin', binName);
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
      // 다색 주입: flowchart/state 노드에 색상 주입 (sequence는 SVG 후처리)
      code = injectMultiColor(code, mermaidConfig, options.themeConfig);
    }

    // 시퀀스 다이어그램 감지: SVG 후처리로 참여자별 개별 색상 적용
    const firstLine = code.trim().split('\n')[0].trim().toLowerCase();
    const isSequence = firstLine.startsWith('sequencediagram');
    const hasUserBoxes = /^\s*box\s/m.test(code);
    const usesSvgPipeline = isSequence && options.themeConfig && !hasUserBoxes;

    // 참여자 목록 추출 (SVG 후처리 전에 소스에서 추출)
    const participants = usesSvgPipeline ? _extractSequenceParticipants(code) : [];

    // SVG 파이프라인: 시퀀스 다이어그램은 SVG로 렌더 → 후처리 → PNG 변환
    const actualOutputPath = usesSvgPipeline
      ? outputPath.replace(/\.png$/, '.svg')
      : outputPath;

    const tmpInput = outputPath.replace(/\.png$/, '.mmd');
    fs.writeFileSync(tmpInput, code, 'utf-8');

    const args = [
      '-i', tmpInput,
      '-o', actualOutputPath,
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
      proc.on('close', exitCode => {
        if (exitCode !== 0) reject(new Error(`Mermaid render failed (exit ${exitCode}): ${stderr}`));
        else resolve();
      });
      proc.on('error', err => reject(new Error(`Mermaid spawn failed: ${err.message}`)));
    });

    // 시퀀스 다이어그램: SVG 후처리 → 참여자별 개별 색상 → PNG 변환
    if (usesSvgPipeline) {
      // mmdc가 suffix 추가한 경우 대응 (-1.svg)
      let svgPath = actualOutputPath;
      if (!fs.existsSync(svgPath)) {
        const suffixed = svgPath.replace('.svg', '-1.svg');
        if (fs.existsSync(suffixed)) {
          fs.renameSync(suffixed, svgPath);
        }
      }

      if (fs.existsSync(svgPath)) {
        let svgContent = fs.readFileSync(svgPath, 'utf-8');

        // HTML 래핑된 SVG 처리
        const svgStart = svgContent.indexOf('<svg');
        const svgEnd = svgContent.lastIndexOf('</svg>');
        if (svgStart > 0 && svgEnd > 0) {
          svgContent = svgContent.substring(svgStart, svgEnd + '</svg>'.length);
        }

        // 참여자별 개별 색상 적용 (participantColors로 특정 참여자 브랜드 색상 오버라이드)
        const aliases = _extractParticipantAliases(code);
        svgContent = _recolorSequenceParticipants(svgContent, options.themeConfig, participants, options.participantColors, aliases);

        // SVG → PNG 변환 (puppeteer)
        const scale = options.scale || 2;
        const fonts = options.themeConfig.fonts || {};
        const fontFamily = fonts.default || 'Malgun Gothic';
        const png = await svgToPng(svgContent, scale, fontFamily);
        fs.writeFileSync(outputPath, png);

        // 중간 SVG 정리
        if (fs.existsSync(svgPath)) fs.unlinkSync(svgPath);
      }
    }

    // 임시 파일 정리
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (tmpConfigPath && fs.existsSync(tmpConfigPath)) fs.unlinkSync(tmpConfigPath);
  }
};

module.exports = {
  buildMermaidConfig,
  injectMultiColor,
  _injectFlowchartColors,
  _classifyState,
  _injectStateColors,
  _buildStatePalette,
  _extractSequenceParticipants,
  _extractParticipantAliases,
  _generateParticipantColors,
  _recolorSequenceParticipants,
  mermaidRenderer,
};

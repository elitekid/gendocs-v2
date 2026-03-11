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
const { lightenHex, hexToHsl, hslToHex } = require('./theme-utils');

// ============================================================
// 테마 매핑 유틸리티
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
  // config.output의 디렉토리 기준으로 다이어그램 경로 결정 (--output-dir 지원)
  const outputParent = config.output ? path.dirname(path.join(baseDir, config.output)) : path.join(baseDir, 'output');
  const diagramDir = path.join(outputParent, outputSubdir);

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
      participantColors: diagramConfig.participantColors || null,
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

module.exports = { processDiagrams, getRenderer, hasDiagramBlocks, RENDERERS, buildMermaidConfig, lightenHex, hexToHsl, hslToHex, generatePiePalette, injectMultiColor, injectGraphvizTheme, svgToPng, _extractSequenceParticipants, _generateParticipantColors, _recolorSequenceParticipants, _injectStateColors, _buildStatePalette, _replaceGraphvizColors, _buildColorFamilyMap, _mapToThemeColor };

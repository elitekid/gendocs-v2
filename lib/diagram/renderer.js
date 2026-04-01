/**
 * renderer.js — 다이어그램 메인 렌더러 (MD 스캔 + 렌더링 + 치환)
 *
 * diagram-renderer.js에서 분리된 모듈.
 * 기존 diagram-renderer.js의 모든 exports를 재노출한다.
 */

const fs = require('fs');
const path = require('path');
const { lightenHex, hexToHsl, hslToHex } = require('../theme-utils');
const { generatePiePalette, svgToPng, closeBrowser } = require('./svg-utils');
const {
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
} = require('./mermaid');
const {
  _replaceGraphvizColors,
  _buildColorFamilyMap,
  _adjustCornerRadius,
  _mapToThemeColor,
  injectGraphvizTheme,
  graphvizRenderer,
} = require('./graphviz');

// ============================================================
// 렌더러 등록
// ============================================================

const RENDERERS = {
  mermaid: mermaidRenderer,
  graphviz: graphvizRenderer,
};

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
  await closeBrowser();

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

module.exports = {
  processDiagrams,
  getRenderer,
  hasDiagramBlocks,
  RENDERERS,
  buildMermaidConfig,
  lightenHex,
  hexToHsl,
  hslToHex,
  generatePiePalette,
  injectMultiColor,
  injectGraphvizTheme,
  svgToPng,
  _extractSequenceParticipants,
  _generateParticipantColors,
  _recolorSequenceParticipants,
  _injectStateColors,
  _buildStatePalette,
  _replaceGraphvizColors,
  _buildColorFamilyMap,
  _mapToThemeColor,
};

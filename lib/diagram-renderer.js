/**
 * diagram-renderer.js — MD 내 다이어그램 코드블록 자동 렌더링
 *
 * 사용법 (converter-core.js에서):
 *   const { processDiagrams } = require('./diagram-renderer');
 *   const result = await processDiagrams(markdown, config, baseDir);
 *   // result.markdown — 코드블록이 이미지 참조로 치환된 MD
 *   // result.diagramFiles — 생성된 PNG 파일 경로 배열
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
    const tmpInput = outputPath.replace(/\.png$/, '.mmd');
    fs.writeFileSync(tmpInput, code, 'utf-8');

    const mmdc = this._mmdcPath;
    const args = [
      '-i', tmpInput,
      '-o', outputPath,
      '-w', String(options.width || 1024),
      '-b', options.backgroundColor || 'white',
      '-t', options.theme || 'default',
      '-s', String(options.scale || 2),
    ];

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
  }
};

// Graphviz 렌더러 (Phase 2)
RENDERERS.graphviz = {
  extensions: ['dot', 'graphviz'],
  isAvailable() {
    try { require.resolve('@hpcc-js/wasm-graphviz'); return true; }
    catch { return false; }
  },
  async render(code, outputPath, options) {
    const { Graphviz } = require('@hpcc-js/wasm-graphviz');
    const graphviz = await Graphviz.load();
    const svg = graphviz.dot(code, 'svg');
    // Phase 2: SVG → PNG 변환 필요 (sharp 또는 puppeteer)
    // 현재: SVG 직접 저장
    fs.writeFileSync(outputPath.replace(/\.png$/, '.svg'), svg);
  }
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
 * @returns {Promise<{markdown: string, diagramFiles: string[], diagramCount: number}>}
 */
async function processDiagrams(markdown, config, baseDir) {
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
    for (let li = linesAbove.length - 1; li >= 0 && li >= linesAbove.length - 5; li--) {
      const trimmed = linesAbove[li].trim();
      if (!trimmed) continue; // 빈 줄 건너뜀
      const descMatch = trimmed.match(/^<!--\s*diagram:\s*(.+?)\s*-->$/);
      if (descMatch) { description = descMatch[1]; }
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
    };

    replacements.push({
      fullMatch,
      startIndex,
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

  // MD 치환 (뒤에서부터 → 인덱스 무효화 방지)
  let modifiedMarkdown = markdown;
  for (const r of [...replacements].reverse()) {
    if (!r.success) continue;
    const relativePath = path.relative(baseDir, r.outputPath).replace(/\\/g, '/');
    const imageRef = `![${r.description}](${relativePath})`;
    modifiedMarkdown = modifiedMarkdown.substring(0, r.startIndex)
      + imageRef
      + modifiedMarkdown.substring(r.startIndex + r.fullMatch.length);
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

module.exports = { processDiagrams, getRenderer, hasDiagramBlocks, RENDERERS };

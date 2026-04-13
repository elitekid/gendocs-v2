/**
 * converter-core.js — Generic Markdown → DOCX 변환 엔진
 *
 * 기존 converters에서 추출한 공통 로직. doc-config JSON과 함께 사용하여
 * 코드 작성 없이 새 문서를 변환할 수 있다.
 *
 * 사용법: const core = require('./converter-core');
 *         core.buildAndSave(config);
 */

const fs = require('fs');
const path = require('path');
const { processDiagrams, hasDiagramBlocks } = require('./diagram-renderer');
const { deriveColors, isV2Theme } = require('./theme-utils');
const parseUtils = require('./parsers/parse-utils');

// ============================================================
// 테마 해석
// ============================================================

/**
 * 기존 테마명 → 신규 테마명 매핑 (하위 호환)
 */
const THEME_ALIASES = {
  'navy-professional': 'office-standard',
  'blue-standard': 'office-modern',
  'teal-corporate': 'blue-green',
  'slate-modern': 'marquee',
  'wine-elegant': 'blue-warm',
};

/** 프로젝트 기본 테마 (config.theme 미지정 시 적용) */
const DEFAULT_THEME = 'office-modern';

/**
 * doc-config의 theme/style 설정을 해석하여 테마 객체 반환
 * Fallback 체인: doc-config "style" > theme JSON > 템플릿 DEFAULT
 * v2 테마(slots 기반)는 deriveColors()로 30키 colors 자동 파생
 * @param {Object} config - doc-config JSON
 * @param {string} projectRoot - 프로젝트 루트 디렉토리
 * @returns {Object} - 테마 객체 ({ colors, fonts, sizes, syntax })
 */
function resolveTheme(config, projectRoot) {
  let theme = {};
  // 1) theme JSON 로드 (config.theme 또는 프로젝트 기본 테마)
  //    단, custom 템플릿은 자체 색상을 가지므로 명시적 theme 없으면 기본 테마 스킵
  {
    const isCustomTemplate = config.template && config.template.startsWith('custom/');
    const hasExplicitTheme = !!config.theme;

    if (hasExplicitTheme || !isCustomTemplate) {
      const rawTheme = config.theme || DEFAULT_THEME;
      const themeName = THEME_ALIASES[rawTheme] || rawTheme;
      const themePath = path.join(projectRoot, 'themes', `${themeName}.json`);
      if (fs.existsSync(themePath)) {
        try {
          theme = JSON.parse(fs.readFileSync(themePath, 'utf-8'));
        } catch (e) {
          console.warn(`[WARN] 테마 파일 파싱 실패: ${themePath}`);
        }
      } else {
        console.warn(`[WARN] 테마 파일 없음: ${themePath}`);
      }
    }
  }
  // 2) v2 테마: slots → 30키 colors 파생
  if (isV2Theme(theme)) {
    theme.colors = deriveColors(theme.slots, theme.overrides);
  }
  // 2.5) styleProfile 머지 (themes 이후, doc-config style 이전)
  const _mergeKeys = ['colors', 'fonts', 'sizes', 'syntax', 'spacing', 'code', 'header', 'footer', 'cover', 'toc', 'changeHistory', 'pageMargin', 'cellMargins', 'tableBorder', 'listIndent', 'tocIndent'];
  if (config.styleProfile) {
    let profile = config.styleProfile;
    // 문자열이면 파일 경로로 로드
    if (typeof profile === 'string') {
      const profilePath = path.join(projectRoot, profile);
      if (fs.existsSync(profilePath)) {
        try {
          profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        } catch (e) {
          console.warn(`[WARN] styleProfile 파싱 실패: ${profilePath}`);
          profile = {};
        }
      } else {
        console.warn(`[WARN] styleProfile 없음: ${profilePath}`);
        profile = {};
      }
    }
    for (const key of _mergeKeys) {
      if (profile[key]) {
        theme[key] = { ...(theme[key] || {}), ...profile[key] };
      }
    }
    // orientation도 프로파일에서 가져옴
    if (profile.orientation) theme.orientation = profile.orientation;
  }
  // 3) doc-config style 오버라이드 머지 (최종 우선)
  if (config.style) {
    for (const key of _mergeKeys) {
      if (config.style[key]) {
        theme[key] = { ...(theme[key] || {}), ...config.style[key] };
      }
    }
  }
  // 4) orientation 전달 (doc-config 명시 > styleProfile > 기본값)
  if (config.orientation) theme.orientation = config.orientation;
  else if (!theme.orientation) theme.orientation = 'landscape';
  return theme;
}

// ============================================================
// 템플릿 로더
// ============================================================

/**
 * 템플릿 모듈 로드 + 테마 적용
 * @param {string} templateName - 템플릿 이름 (professional, basic, custom/qbang 등)
 * @param {Object} [themeConfig={}] - resolveTheme() 결과
 * @returns {Object} - 템플릿 API (h1, h2, ... createDocument, saveDocument)
 */
function loadTemplate(templateName, themeConfig = {}) {
  const templatePath = path.join(__dirname, '..', 'templates', 'docx', `${templateName}.js`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`템플릿을 찾을 수 없습니다: ${templatePath}\n  → templates/docx/custom/ 에 커스텀 템플릿을 배치하세요.`);
  }
  const createTemplate = require(templatePath);
  // Factory pattern: createTemplate(theme) returns API object
  if (typeof createTemplate === 'function') {
    return createTemplate(themeConfig);
  }
  // Legacy: module.exports = { h1, h2, ... } (backward compat)
  return createTemplate;
}

// ============================================================
// 마크다운 파싱 유틸리티
// ============================================================

// 파싱 유틸리티 — parse-utils.js에서 위임 (Phase 4)
const { parseTable, lookAheadForImage, getImageDimensions, defaultTableWidths,
        loadPatterns, matchPattern, calculateTableWidths, cleanMarkdownHeader,
} = parseUtils;


// ============================================================
// 메인 빌드 함수
// ============================================================

/**
 * config JSON으로 DOCX 빌드 + 저장
 * @param {Object} config - doc-config JSON
 * @param {string} [projectRoot] - 프로젝트 루트 (기본: lib/../)
 * @returns {Promise<{outputPath: string}>}
 */
async function buildAndSave(config, projectRoot) {
  const baseDir = projectRoot || path.resolve(__dirname, '..');

  // 테마 해석 + 템플릿 로드
  const templateName = config.template || 'professional';
  const themeConfig = resolveTheme(config, baseDir);
  const t = loadTemplate(templateName, themeConfig);
  config._resolvedTheme = themeConfig;

  // 문서 정보 + header/footer 옵션 머지
  const docInfo = config.docInfo || {};
  if (config.headerText) docInfo.headerText = config.headerText;
  if (config.headerBorder != null) docInfo.headerBorder = config.headerBorder;
  if (config.coverStyle) docInfo.coverStyle = config.coverStyle;

  // 원본 소스 경로 (절대 경로 지원)
  const sourcePath = path.isAbsolute(config.source)
    ? config.source
    : path.join(baseDir, config.source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`원본 파일을 찾을 수 없습니다: ${sourcePath}`);
  }

  // 출력 경로 (imageDir 계산에 필요하므로 여기서 미리 결정)
  let outputFile = config.output;
  if (outputFile.includes('{version}')) {
    outputFile = outputFile.replace('{version}', docInfo.version || 'v1.0');
  }
  const outputPath = path.join(baseDir, outputFile);

  // IR 파이프라인으로 변환
  console.log(`Converting ${path.basename(config.source)} to DOCX...`);
  const { transform } = require('./ir/transformer');
  const { layoutToDocx } = require('./ir/layout-to-docx');

  const ext = path.extname(sourcePath).toLowerCase();
  let content, headings, warnings;

  if (ext === '.pdf') {
    // PDF → DOCX (pdf2docx 엔진)
    const { execSync } = require('child_process');
    const scriptPath = path.join(baseDir, 'tools', 'pdf2docx-convert.py');
    execSync(`python -X utf8 "${scriptPath}" "${sourcePath}" "${outputPath}"`, {
      cwd: baseDir,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONUTF8: '1' },
      maxBuffer: 50 * 1024 * 1024,
      stdio: 'pipe',
    });
    return { outputPath };
  } else {
    // MD 경로: 읽기 → 다이어그램 → cleanMarkdownHeader → md-parser
    let markdown = fs.readFileSync(sourcePath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 다이어그램 자동 렌더링
    if (hasDiagramBlocks(markdown)) {
      const diagramResult = await processDiagrams(markdown, config, baseDir, themeConfig);
      markdown = diagramResult.markdown;
      if (diagramResult.diagramCount > 0) {
        console.log(`  ${diagramResult.diagramCount} diagram(s) rendered`);
      }
    }

    const h1Pattern = config.h1CleanPattern || null;
    const untilPattern = config.headerCleanUntil || '## 변경 이력';
    const contentCleaned = cleanMarkdownHeader(markdown, h1Pattern, untilPattern);

    const { parse } = require('./parsers/md-parser');
    ({ content, headings, warnings } = parse(contentCleaned, {
      images: config.images,
      tableWidths: config.tableWidths,
      docType: config._docType,
      orientation: config.orientation || themeConfig.orientation || 'landscape',
      pageMargin: themeConfig.pageMargin,
      baseDir,
    }));
  }

  const layoutIR = transform(
    { content, warnings },
    config,
    { baseDir, headings }
  );

  const children = layoutToDocx(layoutIR.content, t, config);

  // 문서 생성
  const doc = t.createDocument(children, docInfo);

  // 출력 디렉토리 확인
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await t.saveDocument(doc, outputPath);
  console.log(`Done! → ${outputPath}`);

  return { outputPath };
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // 파싱 유틸리티 (parse-utils.js에서 re-export)
  parseTable,
  lookAheadForImage,
  defaultTableWidths,
  calculateTableWidths,
  cleanMarkdownHeader,
  getImageDimensions,
  matchPattern,

  // 메인 빌드
  buildAndSave,

  // 테마 + 템플릿
  resolveTheme,
  loadTemplate,
};

/**
 * auto-docconfig.js — 임의 MD 파일에서 doc-config JSON 자동 생성
 *
 * 사용법:
 *   node tools/auto-docconfig.js <md-path>
 *   node tools/auto-docconfig.js <md-path> --output-dir experiment/output --config-dir experiment/configs
 *   node tools/auto-docconfig.js <md-path> --sabotage   # 의도적으로 나쁜 config (자가개선 실험용)
 *
 * 일반 모드: tableWidths 빈 {} (patterns.json fallback에 의존)
 * --sabotage: 등분 너비 + 최소 pageBreaks (학습 효과 관찰용)
 *             단, patterns.json/reflections.json에 학습된 값이 있으면 우선 적용
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PATTERNS_PATH = path.join(PROJECT_ROOT, 'lib', 'patterns.json');
const REFLECTIONS_PATH = path.join(PROJECT_ROOT, 'lib', 'reflections.json');
function getTotalWidth(orientation) {
  return orientation === 'portrait' ? 9360 : 12960;
}

// ── CLI parsing ──

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const mdPath = args.find(a => !a.startsWith('--'));
const outputDir = getArg('--output-dir') || 'output';
const configDir = getArg('--config-dir') || 'doc-configs';
const sabotageMode = args.includes('--sabotage');

if (!mdPath && require.main === module) {
  console.log('Usage: node tools/auto-docconfig.js <md-path> [--output-dir DIR] [--config-dir DIR] [--sabotage]');
  process.exit(1);
}

// ── MD analysis ──

/**
 * Extract document info from MD content
 */
function extractDocInfo(md, mdPath) {
  const lines = md.split('\n');

  // Title from H1
  const h1Line = lines.find(l => l.match(/^# /));
  const title = h1Line ? h1Line.replace(/^# /, '').trim() : path.basename(mdPath, '.md');

  // Version/date/author from blockquote metadata
  let version = 'v1.0';
  let author = 'auto-collect';
  let createdDate = new Date().toISOString().slice(0, 10);

  for (const line of lines) {
    const vMatch = line.match(/버전[^:]*:\s*(\S+)/i) || line.match(/version[^:]*:\s*(\S+)/i);
    if (vMatch) version = vMatch[1];

    const aMatch = line.match(/작성자[^:]*:\s*(.+)/i) || line.match(/author[^:]*:\s*(.+)/i);
    if (aMatch) author = aMatch[1].trim();

    const dMatch = line.match(/작성일[^:]*:\s*(\S+)/i) || line.match(/date[^:]*:\s*(\S+)/i);
    if (dMatch) createdDate = dMatch[1];
  }

  // Subtitle from source type in blockquote
  let subtitle = '';
  for (const line of lines) {
    const projMatch = line.match(/프로젝트[^:]*:\s*(.+)/i);
    if (projMatch) { subtitle = projMatch[1].trim(); break; }
  }

  return { title, subtitle, version, author, createdDate };
}

/**
 * Extract H1 clean pattern
 */
function extractH1Pattern(md) {
  const h1Match = md.match(/^# (.+)/m);
  if (!h1Match) return null;

  const h1Text = h1Match[1].trim();
  // Take first 3 significant words for pattern
  const words = h1Text.split(/\s+/).slice(0, 3).join(' ');
  return `^# ${words}`;
}

/**
 * Count sections and detect structure
 */
function countSections(md) {
  const lines = md.split('\n');
  let h2Count = 0;
  let h3Count = 0;
  let hasChangeHistory = false;
  let hasToc = false;
  let hasImages = false;

  for (const line of lines) {
    if (line.match(/^## /)) {
      h2Count++;
      if (line.match(/변경\s*이력|Change\s*History|Changelog/i)) hasChangeHistory = true;
      if (line.match(/목차|Table\s*of\s*Contents/i)) hasToc = true;
    }
    if (line.match(/^### /)) h3Count++;
    if (line.match(/^!\[/)) hasImages = true;
  }

  return { h2Count, h3Count, hasChangeHistory, hasToc, hasImages };
}

/**
 * Extract table headers from MD content
 */
function extractTableHeaders(md) {
  const headers = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      // Check if next line is separator
      if (lines[i + 1] && lines[i + 1].trim().match(/^\|[-:| ]+\|$/)) {
        const header = line.replace(/^\|/, '').replace(/\|$/, '')
          .split('|').map(h => h.trim()).join('|');
        if (header && !headers.includes(header)) {
          headers.push(header);
        }
      }
    }
  }
  return headers;
}

/**
 * Compute page breaks heuristic
 */
function computePageBreaks(sections) {
  return {
    afterChangeHistory: sections.hasChangeHistory,
    h2BreakBeforeSection: Math.max(3, Math.min(6, sections.h2Count > 4 ? 4 : sections.h2Count)),
    defaultH3Break: false,
  };
}

/**
 * Compute sabotaged page breaks — minimal settings to force issues
 * Checks reflections for learned IMAGE_NEEDS_PAGE_BREAK fixes
 */
function computeSabotagedPageBreaks(sections) {
  let reflectionHits = 0;
  let imageBreakLearned = false;

  try {
    const data = JSON.parse(fs.readFileSync(REFLECTIONS_PATH, 'utf-8'));
    const reflections = data.reflections || [];
    imageBreakLearned = reflections.some(r =>
      r.outcome === 'FIX' &&
      r.issues && r.issues.some(i => i.type === 'IMAGE_NEEDS_PAGE_BREAK')
    );
    if (imageBreakLearned) reflectionHits++;
  } catch (_) {}

  return {
    breaks: {
      afterChangeHistory: sections.hasChangeHistory,
      h2BreakBeforeSection: 999, // Effectively no H2 breaks
      defaultH3Break: false,
      imageH3AlwaysBreak: imageBreakLearned,
    },
    reflectionHits,
  };
}

/**
 * Compute sabotaged table widths — equal distribution, overridden by learned patterns
 */
function computeSabotagedWidths(md, orientation) {
  const totalWidth = getTotalWidth(orientation);
  const tableHeaders = extractTableHeaders(md);
  const tableWidths = {};
  let patternHits = 0;

  // Load patterns.json
  let patternsCommon = {};
  try {
    const patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf-8'));
    patternsCommon = patterns?.tableWidths?.common || {};
  } catch (_) {}

  for (const header of tableHeaders) {
    // Check patterns.json common first
    if (patternsCommon[header]) {
      tableWidths[header] = patternsCommon[header];
      patternHits++;
    } else {
      // Sabotage: equal distribution (will cause WIDTH_IMBALANCE)
      const cols = header.split('|').length;
      const equalWidth = Math.floor(totalWidth / cols);
      const widths = Array(cols).fill(equalWidth);
      widths[widths.length - 1] = totalWidth - equalWidth * (cols - 1);
      tableWidths[header] = widths;
    }
  }

  return { tableWidths, patternHits, totalTables: tableHeaders.length };
}

/**
 * Detect headerCleanUntil (first content H2 after metadata)
 */
function detectHeaderCleanUntil(md) {
  const lines = md.split('\n');
  for (const line of lines) {
    if (line.match(/^## 변경\s*이력|^## Change\s*History|^## Changelog/i)) {
      return line.trim();
    }
  }
  return '## 변경 이력';
}

// ── Main ──

function generateDocConfig(mdPath, options = {}) {
  const resolvedMdPath = path.resolve(mdPath);
  if (!fs.existsSync(resolvedMdPath)) {
    throw new Error(`MD file not found: ${resolvedMdPath}`);
  }

  const md = fs.readFileSync(resolvedMdPath, 'utf-8');
  const basename = path.basename(mdPath, '.md');
  const isSabotage = options.sabotage !== undefined ? options.sabotage : sabotageMode;

  // Resolve paths relative to project root
  const relativeSource = path.relative(PROJECT_ROOT, resolvedMdPath).replace(/\\/g, '/');
  const outDir = options.outputDir || outputDir;
  const cfgDir = options.configDir || configDir;

  // Analysis
  const docInfo = extractDocInfo(md, mdPath);
  const h1Pattern = extractH1Pattern(md);
  const sections = countSections(md);
  const headerCleanUntil = detectHeaderCleanUntil(md);

  // Build config
  const orientation = options.orientation || 'landscape';
  const config = {
    source: relativeSource,
    output: `${outDir}/${basename}_{version}.docx`.replace(/\\/g, '/'),
    template: 'professional',
    _meta: {
      createdBy: 'auto',
      createdAt: new Date().toISOString().slice(0, 10),
      sabotaged: isSabotage,
    },
  };
  if (orientation !== 'landscape') {
    config.orientation = orientation;
  }

  if (h1Pattern) config.h1CleanPattern = h1Pattern;
  config.headerCleanUntil = headerCleanUntil;

  config.docInfo = {
    title: docInfo.title,
    subtitle: docInfo.subtitle || 'Auto-generated',
    version: docInfo.version,
    author: docInfo.author,
    company: 'Experiment',
    createdDate: docInfo.createdDate,
    modifiedDate: new Date().toISOString().slice(0, 10),
  };

  if (isSabotage) {
    // Sabotage mode: equal widths + minimal breaks (with learning overrides)
    const widthResult = computeSabotagedWidths(md, orientation);
    config.tableWidths = widthResult.tableWidths;
    config._meta.patternHits = widthResult.patternHits;
    config._meta.totalTables = widthResult.totalTables;

    const breakResult = computeSabotagedPageBreaks(sections);
    config.pageBreaks = breakResult.breaks;
    config._meta.reflectionHits = breakResult.reflectionHits;
  } else {
    // Normal mode: empty tableWidths (relies on patterns.json fallback)
    config.tableWidths = {};
    config.pageBreaks = computePageBreaks(sections);
  }

  // Save config
  const cfgDirResolved = path.resolve(PROJECT_ROOT, cfgDir);
  fs.mkdirSync(cfgDirResolved, { recursive: true });
  const configPath = path.join(cfgDirResolved, `${basename}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return { configPath, config };
}

// ── CLI entry ──

if (require.main === module) {
  try {
    const { configPath, config } = generateDocConfig(mdPath);
    console.log(`Generated: ${configPath}`);
    console.log(`  title: ${config.docInfo.title}`);
    console.log(`  source: ${config.source}`);
    console.log(`  output: ${config.output}`);
    if (config._meta.sabotaged) {
      console.log(`  sabotage: tableWidths=${Object.keys(config.tableWidths).length} (${config._meta.patternHits} from patterns)`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
}

module.exports = { generateDocConfig };

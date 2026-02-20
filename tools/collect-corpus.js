/**
 * collect-corpus.js — 웹에서 문서 수집 (실험용 코퍼스)
 *
 * 사용법:
 *   node tools/collect-corpus.js --source github --count 400
 *   node tools/collect-corpus.js --source wikipedia --count 300
 *   node tools/collect-corpus.js --source arxiv --count 200
 *   node tools/collect-corpus.js --source gutenberg --count 100
 *   node tools/collect-corpus.js --status
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(PROJECT_ROOT, 'test-sources', 'corpus');
const MANIFEST_PATH = path.join(CORPUS_DIR, 'manifest.json');

// ── CLI parsing ──

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const source = getArg('--source');
const count = parseInt(getArg('--count') || '100', 10);
const statusMode = args.includes('--status');

// ── HTTP helper ──

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = { 'User-Agent': 'gendocs-corpus-collector/1.0' };
    const opts = new URL(url);
    opts.headers = { ...defaultHeaders, ...headers };

    const transport = opts.protocol === 'http:' ? http : https;
    transport.get(opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode === 429) {
        return reject(new Error('RATE_LIMITED'));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function httpGetJSON(url, headers = {}) {
  const data = await httpGet(url, { Accept: 'application/json', ...headers });
  return JSON.parse(data);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.message === 'RATE_LIMITED' && i < maxRetries - 1) {
        const wait = Math.pow(2, i + 1) * 1000;
        console.log(`  Rate limited, waiting ${wait / 1000}s...`);
        await delay(wait);
      } else {
        throw err;
      }
    }
  }
}

// ── MD wrapping ──

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeTitle(title) {
  return title.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 80);
}

/**
 * Raw 텍스트를 gendocs MD 형식으로 래핑
 */
function wrapInGendocsMd(title, source, sections) {
  const tocEntries = sections.map((s, i) => `- [${i + 1}. ${s.title}](#${i + 1}-${s.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9가-힣-]/g, '')})`);

  let md = `# ${title}\n\n`;
  md += `> **프로젝트**: Corpus Experiment - ${source}\n`;
  md += `> **버전**: v1.0\n`;
  md += `> **작성일**: ${today()}\n\n`;
  md += `---\n\n`;
  md += `## 목차\n`;
  md += `- [변경 이력](#변경-이력)\n`;
  md += tocEntries.join('\n') + '\n\n';
  md += `---\n\n`;
  md += `## 변경 이력\n`;
  md += `| 버전 | 날짜 | 작성자 | 변경 내용 |\n`;
  md += `|------|------|--------|----------|\n`;
  md += `| v1.0 | ${today()} | auto-collect | 문서 수집 |\n\n`;
  md += `---\n\n`;

  for (let i = 0; i < sections.length; i++) {
    md += `## ${i + 1}. ${sections[i].title}\n\n`;
    md += sections[i].body + '\n\n';
  }

  return md;
}

// ── GitHub collector ──

const GITHUB_TOPICS = ['machine-learning', 'web', 'database', 'devops', 'security', 'mobile', 'game', 'data-science', 'cli', 'api'];

async function collectGitHub(count) {
  const dir = path.join(CORPUS_DIR, 'github');
  fs.mkdirSync(dir, { recursive: true });

  const headers = {};
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }

  let collected = 0;
  let topicIdx = 0;
  let page = 1;

  while (collected < count) {
    const topic = GITHUB_TOPICS[topicIdx % GITHUB_TOPICS.length];
    const id = String(collected + 1).padStart(3, '0');
    const outPath = path.join(dir, `gh-${id}.md`);

    if (fs.existsSync(outPath)) {
      collected++;
      if (collected % GITHUB_TOPICS.length === 0) { topicIdx++; page = 1; }
      continue;
    }

    try {
      const perPage = 10;
      const searchUrl = `https://api.github.com/search/repositories?q=topic:${topic}+stars:>100&sort=stars&per_page=${perPage}&page=${page}`;
      const searchResult = await withRetry(() => httpGetJSON(searchUrl, headers));

      if (!searchResult.items || searchResult.items.length === 0) {
        topicIdx++;
        page = 1;
        continue;
      }

      for (const repo of searchResult.items) {
        if (collected >= count) break;
        const rid = String(collected + 1).padStart(3, '0');
        const rOutPath = path.join(dir, `gh-${rid}.md`);
        if (fs.existsSync(rOutPath)) { collected++; continue; }

        try {
          const readmeUrl = `https://api.github.com/repos/${repo.full_name}/readme`;
          const readmeData = await withRetry(() => httpGetJSON(readmeUrl, headers));
          const readmeContent = Buffer.from(readmeData.content || '', 'base64').toString('utf-8');

          if (readmeContent.length < 500) { continue; }

          // Parse existing sections from README
          const sections = parseReadmeSections(readmeContent);
          if (sections.length === 0) { continue; }

          const title = sanitizeTitle(repo.name);
          const md = wrapInGendocsMd(title, 'github', sections);
          fs.writeFileSync(rOutPath, md, 'utf-8');

          collected++;
          console.log(`  [${collected}/${count}] github/${topic}: ${repo.full_name}`);
          await delay(1200);
        } catch (err) {
          console.log(`  [SKIP] ${repo.full_name}: ${err.message}`);
        }
      }

      page++;
      if (page > 5) { topicIdx++; page = 1; }
    } catch (err) {
      console.log(`  [ERROR] topic=${topic}: ${err.message}`);
      topicIdx++;
      page = 1;
      await delay(2000);
    }
  }

  return collected;
}

function parseReadmeSections(md) {
  const lines = md.split('\n');
  const sections = [];
  let currentTitle = null;
  let currentBody = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (currentTitle) {
        sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
      }
      currentTitle = h2Match[1].replace(/^#+\s*/, '').trim();
      currentBody = [];
    } else if (currentTitle) {
      currentBody.push(line);
    }
  }

  if (currentTitle && currentBody.join('').trim().length > 0) {
    sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
  }

  // 섹션이 없으면 전체를 하나의 섹션으로
  if (sections.length === 0) {
    // H1 제거하고 본문만
    const bodyLines = lines.filter(l => !l.match(/^#\s+/));
    const body = bodyLines.join('\n').trim();
    if (body.length > 200) {
      sections.push({ title: 'Overview', body });
    }
  }

  return sections;
}

// ── Wikipedia collector ──

async function collectWikipedia(count) {
  const dir = path.join(CORPUS_DIR, 'wikipedia');
  fs.mkdirSync(dir, { recursive: true });

  let collected = 0;

  while (collected < count) {
    const id = String(collected + 1).padStart(3, '0');
    const outPath = path.join(dir, `wiki-${id}.md`);

    if (fs.existsSync(outPath)) {
      collected++;
      continue;
    }

    try {
      const url = 'https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&grnlimit=1&prop=extracts&explaintext=true&format=json';
      const data = await withRetry(() => httpGetJSON(url));

      const pages = data.query?.pages;
      if (!pages) continue;

      const page = Object.values(pages)[0];
      const text = page.extract || '';
      const title = sanitizeTitle(page.title || 'Untitled');

      if (text.length < 2000) continue;

      // Split into sections by paragraphs
      const sections = splitTextToSections(text, title);
      if (sections.length === 0) continue;

      const md = wrapInGendocsMd(title, 'wikipedia', sections);
      fs.writeFileSync(outPath, md, 'utf-8');

      collected++;
      console.log(`  [${collected}/${count}] wikipedia: ${title}`);
      await delay(1200);
    } catch (err) {
      console.log(`  [ERROR] wikipedia: ${err.message}`);
      await delay(2000);
    }
  }

  return collected;
}

function splitTextToSections(text, fallbackTitle) {
  // Wikipedia extracts often have == Section == markers stripped
  // Split by double newlines and group into sections
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 50);
  if (paragraphs.length === 0) return [];

  const sections = [];
  const perSection = Math.max(2, Math.ceil(paragraphs.length / 5));

  for (let i = 0; i < paragraphs.length; i += perSection) {
    const chunk = paragraphs.slice(i, i + perSection);
    const sectionNum = Math.floor(i / perSection) + 1;
    const sectionNames = ['Overview', 'Details', 'Background', 'Analysis', 'Additional Information', 'Further Details', 'Context', 'Notes'];
    const title = sectionNames[sectionNum - 1] || `Section ${sectionNum}`;
    sections.push({ title, body: chunk.join('\n\n') });
  }

  return sections;
}

// ── arXiv collector ──

const ARXIV_CATEGORIES = ['cs.SE', 'cs.AI', 'cs.CL', 'cs.LG', 'math.CO', 'physics.comp-ph'];

async function collectArxiv(count) {
  const dir = path.join(CORPUS_DIR, 'arxiv');
  fs.mkdirSync(dir, { recursive: true });

  let collected = 0;
  let catIdx = 0;
  let start = 0;

  while (collected < count) {
    const id = String(collected + 1).padStart(3, '0');
    const outPath = path.join(dir, `arxiv-${id}.md`);

    if (fs.existsSync(outPath)) {
      collected++;
      continue;
    }

    const category = ARXIV_CATEGORIES[catIdx % ARXIV_CATEGORIES.length];

    try {
      const url = `https://export.arxiv.org/api/query?search_query=cat:${category}&start=${start}&max_results=10&sortBy=submittedDate&sortOrder=descending`;
      const xml = await withRetry(() => httpGet(url));

      const entries = parseArxivEntries(xml);
      if (entries.length === 0) {
        catIdx++;
        start = 0;
        continue;
      }

      for (const entry of entries) {
        if (collected >= count) break;
        const eid = String(collected + 1).padStart(3, '0');
        const eOutPath = path.join(dir, `arxiv-${eid}.md`);
        if (fs.existsSync(eOutPath)) { collected++; continue; }

        if (entry.summary.length < 200) continue;

        const sections = [
          {
            title: 'Paper Information',
            body: `| Item | Detail |\n|------|--------|\n| Title | ${entry.title} |\n| Authors | ${entry.authors} |\n| Category | ${category} |\n| Published | ${entry.published} |`
          },
          { title: 'Abstract', body: entry.summary },
          {
            title: 'Keywords',
            body: extractKeywords(entry.title, entry.summary).map(k => `- ${k}`).join('\n')
          }
        ];

        const md = wrapInGendocsMd(sanitizeTitle(entry.title), 'arxiv', sections);
        fs.writeFileSync(eOutPath, md, 'utf-8');

        collected++;
        console.log(`  [${collected}/${count}] arxiv/${category}: ${entry.title.substring(0, 50)}...`);
      }

      start += 10;
      if (start >= 50) { catIdx++; start = 0; }
      await delay(3000); // arXiv is strict about rate limits
    } catch (err) {
      console.log(`  [ERROR] arxiv/${category}: ${err.message}`);
      catIdx++;
      start = 0;
      await delay(5000);
    }
  }

  return collected;
}

function parseArxivEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.trim() || '';
    const published = (block.match(/<published>([\s\S]*?)<\/published>/) || [])[1]?.trim() || '';

    const authorRegex = /<name>([\s\S]*?)<\/name>/g;
    const authors = [];
    let am;
    while ((am = authorRegex.exec(block)) !== null) {
      authors.push(am[1].trim());
    }

    entries.push({ title, summary, published: published.slice(0, 10), authors: authors.join(', ') });
  }

  return entries;
}

function extractKeywords(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  const candidates = text.match(/\b[a-z]{4,}\b/g) || [];
  const stopwords = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'their', 'which', 'these', 'those', 'more', 'also', 'such', 'than', 'into', 'some', 'when', 'over', 'about', 'most', 'only', 'will', 'each', 'other', 'between', 'where', 'after', 'before', 'under', 'through', 'show', 'based', 'using', 'propose', 'proposed', 'approach', 'method', 'methods', 'results', 'paper', 'work']);
  const freq = {};
  for (const w of candidates) {
    if (!stopwords.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
}

// ── Gutenberg collector ──

async function collectGutenberg(count) {
  const dir = path.join(CORPUS_DIR, 'gutenberg');
  fs.mkdirSync(dir, { recursive: true });

  let collected = 0;
  let page = 1;

  while (collected < count) {
    const id = String(collected + 1).padStart(3, '0');
    const outPath = path.join(dir, `gut-${id}.md`);

    if (fs.existsSync(outPath)) {
      collected++;
      continue;
    }

    try {
      const url = `https://gutendex.com/books/?languages=en&mime_type=text/plain&page=${page}`;
      const data = await withRetry(() => httpGetJSON(url));

      if (!data.results || data.results.length === 0) {
        page++;
        if (page > 20) break;
        continue;
      }

      for (const book of data.results) {
        if (collected >= count) break;
        const bid = String(collected + 1).padStart(3, '0');
        const bOutPath = path.join(dir, `gut-${bid}.md`);
        if (fs.existsSync(bOutPath)) { collected++; continue; }

        // Find plain text URL
        const textUrl = book.formats?.['text/plain; charset=utf-8']
          || book.formats?.['text/plain']
          || book.formats?.['text/plain; charset=us-ascii'];

        if (!textUrl) continue;

        try {
          // Use http or https based on URL
          let text = await withRetry(() => httpGet(textUrl));

          // Strip Gutenberg header/footer
          const startMarker = text.indexOf('*** START');
          const endMarker = text.indexOf('*** END');
          if (startMarker >= 0) {
            const afterStart = text.indexOf('\n', startMarker);
            text = text.substring(afterStart + 1);
          }
          if (endMarker >= 0) {
            text = text.substring(0, endMarker);
          }

          text = text.trim();
          if (text.length < 1000) continue;

          // Truncate to ~5000 chars
          if (text.length > 5000) text = text.substring(0, 5000);

          const title = sanitizeTitle(book.title || 'Untitled');
          const authors = (book.authors || []).map(a => a.name).join(', ') || 'Unknown';

          const sections = splitLiteraryText(text, title, authors);
          const md = wrapInGendocsMd(title, 'gutenberg', sections);
          fs.writeFileSync(bOutPath, md, 'utf-8');

          collected++;
          console.log(`  [${collected}/${count}] gutenberg: ${title.substring(0, 50)}`);
          await delay(1500);
        } catch (err) {
          console.log(`  [SKIP] gutenberg/${book.title}: ${err.message}`);
        }
      }

      page++;
    } catch (err) {
      console.log(`  [ERROR] gutenberg: ${err.message}`);
      page++;
      await delay(3000);
    }
  }

  return collected;
}

function splitLiteraryText(text, title, authors) {
  const sections = [
    {
      title: 'Book Information',
      body: `| Item | Detail |\n|------|--------|\n| Title | ${title} |\n| Author | ${authors} |\n| Source | Project Gutenberg |`
    }
  ];

  // Split text into ~1200 char chunks
  const chunkSize = 1200;
  const sectionNames = ['Opening', 'Development', 'Continuation', 'Further'];
  let offset = 0;

  for (let i = 0; i < 4 && offset < text.length; i++) {
    let end = Math.min(offset + chunkSize, text.length);
    // Find paragraph boundary
    const nextPara = text.indexOf('\n\n', end - 100);
    if (nextPara > 0 && nextPara < end + 200) end = nextPara;

    const chunk = text.substring(offset, end).trim();
    if (chunk.length > 100) {
      sections.push({ title: sectionNames[i] || `Part ${i + 1}`, body: chunk });
    }
    offset = end;
  }

  return sections;
}

// ── Manifest management ──

function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  }
  return { created: today(), sources: {}, totalCollected: 0 };
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).length;
}

// ── Main ──

async function main() {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });

  if (statusMode) {
    const manifest = loadManifest();
    console.log('\n=== Corpus Status ===\n');
    for (const src of ['github', 'wikipedia', 'arxiv', 'gutenberg']) {
      const dir = path.join(CORPUS_DIR, src);
      const n = countFiles(dir);
      console.log(`  ${src}: ${n} files`);
    }
    const total = ['github', 'wikipedia', 'arxiv', 'gutenberg'].reduce(
      (sum, s) => sum + countFiles(path.join(CORPUS_DIR, s)), 0
    );
    console.log(`\n  Total: ${total} files`);
    return;
  }

  if (!source) {
    console.log('Usage: node tools/collect-corpus.js --source <github|wikipedia|arxiv|gutenberg> --count <N>');
    console.log('       node tools/collect-corpus.js --status');
    process.exit(1);
  }

  console.log(`\n=== Collecting ${count} documents from ${source} ===\n`);

  let collected = 0;
  const startTime = Date.now();

  switch (source) {
    case 'github':
      collected = await collectGitHub(count);
      break;
    case 'wikipedia':
      collected = await collectWikipedia(count);
      break;
    case 'arxiv':
      collected = await collectArxiv(count);
      break;
    case 'gutenberg':
      collected = await collectGutenberg(count);
      break;
    default:
      console.error(`Unknown source: ${source}`);
      process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Update manifest
  const manifest = loadManifest();
  manifest.sources[source] = {
    collected: countFiles(path.join(CORPUS_DIR, source)),
    lastUpdated: today(),
  };
  manifest.totalCollected = ['github', 'wikipedia', 'arxiv', 'gutenberg'].reduce(
    (sum, s) => sum + countFiles(path.join(CORPUS_DIR, s)), 0
  );
  saveManifest(manifest);

  console.log(`\n=== Done: ${collected} collected in ${elapsed}s (total: ${manifest.totalCollected}) ===`);
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});

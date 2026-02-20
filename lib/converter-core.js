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

// ============================================================
// 테마 해석
// ============================================================

/**
 * doc-config의 theme/style 설정을 해석하여 테마 객체 반환
 * Fallback 체인: doc-config "style" > theme JSON > 템플릿 DEFAULT
 * @param {Object} config - doc-config JSON
 * @param {string} projectRoot - 프로젝트 루트 디렉토리
 * @returns {Object} - 테마 객체 ({ colors, fonts, sizes, syntax })
 */
function resolveTheme(config, projectRoot) {
  let theme = {};
  // 1) theme JSON 로드 (config.theme이 있으면)
  if (config.theme) {
    const themePath = path.join(projectRoot, 'themes', `${config.theme}.json`);
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
  // 2) doc-config style 오버라이드 머지
  if (config.style) {
    for (const key of ['colors', 'fonts', 'sizes', 'syntax']) {
      if (config.style[key]) {
        theme[key] = { ...(theme[key] || {}), ...config.style[key] };
      }
    }
  }
  // 3) orientation 전달 (portrait/landscape)
  theme.orientation = config.orientation || 'landscape';
  return theme;
}

// ============================================================
// 템플릿 로더
// ============================================================

/**
 * 템플릿 모듈 로드 + 테마 적용
 * @param {string} templateName - 템플릿 이름 (professional, basic)
 * @param {Object} [themeConfig={}] - resolveTheme() 결과
 * @returns {Object} - 템플릿 API (h1, h2, ... createDocument, saveDocument)
 */
function loadTemplate(templateName, themeConfig = {}) {
  const templatePath = path.join(__dirname, '..', 'templates', 'docx', `${templateName}.js`);
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

/**
 * 마크다운 테이블 라인 배열을 2D 배열로 파싱
 * @param {string[]} lines - 테이블 라인들
 * @returns {string[][]} - [headers, ...rows]
 */
function parseTable(lines) {
  const rows = [];
  for (const line of lines) {
    const isSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(line) &&
                        line.includes('-') &&
                        !line.match(/[a-zA-Z0-9가-힣]/);

    if (line.includes('|') && !isSeparator) {
      const trimmed = line.trim();
      const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
      const inner2 = inner.endsWith('|') ? inner.slice(0, -1) : inner;
      const cells = inner2.split('|')
        .map(c => c.trim().replace(/`/g, '').replace(/\*\*/g, ''));
      if (cells.length > 0) rows.push(cells);
    }
  }
  return rows;
}

/**
 * 이미지 look-ahead: 현재 위치 이후에 이미지 마크다운이 있는지 확인
 * @param {string[]} lines - 전체 라인 배열
 * @param {number} startIdx - 검색 시작 인덱스
 * @param {string} [baseDir] - 프로젝트 루트 (제공 시 파일 존재 여부 확인)
 * @returns {boolean}
 */
function lookAheadForImage(lines, startIdx, baseDir) {
  for (let j = startIdx; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.startsWith('#')) return false;
    if (l.match(/^!\[/)) {
      // baseDir 제공 시 파일 존재 확인 (깨진 참조 무시)
      if (baseDir) {
        const m = l.match(/!\[.*?\]\(([^)]+)\)/);
        if (m) {
          const imgPath = m[1].split('?')[0]; // query string 제거
          if (fs.existsSync(path.resolve(baseDir, imgPath))) return true;
        }
        continue; // 파일 없으면 다음 줄 계속 탐색
      }
      return true;
    }
  }
  return false;
}

/**
 * 가중치 기반 테이블 너비 계산 (fallback)
 * @param {string[]} headers - 헤더 텍스트 배열
 * @param {number} totalWidth - 전체 너비 (기본 12960 DXA = landscape A4)
 * @returns {number[]}
 */
function defaultTableWidths(headers, totalWidth = 12960) {
  const smallHeaders = ['No', '코드', '필수', '길이', '타입', 'MTI', '값', '버전', '시작', '결과', '단계'];
  const mediumHeaders = ['날짜', '작성자', '호출 주체', 'Processing Code', '변경 내용', '참조 섹션',
                         'QR 유형', '판별 조건', '처리 방식', '결제 완료 시점', '사용 지역',
                         'Tag 01 값', '금액(Tag 54)', '금액 입력', 'trxStatus', '비고',
                         'origTxnId', 'origData', '구분', '조건', '방향', '주체', '패턴'];
  const largeHeaders = ['설명', '내용', '용도', '엔드포인트', '필드', 'API명', '항목', '규격',
                        '요건', '동작', '처리', '검증', '권한'];

  const weights = headers.map(h => {
    const header = h.trim();
    if (smallHeaders.some(s => header.includes(s))) return 1;
    if (mediumHeaders.some(m => header.includes(m))) return 2;
    if (largeHeaders.some(l => header.includes(l))) return 4;
    return 2;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(w => Math.floor((w / totalWeight) * totalWidth));
  const diff = totalWidth - widths.reduce((a, b) => a + b, 0);
  widths[widths.length - 1] += diff;
  return widths;
}

/**
 * patterns.json 로드 (캐시)
 */
let _patternsCache = null;
function loadPatterns() {
  if (_patternsCache !== undefined && _patternsCache !== null) return _patternsCache;
  const patternsPath = path.join(__dirname, 'patterns.json');
  if (fs.existsSync(patternsPath)) {
    try {
      _patternsCache = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
    } catch {
      _patternsCache = null;
    }
  } else {
    _patternsCache = null;
  }
  return _patternsCache;
}

/**
 * 패턴 매칭 헬퍼: 헤더 문자열과 패턴 목록에서 매칭되는 너비 반환
 * @param {string} headerStr - 헤더 조인 문자열
 * @param {number} headerCount - 헤더 개수
 * @param {Object} widthsMap - { "패턴": [너비...] }
 * @returns {number[]|null}
 */
function matchPattern(headerStr, headerCount, widthsMap) {
  for (const [pattern, widths] of Object.entries(widthsMap)) {
    const keywords = pattern.split('|').map(k => k.trim());
    const allMatch = keywords.every(k => headerStr.includes(k));
    if (allMatch && widths.length === headerCount) {
      return widths;
    }
  }
  return null;
}

/**
 * 테이블 너비 계산 — fallback 체인:
 *   1. doc-config tableWidths (명시적 설정)
 *   2. patterns.json common (3개+ 문서에서 공유)
 *   3. patterns.json byDocType (문서 유형별)
 *   4. defaultTableWidths (가중치 기반)
 *
 * @param {string[]} headers
 * @param {Object} tableWidthsConfig - config.tableWidths (헤더패턴→너비 매핑)
 * @param {number} totalWidth
 * @param {string} [docType] - doc-config 이름 (patterns.json byDocType 매칭용)
 * @returns {number[]}
 */
function calculateTableWidths(headers, tableWidthsConfig = {}, totalWidth = 12960, docType) {
  const headerStr = headers.join('|');

  // 1. doc-config에 정의된 패턴 매칭
  const configMatch = matchPattern(headerStr, headers.length, tableWidthsConfig);
  if (configMatch) return configMatch;

  // 2-3. patterns.json fallback
  const patterns = loadPatterns();
  if (patterns && patterns.tableWidths) {
    // 2. common 패턴
    if (patterns.tableWidths.common) {
      const commonMatch = matchPattern(headerStr, headers.length, patterns.tableWidths.common);
      if (commonMatch) return commonMatch;
    }

    // 3. byDocType 패턴
    if (docType && patterns.tableWidths.byDocType && patterns.tableWidths.byDocType[docType]) {
      const typeMatch = matchPattern(headerStr, headers.length, patterns.tableWidths.byDocType[docType]);
      if (typeMatch) return typeMatch;
    }
  }

  // 4. fallback: 가중치 기반
  return defaultTableWidths(headers, totalWidth);
}

/**
 * 마크다운 H1 + 메타데이터 + 목차를 제거 (표지에서 이미 표시)
 * @param {string} markdown - 원본 마크다운 텍스트
 * @param {string} h1Pattern - H1 제목 매칭 패턴 (정규식 문자열, 예: "^# BookStore")
 * @param {string} [untilPattern] - 제거 종료 지점 (정규식, 예: "## 변경 이력")
 * @returns {string}
 */
function cleanMarkdownHeader(markdown, h1Pattern, untilPattern) {
  const until = untilPattern || '## ';
  if (!h1Pattern) {
    const regex = new RegExp('^[\\s\\S]*?(?=' + until + ')', '');
    return markdown.replace(regex, '');
  }
  const regex = new RegExp(h1Pattern + '[\\s\\S]*?(?=' + until + ')', '');
  return markdown.replace(regex, '');
}

// ============================================================
// 이미지 크기 유틸리티
// ============================================================

/**
 * PNG 파일에서 실제 크기를 읽어 DOCX에 맞게 비례 축소
 * @param {string} imagePath - PNG 파일 경로
 * @param {number} maxWidthPt - 최대 너비 (포인트, 기본 780 ≈ 가로 A4의 60%)
 * @returns {{width: number, height: number}} - 포인트 단위 (professional.js createImage 호환)
 */
function getImageDimensions(imagePath, maxWidthPt = 780, maxHeightPt = 500) {
  try {
    const buf = fs.readFileSync(imagePath);
    // PNG 헤더에서 크기 읽기 (IHDR chunk: offset 16-23)
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG magic
      const pxWidth = buf.readUInt32BE(16);
      const pxHeight = buf.readUInt32BE(20);
      if (pxWidth > 0 && pxHeight > 0) {
        let targetWidth = Math.min(maxWidthPt, 780);
        const ratio = pxHeight / pxWidth;
        let targetHeight = Math.floor(targetWidth * ratio);
        // 높이가 최대값 초과 시 비례 축소
        if (targetHeight > maxHeightPt) {
          targetHeight = maxHeightPt;
          targetWidth = Math.floor(targetHeight / ratio);
        }
        return { width: targetWidth, height: targetHeight };
      }
    }
  } catch (_) {}
  // 기본값
  return { width: Math.min(maxWidthPt, 780), height: 400 };
}

// ============================================================
// 범용 Markdown → DOCX 요소 변환
// ============================================================

/**
 * 마크다운을 DOCX 요소 배열로 변환
 * @param {string} markdown - 전처리된 마크다운 텍스트
 * @param {Object} config - doc-config JSON
 * @param {string} baseDir - 프로젝트 루트 디렉토리
 * @param {Object} t - 템플릿 모듈
 * @returns {Array} - docx 요소 배열
 */
function convertMarkdownToElements(markdown, config, baseDir, t) {
  const lines = markdown.split('\n');
  const elements = [];
  let i = 0;
  const totalWidth = (config.orientation === 'portrait') ? 9360 : 12960;

  // 페이지 나누기 설정
  const pb = config.pageBreaks || {};
  const afterChangeHistory = pb.afterChangeHistory !== false;  // 기본 true
  const imageH3AlwaysBreak = pb.imageH3AlwaysBreak !== false;  // 기본 true
  const changeDetailH3Break = pb.changeDetailH3Break || false; // 기본 false
  const h2BreakBeforeSection = pb.h2BreakBeforeSection || 0;   // 0이면 비활성
  const pageBreakH2Set = new Set(pb.h2Sections || []);         // 명시적 H2 break 목록
  const pageBreakH3Set = new Set(pb.h3Sections || []);         // 명시적 H3 break 목록
  const noBreakH3Set = new Set(pb.noBreakH3Sections || []);    // break 제외 H3 목록
  const defaultH3Break = pb.defaultH3Break !== false;           // 기본 H3 break 동작 (기본 true)

  // 이미지 설정
  const imgConfig = config.images || {};
  const imageBasePath = imgConfig.basePath ? path.join(baseDir, imgConfig.basePath) : baseDir;
  const imageSectionMap = imgConfig.sectionMap || {};

  // 테이블 너비 설정
  const tableWidthsConfig = config.tableWidths || {};

  // 상태 추적
  let h2Count = 0;
  let isFirstH3AfterH2 = true;
  let currentImageSection = null;
  let beforeStopSection = true;  // h2BreakBeforeSection 이전인지

  while (i < lines.length) {
    const line = lines[i];

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue; }

    // --- 구분선 스킵
    if (line.trim() === '---') { i++; continue; }

    // # H1 제목
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      elements.push(t.h1(line.substring(2).trim()));
      i++; continue;
    }

    // ## H2 제목
    if (line.startsWith('## ')) {
      currentImageSection = null;
      const title = line.substring(3).trim();
      h2Count++;

      // h2BreakBeforeSection 도달 시 이후 H2 break 비활성
      if (h2BreakBeforeSection > 0 && h2Count >= h2BreakBeforeSection) {
        beforeStopSection = false;
      }

      // 페이지 나누기 판정
      let doBreak = false;
      if (pageBreakH2Set.size > 0) {
        // 명시적 목록이 있으면 그것만 따름
        doBreak = pageBreakH2Set.has(title);
      } else if (afterChangeHistory && h2Count === 2) {
        // 기본: 변경이력(첫 H2) 다음 H2에서 break
        doBreak = true;
      } else if (beforeStopSection && h2Count > 2) {
        // stopSection 이전의 H2들은 break
        doBreak = true;
      }

      if (doBreak) {
        elements.push(t.pageBreak());
      }

      isFirstH3AfterH2 = true;
      elements.push(t.h2(title));
      i++; continue;
    }

    // ### H3 제목
    if (line.startsWith('### ')) {
      const title = line.substring(4).trim();
      const sectionMatch = title.match(/^(\d+\.\d+)/);
      const sectionNum = sectionMatch ? sectionMatch[1] : null;

      // 이미지 섹션 여부 (config sectionMap 또는 인라인 ![...] 감지)
      const hasImageConfig = sectionNum && imageSectionMap[sectionNum];
      const hasImageInline = lookAheadForImage(lines, i + 1, baseDir);
      const hasImage = hasImageConfig || hasImageInline;

      // 변경 상세 H3 여부
      const isChangeDetail = title.startsWith('v') && title.includes('변경 상세');

      // 명시적 break 목록
      const inBreakList = sectionNum && pageBreakH3Set.has(sectionNum);
      const inNoBreakList = sectionNum && noBreakH3Set.has(sectionNum);

      // 페이지 나누기 판정
      let doBreak = false;
      if (inNoBreakList) {
        doBreak = false;
      } else if (inBreakList) {
        doBreak = !isFirstH3AfterH2;
      } else if (isChangeDetail && !changeDetailH3Break) {
        doBreak = false;
      } else if (hasImage && imageH3AlwaysBreak) {
        doBreak = !isFirstH3AfterH2;
      } else if (defaultH3Break && beforeStopSection && !isFirstH3AfterH2) {
        doBreak = true;
      }

      if (doBreak) {
        elements.push(t.pageBreak());
      }
      isFirstH3AfterH2 = false;

      elements.push(t.h3(title));

      // 이미지 섹션 처리 — config sectionMap 기반만 (인라인 이미지는 일반 라인으로 처리)
      if (hasImageConfig) {
        currentImageSection = sectionNum;
        const imgInfo = imageSectionMap[sectionNum];

        i++;
        while (i < lines.length) {
          const nextLine = lines[i];
          if (!nextLine.trim()) { i++; continue; }
          if (nextLine.trim().startsWith('```')) break;
          if (nextLine.startsWith('## ') || nextLine.startsWith('### ')) break;
          elements.push(t.text(nextLine.trim()));
          i++;
        }

        // 이미지 삽입
        let imgFile, imgWidth, imgHeight;
        if (typeof imgInfo === 'string') {
          imgFile = imgInfo;
          imgWidth = 780; imgHeight = 500; // 기본 크기
        } else {
          imgFile = imgInfo.file;
          imgWidth = imgInfo.width || 780;
          imgHeight = imgInfo.height || 500;
        }
        const imagePath = path.join(imageBasePath, imgFile);
        if (fs.existsSync(imagePath)) {
          elements.push(t.createImage(imagePath, imgWidth, imgHeight));
        } else {
          console.warn(`[WARN] 이미지 파일 없음: ${imagePath}`);
        }

        // 이미지 섹션 내 코드블록 스킵 (다이어그램 코드)
        if (i < lines.length && lines[i].trim().startsWith('```')) {
          i++;
          while (i < lines.length && !lines[i].trim().startsWith('```')) { i++; }
          i++;
        }
        continue;
      } else {
        currentImageSection = null;
      }

      i++; continue;
    }

    // 이미지 섹션 내 코드블록 스킵
    if (currentImageSection && line.trim().startsWith('```')) {
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { i++; }
      i++;
      continue;
    }

    // #### H4 제목
    if (line.startsWith('#### ')) {
      elements.push(t.h4(line.substring(5).trim().replace(/\*\*/g, '')));
      i++; continue;
    }

    // ##### H5 제목 (bold 텍스트로 렌더링)
    if (line.startsWith('##### ')) {
      elements.push(t.text(line.substring(6).trim().replace(/\*\*/g, ''), { bold: true, spacing: { before: 150 } }));
      i++; continue;
    }

    // > 인용문 (blockquote)
    if (line.startsWith('> ')) {
      let quoteText = line.substring(2).replace(/\*\*/g, '').trim();
      i++;
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteText += ' ' + lines[i].substring(2).replace(/\*\*/g, '').trim();
        i++;
      }
      if (quoteText.startsWith('주의') || quoteText.startsWith('중요')) {
        elements.push(t.warningBox(quoteText));
      } else {
        elements.push(t.infoBox(quoteText));
      }
      elements.push(t.spacer(150));
      continue;
    }

    // ![설명](경로) 인라인 이미지
    if (line.trim().match(/^!\[.*?\]\(.+?\)$/)) {
      const imgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imgMatch && t.createImage) {
        const altText = imgMatch[1];
        const imgPath = imgMatch[2];
        const resolvedPath = path.isAbsolute(imgPath)
          ? imgPath
          : path.join(baseDir, imgPath);

        if (fs.existsSync(resolvedPath)) {
          const dims = getImageDimensions(resolvedPath);
          elements.push(t.createImage(resolvedPath, dims.width, dims.height));
        } else {
          console.warn(`[WARN] 인라인 이미지 없음: ${resolvedPath}`);
          elements.push(t.text(`[이미지 없음: ${altText || imgPath}]`));
        }
        i++; continue;
      }
    }

    // ```코드블록```
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 닫는 ``` 스킵

      if (codeLines.length > 0) {
        const firstNonEmpty = codeLines.find(l => l.trim())?.trim() || '';
        if (firstNonEmpty.startsWith('{') || firstNonEmpty.startsWith('[')) {
          elements.push(t.createJsonBlock(codeLines));
        } else {
          elements.push(t.createSyntaxCodeBlock(codeLines));
        }
        elements.push(t.spacer(100));
      }
      continue;
    }

    // 테이블 | ... |
    if (line.trim().startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }

      const rows = parseTable(tableLines);
      if (rows.length >= 2) {
        const headers = rows[0];
        const dataRows = rows.slice(1);
        const docType = config._docType || undefined;
        const widths = calculateTableWidths(headers, tableWidthsConfig, totalWidth, docType);
        elements.push(t.createTable(headers, widths, dataRows));
        elements.push(t.spacer(100));
      }
      continue;
    }

    // - 불릿 포인트
    if (line.trim().startsWith('- ')) {
      elements.push(t.bullet(line.trim().substring(2)));
      i++; continue;
    }

    // 숫자. 목록
    if (line.trim().match(/^\d+\.\s/)) {
      elements.push(t.bullet(line.trim().replace(/^\d+\.\s/, '')));
      i++; continue;
    }

    // **처리 흐름:** → flowBox
    const flowLabelMatch = line.trim().match(/^\*\*([^*]*처리\s*흐름[^*]*):\*\*\s*$/);
    if (flowLabelMatch) {
      const flowLines = [];
      i++;
      while (i < lines.length) {
        const currentLine = lines[i].trim();
        if (currentLine === '' && flowLines.length > 0 &&
            (i + 1 >= lines.length || lines[i + 1].trim() === '' ||
             lines[i + 1].trim().startsWith('####') ||
             lines[i + 1].trim().startsWith('---') ||
             (lines[i + 1].trim().startsWith('**') && lines[i + 1].trim().endsWith(':**') && !lines[i + 1].includes('Step')))) {
          break;
        }
        if (currentLine.startsWith('####') || currentLine.startsWith('### ') || currentLine.startsWith('## ') || currentLine.startsWith('---')) break;
        if (currentLine.match(/^\*\*(?!Step)[^*]+:\*\*\s*$/) && !currentLine.includes('처리') && flowLines.length > 0) break;
        if (currentLine !== '' && (currentLine.startsWith('**Step') || currentLine.startsWith('- ') || currentLine.match(/^\d+\.\s/))) {
          flowLines.push(currentLine);
        }
        i++;
      }
      if (flowLines.length > 0) {
        elements.push(t.flowBox(flowLines));
        elements.push(t.spacer(80));
      }
      continue;
    }

    // **라벨:** 텍스트
    const labelMatch = line.trim().match(/^\*\*([^*]+):\*\*\s*(.*)?$/);
    if (labelMatch) {
      const label = labelMatch[1] + ':';
      const content = (labelMatch[2] || '').replace(/\*\*/g, '').replace(/`/g, '');
      elements.push(t.labelText(label, content));
      i++; continue;
    }

    // 일반 텍스트
    if (line.trim()) {
      elements.push(t.text(line.trim().replace(/\*\*/g, '').replace(/`/g, '')));
    }
    i++;
  }

  return elements;
}

// ============================================================
// 표지 생성
// ============================================================

/**
 * 표지 페이지 요소 생성
 * @param {Object} docInfo - 문서 정보
 * @param {string} baseDir - 프로젝트 루트
 * @param {Object} t - 템플릿 모듈
 * @param {string|null} logoPath - 로고 경로 (선택)
 * @returns {Array}
 */
function createCoverPage(docInfo, baseDir, t, logoPath) {
  const resolvedLogoPath = logoPath ? path.join(baseDir, logoPath) : null;
  const effectiveLogo = resolvedLogoPath && fs.existsSync(resolvedLogoPath) ? resolvedLogoPath : null;

  return t.createCoverPage(
    docInfo.title,
    docInfo.subtitle || '',
    [
      { label: '버전', value: docInfo.version },
      { label: '최종 수정일', value: docInfo.modifiedDate }
    ],
    docInfo.author || '',
    effectiveLogo
  );
}

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

  // 문서 정보
  const docInfo = config.docInfo || {};

  // 원본 읽기
  const sourcePath = path.join(baseDir, config.source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`원본 파일을 찾을 수 없습니다: ${sourcePath}`);
  }
  let markdown = fs.readFileSync(sourcePath, 'utf-8');

  // 다이어그램 자동 렌더링 (mermaid, dot 등 코드블록 → PNG 변환)
  let diagramResult = null;
  if (hasDiagramBlocks(markdown)) {
    diagramResult = await processDiagrams(markdown, config, baseDir, themeConfig);
    markdown = diagramResult.markdown;
    if (diagramResult.diagramCount > 0) {
      console.log(`  ${diagramResult.diagramCount} diagram(s) rendered`);
    }
  }

  // H1 + 메타데이터 + 목차 제거
  const h1Pattern = config.h1CleanPattern || null;
  const untilPattern = config.headerCleanUntil || '## 변경 이력';
  const contentCleaned = cleanMarkdownHeader(markdown, h1Pattern, untilPattern);

  // 변환
  console.log(`Converting ${path.basename(config.source)} to DOCX...`);
  const contentElements = convertMarkdownToElements(contentCleaned, config, baseDir, t);

  // 표지 + 본문 조립
  const logoPath = config.logoPath || null;
  const children = [
    ...createCoverPage(docInfo, baseDir, t, logoPath),
    ...contentElements
  ];

  // 문서 생성
  const doc = t.createDocument(children, docInfo);

  // 출력 경로
  let outputFile = config.output;
  if (outputFile.includes('{version}')) {
    outputFile = outputFile.replace('{version}', docInfo.version || 'v1.0');
  }
  const outputPath = path.join(baseDir, outputFile);

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
  // 파싱 유틸리티
  parseTable,
  lookAheadForImage,
  defaultTableWidths,
  calculateTableWidths,
  cleanMarkdownHeader,
  getImageDimensions,

  // 변환 함수
  convertMarkdownToElements,
  createCoverPage,

  // 메인 빌드
  buildAndSave,

  // 테마 + 템플릿
  resolveTheme,
  loadTemplate,
};

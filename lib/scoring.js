/**
 * scoring.js — 다차원 품질 점수 계산 모듈
 *
 * validate-docx.py와 review-docx.py의 JSON 출력을 받아
 * 5차원 (content, layout, table, code, structure) 점수를 산출한다.
 *
 * 모든 함수는 순수 함수. 외부 상태/파일 접근 없음.
 */

const WEIGHTS = {
  content: 0.30,
  layout: 0.25,
  table: 0.20,
  code: 0.15,
  structure: 0.10,
};

function clamp(value, min = 1, max = 10) {
  return Math.max(min, Math.min(max, value));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Content 점수 (소스 비교 기반)
 * 소스 비교 없으면 7점 고정
 */
function scoreContent(reviewJson) {
  if (!reviewJson) return { score: 7.0, deductions: [] };

  const issues = reviewJson.issues || [];
  const contentIssues = issues.filter(i =>
    i.type === 'CONTENT_MISSING' || i.type === 'CONTENT_EXTRA'
  );

  // 소스 비교가 없었으면 (config 없이 실행)
  const hasContentCheck = issues.some(i =>
    i.type === 'CONTENT_MISSING' || i.type === 'CONTENT_EXTRA'
  ) || (reviewJson.checks && reviewJson.checks.contentFidelity !== undefined);

  // contentFidelity 결과가 전혀 없으면 (config 없이 단독 실행) 7점 고정
  if (!hasContentCheck && contentIssues.length === 0) {
    return { score: 7.0, deductions: [{ rule: 'NO_SOURCE_COMPARISON', count: 1, penalty: -3.0 }] };
  }

  let score = 10;
  const deductions = [];

  const missingByElement = {};
  const extraCount = { total: 0 };

  for (const issue of contentIssues) {
    if (issue.type === 'CONTENT_MISSING') {
      const elem = issue.element || 'unknown';
      if (!missingByElement[elem]) missingByElement[elem] = 0;
      missingByElement[elem] += (issue.count || 1);
    } else if (issue.type === 'CONTENT_EXTRA') {
      extraCount.total += (issue.count || 1);
    }
  }

  // CONTENT_MISSING 감점
  const missingPenalties = {
    h2: -1.5, h3: -1.5,
    table: -1.0, codeBlock: -1.0,
    bullet: -0.5, image: -0.5,
    infoBox: -0.3, warningBox: -0.3,
  };

  for (const [elem, count] of Object.entries(missingByElement)) {
    const penaltyPer = missingPenalties[elem] || -0.5;
    const penalty = penaltyPer * count;
    score += penalty;
    deductions.push({ rule: 'CONTENT_MISSING', element: elem, count, penalty: round1(penalty) });
  }

  // CONTENT_EXTRA 감점
  if (extraCount.total > 0) {
    const penalty = -0.3 * extraCount.total;
    score += penalty;
    deductions.push({ rule: 'CONTENT_EXTRA', count: extraCount.total, penalty: round1(penalty) });
  }

  return { score: round1(clamp(score)), deductions };
}

/**
 * Layout 점수 (validate-docx 기반)
 */
function scoreLayout(validateJson, reviewJson) {
  if (!validateJson) return { score: 10.0, deductions: [] };

  let score = 10;
  const deductions = [];
  const issues = validateJson.issues || [];
  const pages = validateJson.pages || [];

  // Issue 기반 감점
  const issuePenalties = {
    IMAGE_NEEDS_PAGE_BREAK: -2.0,
    IMAGE_OVERFLOW: -1.5,
  };

  const issueCount = {};

  for (const issue of issues) {
    const type = issue.type || issue.rule || '';
    if (!issueCount[type]) issueCount[type] = 0;
    issueCount[type]++;
  }

  for (const [type, count] of Object.entries(issueCount)) {
    let penaltyPer = issuePenalties[type];

    if (!penaltyPer) {
      // 일반 WARN/INFO 감점
      const severity = issues.find(i => (i.type || i.rule) === type)?.severity;
      if (severity === 'WARN') {
        if (type.includes('consecutive') || type.includes('CONSECUTIVE')) {
          penaltyPer = -1.0;
        } else {
          penaltyPer = -1.5;
        }
      } else if (severity === 'INFO') {
        if (type === 'ORPHAN_HEADING') {
          penaltyPer = -0.3;
        } else if (type === 'TABLE_SPLIT') {
          penaltyPer = -0.2;
        } else {
          penaltyPer = -0.2;
        }
      } else {
        continue;
      }
    }

    const penalty = penaltyPer * count;
    score += penalty;
    deductions.push({ rule: type, count, penalty: round1(penalty) });
  }

  // 희소 페이지 감점 (fillPct < 15%)
  const sparsePages = pages.filter(p => p.fillPct !== undefined && p.fillPct < 15);
  if (sparsePages.length > 0) {
    const penalty = -0.2 * sparsePages.length;
    score += penalty;
    deductions.push({ rule: 'SPARSE_PAGE', count: sparsePages.length, penalty: round1(penalty) });
  }

  // 이미지 비율 감점 (review-docx의 NARROW_IMAGE)
  if (reviewJson) {
    const narrowImages = (reviewJson.issues || []).filter(i => i.type === 'NARROW_IMAGE');
    if (narrowImages.length > 0) {
      const penalty = -1.0 * narrowImages.length;
      score += penalty;
      deductions.push({ rule: 'NARROW_IMAGE', count: narrowImages.length, penalty: round1(penalty) });
    }
    const flatImages = (reviewJson.issues || []).filter(i => i.type === 'FLAT_IMAGE');
    if (flatImages.length > 0) {
      const penalty = -1.0 * flatImages.length;
      score += penalty;
      deductions.push({ rule: 'FLAT_IMAGE', count: flatImages.length, penalty: round1(penalty) });
    }
  }

  return { score: round1(clamp(score)), deductions };
}

/**
 * Table 점수 (review-docx 기반)
 * 테이블 0개면 10점
 */
function scoreTable(reviewJson) {
  if (!reviewJson) return { score: 10.0, deductions: [] };

  const issues = reviewJson.issues || [];
  const stats = reviewJson.stats || {};

  // 테이블이 없으면 10점
  if ((stats.tables || 0) === 0) {
    return { score: 10.0, deductions: [] };
  }

  let score = 10;
  const deductions = [];

  const tablePenalties = {
    WIDTH_IMBALANCE: -1.0,
    WIDE_WASTE: -0.3,
    CELL_OVERFLOW: -0.3,
    EMPTY_COLUMN: -0.2,
    TOO_MANY_COLUMNS: -0.5,
  };

  const issueCount = {};

  for (const issue of issues) {
    const type = issue.type || '';
    if (tablePenalties[type] !== undefined) {
      if (!issueCount[type]) issueCount[type] = 0;
      issueCount[type]++;
    }
  }

  for (const [type, count] of Object.entries(issueCount)) {
    const penalty = tablePenalties[type] * count;
    score += penalty;
    deductions.push({ rule: type, count, penalty: round1(penalty) });
  }

  return { score: round1(clamp(score)), deductions };
}

/**
 * Code 점수 (review-docx 기반)
 * 코드블록 0개면 10점
 */
function scoreCode(reviewJson) {
  if (!reviewJson) return { score: 10.0, deductions: [] };

  const issues = reviewJson.issues || [];
  const stats = reviewJson.stats || {};

  // 코드블록이 없으면 10점
  if ((stats.codeBlocks || 0) === 0) {
    return { score: 10.0, deductions: [] };
  }

  let score = 10;
  const deductions = [];

  const codePenalties = {
    EMPTY_CODE: -2.0,
    TRUNCATED_JSON: -2.5,
  };

  const issueCount = {};

  for (const issue of issues) {
    const type = issue.type || '';
    if (codePenalties[type] !== undefined) {
      if (!issueCount[type]) issueCount[type] = 0;
      issueCount[type]++;
    }
  }

  for (const [type, count] of Object.entries(issueCount)) {
    const penalty = codePenalties[type] * count;
    score += penalty;
    deductions.push({ rule: type, count, penalty: round1(penalty) });
  }

  return { score: round1(clamp(score)), deductions };
}

/**
 * Structure 점수 (validate + review 기반)
 */
function scoreStructure(validateJson, reviewJson) {
  let score = 10;
  const deductions = [];

  // validate-docx 기반
  if (validateJson) {
    const stats = validateJson.stats || {};
    const issues = validateJson.issues || [];

    // header/footer 누락
    if (!stats.hasHeader) {
      score -= 1.0;
      deductions.push({ rule: 'NO_HEADER', count: 1, penalty: -1.0 });
    }
    if (!stats.hasFooter) {
      score -= 1.0;
      deductions.push({ rule: 'NO_FOOTER', count: 1, penalty: -1.0 });
    }

    // heading level skip (WARN)
    const levelSkips = issues.filter(i =>
      (i.type || i.rule || '').includes('HEADING_LEVEL_SKIP') ||
      (i.message || '').includes('level skip')
    );
    if (levelSkips.length > 0) {
      const penalty = -1.5 * levelSkips.length;
      score += penalty;
      deductions.push({ rule: 'HEADING_LEVEL_SKIP', count: levelSkips.length, penalty: round1(penalty) });
    }

    // consecutive pageBreak (WARN)
    const consecutiveBreaks = issues.filter(i =>
      (i.type || i.rule || '').includes('CONSECUTIVE') ||
      (i.message || '').includes('연속')
    );
    if (consecutiveBreaks.length > 0) {
      const penalty = -1.5 * consecutiveBreaks.length;
      score += penalty;
      deductions.push({ rule: 'CONSECUTIVE_PAGE_BREAK', count: consecutiveBreaks.length, penalty: round1(penalty) });
    }
  }

  // review-docx 기반
  if (reviewJson) {
    const issues = reviewJson.issues || [];

    // DUPLICATE_HEADING
    const dupes = issues.filter(i => i.type === 'DUPLICATE_HEADING');
    if (dupes.length > 0) {
      const penalty = -1.0 * dupes.length;
      score += penalty;
      deductions.push({ rule: 'DUPLICATE_HEADING', count: dupes.length, penalty: round1(penalty) });
    }

    // LONG_SECTION
    const longSections = issues.filter(i => i.type === 'LONG_SECTION');
    if (longSections.length > 0) {
      const penalty = -0.3 * longSections.length;
      score += penalty;
      deductions.push({ rule: 'LONG_SECTION', count: longSections.length, penalty: round1(penalty) });
    }
  }

  return { score: round1(clamp(score)), deductions };
}

/**
 * Overall 점수 계산 (가중 평균)
 */
function computeOverall(scores) {
  const overall =
    (scores.content || 0) * WEIGHTS.content +
    (scores.layout || 0) * WEIGHTS.layout +
    (scores.table || 0) * WEIGHTS.table +
    (scores.code || 0) * WEIGHTS.code +
    (scores.structure || 0) * WEIGHTS.structure;

  return round1(overall);
}

module.exports = {
  scoreContent,
  scoreLayout,
  scoreTable,
  scoreCode,
  scoreStructure,
  computeOverall,
  WEIGHTS,
};

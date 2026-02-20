/**
 * extract-patterns.js — 성공한 doc-config에서 재사용 가능한 패턴 추출
 *
 * 사용법:
 *   node tools/extract-patterns.js            # 패턴 추출 + 저장
 *   node tools/extract-patterns.js --audit    # 패턴 추출 + 저장 + 다양성 감사 리포트
 *
 * 전체 doc-config의 tableWidths를 스캔하여:
 * - 3개 이상 doc-config에서 동일 너비로 사용 → common 승격
 * - 1~2개에서만 사용 → byDocType에 유지
 *
 * 결과: lib/patterns.json (_provenance 메타데이터 포함)
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PATTERNS_PATH = path.join(PROJECT_ROOT, 'lib', 'patterns.json');
const SCORES_DIR = path.join(PROJECT_ROOT, 'tests', 'scores');

// --dir 플래그: doc-configs 디렉토리 지정 (기본: doc-configs/)
const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const DOC_CONFIGS_DIR = dirIdx >= 0 && args[dirIdx + 1]
  ? path.resolve(args[dirIdx + 1])
  : path.join(PROJECT_ROOT, 'doc-configs');

const COMMON_THRESHOLD = 3; // 3개 이상이면 common 승격
const QUALITY_GATE = 7.0;   // common 승격 시 평균 점수 게이트

const auditMode = process.argv.includes('--audit');

function getConfigName(configPath) {
  return path.basename(configPath, '.json');
}

/**
 * doc-config에서 _meta.createdBy 읽기
 * @param {Object} config - 파싱된 doc-config
 * @returns {string} "human" | "ai" | "unknown"
 */
function getDocOrigin(config) {
  return config._meta?.createdBy || 'unknown';
}

/**
 * tests/scores/ 에서 점수 맵 로드
 * @returns {{ [docName: string]: number } | null} — 점수 파일이 없으면 null
 */
function loadScoreMap() {
  if (!fs.existsSync(SCORES_DIR)) return null;

  const scoreFiles = fs.readdirSync(SCORES_DIR).filter(f => f.endsWith('.scores.json'));
  if (scoreFiles.length === 0) return null;

  const scoreMap = {};
  for (const f of scoreFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SCORES_DIR, f), 'utf-8'));
      const name = data.docConfig || path.basename(f, '.scores.json');
      if (data.latestOverall !== undefined) {
        scoreMap[name] = data.latestOverall;
      }
    } catch (err) {
      // 파싱 실패는 무시
    }
  }

  return Object.keys(scoreMap).length > 0 ? scoreMap : null;
}

/**
 * usedBy 목록의 평균 점수 계산
 */
function avgScore(usedBy, scoreMap) {
  if (!scoreMap) return 0;
  const scores = usedBy.map(name => scoreMap[name]).filter(s => s !== undefined);
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * 출처별 카운트 계산
 * @param {string[]} usedBy - doc-config 이름 목록
 * @param {{ [name: string]: string }} originMap - doc-config 이름 → origin 매핑
 * @returns {{ human: number, ai: number, unknown: number }}
 */
function countOrigins(usedBy, originMap) {
  const counts = { human: 0, ai: 0, unknown: 0 };
  for (const name of usedBy) {
    const origin = originMap[name] || 'unknown';
    counts[origin] = (counts[origin] || 0) + 1;
  }
  return counts;
}

/**
 * 다양성 메트릭 계산
 * @param {Object} patternMap - { pattern: { widthsKey: { widths, usedBy } } }
 * @returns {{ totalPatterns: number, multiVariantPatterns: number, diversityRatio: number, avgVariants: number, converging: Array }}
 */
function calculateDiversity(patternMap) {
  const patterns = Object.keys(patternMap);
  const totalPatterns = patterns.length;
  let multiVariantPatterns = 0;
  let totalVariants = 0;
  const converging = [];

  for (const pattern of patterns) {
    const variants = Object.keys(patternMap[pattern]);
    const variantCount = variants.length;
    totalVariants += variantCount;

    if (variantCount >= 2) {
      multiVariantPatterns++;
    }

    // 수렴 감지: 5개+ 문서가 동일 너비를 사용
    for (const widthsKey of variants) {
      const entry = patternMap[pattern][widthsKey];
      if (entry.usedBy.length >= 5) {
        converging.push({
          pattern,
          usedBy: entry.usedBy.length,
          variantCount,
        });
      }
    }
  }

  return {
    totalPatterns,
    multiVariantPatterns,
    diversityRatio: totalPatterns > 0 ? multiVariantPatterns / totalPatterns : 0,
    avgVariants: totalPatterns > 0 ? totalVariants / totalPatterns : 0,
    converging,
  };
}

/**
 * 감사 리포트 출력
 */
function printAuditReport(patternMap, common, originMap, scoreMap, totalConfigs, diversity) {
  console.log('\n=== 패턴 다양성 감사 리포트 ===\n');

  // 패턴 통계
  console.log('패턴 통계:');
  console.log(`  총 패턴: ${diversity.totalPatterns}개 (${totalConfigs}개 doc-config에서 추출)`);
  console.log(`  common: ${Object.keys(common).length}개 | byDocType: ${Object.keys(patternMap).length - Object.keys(common).length}개 패턴\n`);

  // 출처 분포
  const originCounts = { human: 0, ai: 0, unknown: 0 };
  for (const origin of Object.values(originMap)) {
    originCounts[origin] = (originCounts[origin] || 0) + 1;
  }
  const total = totalConfigs || 1;
  console.log('출처 분포:');
  console.log(`  human: ${originCounts.human}개 (${(originCounts.human / total * 100).toFixed(1)}%) | ai: ${originCounts.ai}개 (${(originCounts.ai / total * 100).toFixed(1)}%) | unknown: ${originCounts.unknown}개 (${(originCounts.unknown / total * 100).toFixed(1)}%)\n`);

  // 다양성 메트릭
  console.log('다양성 메트릭:');
  console.log(`  Variant 2개+ 패턴: ${diversity.multiVariantPatterns}/${diversity.totalPatterns} (${(diversity.diversityRatio * 100).toFixed(1)}%)`);
  console.log(`  평균 variant 수: ${diversity.avgVariants.toFixed(2)}`);
  console.log(`  수렴 패턴 (5개+ 동일 너비): ${diversity.converging.length}개\n`);

  // Common 패턴 상세
  const commonKeys = Object.keys(common);
  if (commonKeys.length > 0) {
    console.log('Common 패턴 상세:');
    for (const pattern of commonKeys) {
      // 해당 패턴의 전체 usedBy 찾기
      const variants = Object.values(patternMap[pattern] || {});
      const allUsedBy = variants.reduce((acc, v) => acc.concat(v.usedBy), []);
      const best = variants.sort((a, b) => b.usedBy.length - a.usedBy.length)[0];
      const variantCount = Object.keys(patternMap[pattern] || {}).length;
      const avg = scoreMap ? avgScore(best ? best.usedBy : allUsedBy, scoreMap) : null;
      const scoreStr = avg !== null ? `, avg=${avg.toFixed(1)}` : '';
      const displayPattern = pattern.length > 30 ? pattern.substring(0, 30) + '...' : pattern;
      console.log(`  "${displayPattern}"  ${best ? best.usedBy.length : allUsedBy.length}개 문서, variant=${variantCount}${scoreStr}`);
    }
    console.log('');
  }

  // 경고
  const warnings = [];
  if (originCounts.human === 0) {
    warnings.push('Common 패턴 중 human-origin 0개 — human-verified 패턴 추가 권장');
  }
  for (const entry of diversity.converging) {
    if (entry.variantCount === 1 && entry.usedBy >= 10) {
      warnings.push(`"${entry.pattern.length > 30 ? entry.pattern.substring(0, 30) + '...' : entry.pattern}": ${entry.usedBy}개 문서 동일 너비 (variant=1)`);
    }
  }

  if (warnings.length > 0) {
    console.log('⚠  경고:');
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
    console.log('');
  }

  // 권장사항
  console.log('권장사항:');
  console.log('  - doc-config에 _meta.createdBy: "human" 추가하여 수작업 문서 추적');
  console.log('  - 기존 패턴에 대안 너비(variant) 검토');
}

function main() {
  // doc-configs 수집
  const configFiles = fs.readdirSync(DOC_CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DOC_CONFIGS_DIR, f));

  if (configFiles.length === 0) {
    console.log('doc-configs/ 에 JSON 파일이 없습니다.');
    process.exit(0);
  }

  console.log(`\n=== 패턴 추출 시작 (${configFiles.length}개 문서) ===\n`);

  // 출처 맵 수집: { docName: "human" | "ai" | "unknown" }
  const originMap = {};

  // 패턴 수집: { "헤더패턴": { widthsKey: { widths: [...], usedBy: ["config1", "config2"] } } }
  const patternMap = {};

  for (const configPath of configFiles) {
    const name = getConfigName(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // 출처 추론
    originMap[name] = getDocOrigin(config);

    const tableWidths = config.tableWidths || {};

    for (const [pattern, widths] of Object.entries(tableWidths)) {
      const key = pattern;
      const widthsKey = JSON.stringify(widths);

      if (!patternMap[key]) {
        patternMap[key] = {};
      }

      if (!patternMap[key][widthsKey]) {
        patternMap[key][widthsKey] = { widths, usedBy: [] };
      }

      patternMap[key][widthsKey].usedBy.push(name);
    }
  }

  // ===== Reflection-based pattern extraction =====
  const REFLECTIONS_PATH = path.join(PROJECT_ROOT, 'lib', 'reflections.json');

  if (fs.existsSync(REFLECTIONS_PATH)) {
    const refData = JSON.parse(fs.readFileSync(REFLECTIONS_PATH, 'utf-8'));
    const reflections = refData.reflections || [];

    const widthFixes = reflections.filter(r =>
      (r.outcome === 'FIX' || r.outcome === 'SUGGEST_APPLIED') &&
      r.fix && r.fix.target === 'doc-config' &&
      r.fix.field === 'tableWidths' &&
      r.fix.value && typeof r.fix.value === 'object'
    );

    for (const r of widthFixes) {
      for (const [pattern, widths] of Object.entries(r.fix.value)) {
        const widthsKey = JSON.stringify(widths);
        if (!patternMap[pattern]) patternMap[pattern] = {};
        if (!patternMap[pattern][widthsKey]) {
          patternMap[pattern][widthsKey] = { widths, usedBy: [] };
        }
        if (!patternMap[pattern][widthsKey].usedBy.includes(r.docName)) {
          patternMap[pattern][widthsKey].usedBy.push(r.docName);
        }
      }
    }

    console.log(`  reflections.json에서 ${widthFixes.length}개 너비 수정 기록 병합`);
  }

  // 점수 맵 로드 (없으면 null — 하위 호환)
  const scoreMap = loadScoreMap();
  if (scoreMap) {
    console.log(`  tests/scores/ 에서 ${Object.keys(scoreMap).length}개 문서 점수 로드`);
  }

  // 분류: common vs byDocType
  const common = {};
  const byDocType = {};

  for (const [pattern, widthVariants] of Object.entries(patternMap)) {
    // 가장 많이 사용된 너비를 선택 (동일 usedBy 수일 때 점수로 tiebreak)
    const variants = Object.values(widthVariants);
    variants.sort((a, b) => {
      if (b.usedBy.length !== a.usedBy.length) return b.usedBy.length - a.usedBy.length;
      return avgScore(b.usedBy, scoreMap) - avgScore(a.usedBy, scoreMap);
    });
    const best = variants[0];

    if (best.usedBy.length >= COMMON_THRESHOLD) {
      // 품질 게이트: 점수 파일이 있으면 평균 7.0 이상이어야 common 승격
      const avg = avgScore(best.usedBy, scoreMap);
      if (!scoreMap || avg >= QUALITY_GATE) {
        common[pattern] = best.widths;
        const scoreInfo = scoreMap ? ` (avg=${avg.toFixed(1)})` : '';
        console.log(`  [COMMON] "${pattern}" — ${best.usedBy.length}개 문서에서 사용${scoreInfo}`);
      } else {
        console.log(`  [SKIP-COMMON] "${pattern}" avg score ${avg.toFixed(1)} < ${QUALITY_GATE}`);
      }
    } else {
      // byDocType에 분류
      for (const variant of variants) {
        for (const docName of variant.usedBy) {
          if (!byDocType[docName]) {
            byDocType[docName] = {};
          }
          // common에 이미 있으면 byDocType에서는 생략
          if (!common[pattern]) {
            byDocType[docName][pattern] = variant.widths;
          }
        }
      }
    }
  }

  // 빈 byDocType 엔트리 제거
  for (const docName of Object.keys(byDocType)) {
    if (Object.keys(byDocType[docName]).length === 0) {
      delete byDocType[docName];
    }
  }

  // 다양성 메트릭 계산
  const diversity = calculateDiversity(patternMap);

  // 출처별 집계
  const originBreakdown = { human: 0, ai: 0, unknown: 0 };
  for (const origin of Object.values(originMap)) {
    originBreakdown[origin] = (originBreakdown[origin] || 0) + 1;
  }

  // _provenance: common 패턴별 상세
  const commonProvenance = {};
  for (const pattern of Object.keys(common)) {
    const variants = Object.values(patternMap[pattern] || {});
    const best = variants.sort((a, b) => b.usedBy.length - a.usedBy.length)[0];
    if (best) {
      const origins = countOrigins(best.usedBy, originMap);
      const avg = scoreMap ? avgScore(best.usedBy, scoreMap) : null;
      commonProvenance[pattern] = {
        usedBy: best.usedBy.length,
        origins,
        variantCount: Object.keys(patternMap[pattern]).length,
      };
      if (avg !== null) {
        commonProvenance[pattern].avgScore = parseFloat(avg.toFixed(1));
      }
    }
  }

  // _provenance 구축
  const provenance = {
    extractedAt: new Date().toISOString().slice(0, 10),
    totalDocConfigs: configFiles.length,
    originBreakdown,
    common: commonProvenance,
    diversity: {
      totalPatterns: diversity.totalPatterns,
      multiVariantPatterns: diversity.multiVariantPatterns,
      diversityRatio: parseFloat(diversity.diversityRatio.toFixed(3)),
      avgVariants: parseFloat(diversity.avgVariants.toFixed(2)),
    },
  };

  const patterns = {
    _generated: new Date().toISOString().slice(0, 10),
    _description: "doc-config에서 추출된 공유 패턴. node tools/extract-patterns.js 로 재생성.",
    _provenance: provenance,
    tableWidths: {
      common,
      byDocType,
    },
  };

  // 저장
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2), 'utf-8');

  // 통계
  const commonCount = Object.keys(common).length;
  const docTypeCount = Object.keys(byDocType).length;
  const totalPatterns = Object.keys(patternMap).length;

  console.log(`\n=== 결과 ===\n`);
  console.log(`  총 패턴: ${totalPatterns}개`);
  console.log(`  common (${COMMON_THRESHOLD}개+ 문서 공유): ${commonCount}개`);
  console.log(`  byDocType: ${docTypeCount}개 문서에 개별 패턴`);
  console.log(`\n  저장: ${PATTERNS_PATH}`);

  // --audit 모드: 다양성 감사 리포트 출력
  if (auditMode) {
    printAuditReport(patternMap, common, originMap, scoreMap, configFiles.length, diversity);
  }
}

main();

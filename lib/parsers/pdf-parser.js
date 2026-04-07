/**
 * lib/parsers/pdf-parser.js — PDF → SemanticIR 변환 (JS 래퍼)
 *
 * tools/extract-pdf-ir.py를 child_process로 호출하여 IR JSON을 받아 반환.
 *
 * 두 가지 모드:
 *   1) 기본: 휴리스틱으로 heading/표지/목차 자동 감지
 *   2) classify: Claude Code가 --meta-only 결과를 보고 결정한 분류를 전달
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');

/**
 * @param {string} pdfPath - PDF 파일 경로
 * @param {Object} [options]
 * @param {string} [options.imageDir] - 이미지 추출 디렉토리
 * @param {string} [options.baseDir] - 프로젝트 루트
 * @param {Object} [options.classify] - LLM 분류 결과 { levelMap, coverPages, tocPages }
 * @returns {{ content: ContentNode[], headings: {level,text}[], warnings: [] }}
 */
function parse(pdfPath, options = {}) {
  const baseDir = options.baseDir || path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(baseDir, 'tools', 'extract-pdf-ir.py');

  let cmd = `python "${scriptPath}" "${pdfPath}" --json`;
  if (options.classify) {
    const classifyJson = JSON.stringify(options.classify).replace(/"/g, '\\"');
    cmd += ` --classify "${classifyJson}"`;
  }
  if (options.imageDir) {
    cmd += ` --image-dir "${options.imageDir}"`;
  }

  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      cwd: baseDir,
      env: { ...process.env, PYTHONUTF8: '1' },
      maxBuffer: 50 * 1024 * 1024,
    });

    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      throw new Error('PDF 파서 출력에 JSON이 없습니다');
    }

    const result = JSON.parse(stdout.substring(jsonStart));
    return {
      meta: result.meta || {},
      content: result.content || [],
      headings: result.headings || [],
      warnings: result.warnings || [],
    };
  } catch (e) {
    if (e.message?.includes('PDF 파서')) throw e;
    const stderr = e.stderr?.toString() || e.message;
    throw new Error(`PDF 파싱 실패: ${stderr}`);
  }
}

/**
 * 메타데이터만 추출 (Claude Code가 읽고 분류 판단용)
 */
function extractMeta(pdfPath, options = {}) {
  const baseDir = options.baseDir || path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(baseDir, 'tools', 'extract-pdf-ir.py');

  const stdout = execSync(`python "${scriptPath}" "${pdfPath}" --meta-only`, {
    encoding: 'utf-8',
    cwd: baseDir,
    env: { ...process.env, PYTHONUTF8: '1' },
    maxBuffer: 10 * 1024 * 1024,
  });

  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new Error('메타데이터 출력에 JSON이 없습니다');
  return JSON.parse(stdout.substring(jsonStart));
}

module.exports = { parse, extractMeta };

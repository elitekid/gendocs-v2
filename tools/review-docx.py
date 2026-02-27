"""
DOCX AI 셀프리뷰 스크립트 — 컬럼 너비 불균형, 콘텐츠 정합성, 테이블 가독성, 코드 무결성, 이미지 비율, 페이지 분포, 제목 구조 검사.

사용법:
  python -X utf8 tools/review-docx.py output/문서.docx --json
  python -X utf8 tools/review-docx.py output/문서.docx --config doc-configs/문서.json --json
  python -X utf8 tools/review-docx.py output/문서.docx --config doc-configs/문서.json
"""

import sys
import os
import io
import re
import json
import zipfile
import xml.etree.ElementTree as ET

# 동적 테마 색상 로드
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from theme_colors import load_theme_color_sets
_THEME_COLORS = load_theme_color_sets()

# Windows 터미널 한글 출력 보장
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ============================================================
# XML 네임스페이스
# ============================================================
NS = {
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
}
W = NS['w']

# ============================================================
# 상수
# ============================================================
# 기본값 (Landscape A4) — detect_content_width()가 실제 값으로 갱신
TOTAL_TABLE_WIDTH_DXA = 12960
USABLE_HEIGHT_PT = 457

# Malgun Gothic 9pt 기준 글자 너비 추정 (DXA)
DXA_PER_HANGUL = 180     # 한글 1글자 ~180 DXA
DXA_PER_LATIN = 90       # 라틴/숫자 1글자 ~90 DXA
CELL_PADDING_DXA = 240   # 셀 좌우 패딩 합계 (left:120 + right:120)
BOLD_WIDTH_FACTOR = 1.15 # 볼드 텍스트 너비 보정 (헤더용)
EST_H2 = 42
EST_H3 = 34
EST_H4 = 28
EST_PARAGRAPH = 22
EST_BULLET = 20
EST_TABLE_HEADER = 28
EST_TABLE_ROW = 22
EST_CODE_ROW = 16
EST_INFO_BOX = 45
EST_IMAGE_SPACING = 30
EST_EMPTY = 8
EMU_TO_PT = 1 / 12700

# 임계값
WIDTH_IMBALANCE_UTIL_LOW = 0.50    # 인접 컬럼 활용률 50% 미만
WIDTH_IMBALANCE_LINES_MIN = 2      # 줄바꿈 2줄 이상
WIDE_WASTE_THRESHOLD = 0.30        # 전체 행에서 30% 미만 활용
CELL_OVERFLOW_LINES = 4            # 개별 셀 4줄 이상
EMPTY_COL_THRESHOLD = 0.80         # 80% 이상 행이 빈 컬럼
MAX_COLUMNS = 8                    # 가로 A4에서 읽기 어려운 컬럼 수
SPARSE_PAGE_PCT = 15.0             # 15% 미만 채움률
MIN_READABLE_WIDTH_DXA = 600       # 최소 가독 너비
MIN_IMAGE_WIDTH_PCT = 0.30         # 이미지 최소 폭 (콘텐츠 너비의 30% 미만 → WARN)
MIN_IMAGE_HEIGHT_PT = 80           # 이미지 최소 높이 80pt (약 28mm, 이하 → WARN)


# ============================================================
# XML 파싱 유틸리티 (validate-docx.py 재사용 패턴)
# ============================================================

def extract_text(element):
    """w:p 요소에서 텍스트 추출"""
    texts = []
    for t in element.iter(f'{{{W}}}t'):
        if t.text:
            texts.append(t.text)
    return ''.join(texts).strip()


def get_paragraph_style(p):
    """w:p 요소에서 스타일명 추출"""
    pPr = p.find(f'{{{W}}}pPr')
    if pPr is not None:
        pStyle = pPr.find(f'{{{W}}}pStyle')
        if pStyle is not None:
            return pStyle.get(f'{{{W}}}val', '')
    return ''


def has_page_break(p):
    for br in p.iter(f'{{{W}}}br'):
        if br.get(f'{{{W}}}type') == 'page':
            return True
    return False


def get_table_shading(tbl):
    """테이블 첫 번째 셀의 배경색"""
    for tc in tbl.iter(f'{{{W}}}tc'):
        tcPr = tc.find(f'{{{W}}}tcPr')
        if tcPr is not None:
            shd = tcPr.find(f'{{{W}}}shd')
            if shd is not None:
                return shd.get(f'{{{W}}}fill', '')
        break
    return ''


def classify_table(tbl):
    """테이블 유형: code_dark, code_light, info_box, warning_box, data_table"""
    bg = get_table_shading(tbl).upper()
    first_row = tbl.find(f'{{{W}}}tr')
    cols = len(first_row.findall(f'{{{W}}}tc')) if first_row is not None else 0

    # 다크 코드블록 (동적 테마 색상)
    if bg in _THEME_COLORS['dark_codes']:
        return 'code_dark'
    # 라이트 코드블록 / JSON
    if cols == 1 and bg in _THEME_COLORS['light_codes']:
        return 'code_light'
    # 정보 박스
    if cols == 1 and bg in _THEME_COLORS['info_boxes']:
        return 'info_box'
    # 경고 박스
    if cols == 1 and bg in _THEME_COLORS['warning_boxes']:
        return 'warning_box'
    return 'data_table'


def get_image_size_pt(p):
    for extent in p.iter(f'{{{NS["wp"]}}}extent'):
        cx = int(extent.get('cx', '0'))
        cy = int(extent.get('cy', '0'))
        if cx > 0 and cy > 0:
            return (cx * EMU_TO_PT, cy * EMU_TO_PT)
    return None


# ============================================================
# 페이지 크기 자동 감지
# ============================================================

def detect_content_width(docx_path):
    """DOCX pgSz에서 콘텐츠 너비(DXA)와 가용 높이(pt)를 계산"""
    try:
        with zipfile.ZipFile(docx_path, 'r') as z:
            tree = ET.parse(z.open('word/document.xml'))
            root = tree.getroot()
            body = root.find(f'{{{W}}}body')
            if body is None:
                return 12960, 457

            sect_pr = body.find(f'{{{W}}}sectPr')
            if sect_pr is None:
                return 12960, 457

            pg_sz = sect_pr.find(f'{{{W}}}pgSz')
            if pg_sz is None:
                return 12960, 457

            w = int(pg_sz.get(f'{{{W}}}w', '15840'))
            h = int(pg_sz.get(f'{{{W}}}h', '12240'))

            pg_mar = sect_pr.find(f'{{{W}}}pgMar')
            margin_left = 1440
            margin_right = 1440
            margin_top = 1080
            margin_bottom = 1080
            if pg_mar is not None:
                margin_left = int(pg_mar.get(f'{{{W}}}left', '1440'))
                margin_right = int(pg_mar.get(f'{{{W}}}right', '1440'))
                margin_top = int(pg_mar.get(f'{{{W}}}top', '1080'))
                margin_bottom = int(pg_mar.get(f'{{{W}}}bottom', '1080'))

            content_width = w - margin_left - margin_right
            page_height_pt = h / 20  # DXA → pt
            usable_height = page_height_pt - (margin_top / 20) - (margin_bottom / 20) - 30  # 30pt header/footer

            return content_width, round(usable_height)
    except Exception:
        return 12960, 457


# ============================================================
# 텍스트 너비 추정
# ============================================================

def estimate_text_width_dxa(text):
    """한글/라틴 혼합 텍스트의 렌더링 너비를 DXA로 추정 (보수적)"""
    if not text:
        return 0
    width = 0
    for ch in text:
        cp = ord(ch)
        # CJK (한글, 한자 등) — 넓은 글자
        if (0xAC00 <= cp <= 0xD7AF or   # 한글 음절
            0x3000 <= cp <= 0x9FFF or   # CJK
            0xF900 <= cp <= 0xFAFF):    # CJK 호환
            width += DXA_PER_HANGUL
        else:
            width += DXA_PER_LATIN
    return width


# ============================================================
# 1. 컬럼 너비 불균형 분석
# ============================================================

def analyze_table_widths(tbl, table_index, section_heading):
    """단일 데이터 테이블의 컬럼 너비 불균형 분석"""
    issues = []
    rows_xml = tbl.findall(f'{{{W}}}tr')
    if len(rows_xml) < 2:
        return None  # 헤더만 있는 테이블은 건너뜀

    # 컬럼 수 (첫 행 기준)
    first_row = rows_xml[0]
    header_cells = first_row.findall(f'{{{W}}}tc')
    num_cols = len(header_cells)
    if num_cols < 2:
        return None

    # 병합 셀 감지 — gridSpan이 있으면 건너뜀
    for tc in header_cells:
        tcPr = tc.find(f'{{{W}}}tcPr')
        if tcPr is not None:
            gs = tcPr.find(f'{{{W}}}gridSpan')
            if gs is not None:
                span = int(gs.get(f'{{{W}}}val', '1'))
                if span > 1:
                    return None  # 병합된 테이블은 분석 건너뜀

    # 컬럼별 실제 할당 너비 추출 (w:tcW)
    allocated = []
    for tc in header_cells:
        tcPr = tc.find(f'{{{W}}}tcPr')
        w_val = 0
        if tcPr is not None:
            tcW = tcPr.find(f'{{{W}}}tcW')
            if tcW is not None:
                try:
                    w_val = int(tcW.get(f'{{{W}}}w', '0'))
                except ValueError:
                    w_val = 0
        allocated.append(w_val)

    if not any(a > 0 for a in allocated):
        return None  # 너비 정보 없음

    # 헤더 텍스트 추출
    headers = []
    for tc in header_cells:
        cell_texts = []
        for p in tc.findall(f'{{{W}}}p'):
            t = extract_text(p)
            if t:
                cell_texts.append(t)
        headers.append(' '.join(cell_texts))

    # 각 셀의 텍스트 너비 추정 (모든 행)
    col_max_text_width = [0] * num_cols
    col_all_empty_count = [0] * num_cols
    data_row_count = len(rows_xml) - 1  # 헤더 제외

    for row_xml in rows_xml[1:]:  # 데이터 행만
        cells = row_xml.findall(f'{{{W}}}tc')
        for col_idx in range(min(len(cells), num_cols)):
            tc = cells[col_idx]
            # 병합 감지
            tcPr = tc.find(f'{{{W}}}tcPr')
            if tcPr is not None:
                gs = tcPr.find(f'{{{W}}}gridSpan')
                if gs is not None and int(gs.get(f'{{{W}}}val', '1')) > 1:
                    continue
            cell_text = []
            for p in tc.findall(f'{{{W}}}p'):
                t = extract_text(p)
                if t:
                    cell_text.append(t)
            full_text = ' '.join(cell_text)
            tw = estimate_text_width_dxa(full_text)
            if tw > col_max_text_width[col_idx]:
                col_max_text_width[col_idx] = tw
            if not full_text.strip():
                col_all_empty_count[col_idx] += 1

    # 컬럼별 메트릭 계산
    columns = []
    for i in range(num_cols):
        alloc = allocated[i] if allocated[i] > 0 else (TOTAL_TABLE_WIDTH_DXA // num_cols)
        usable = max(alloc - CELL_PADDING_DXA, 1)
        max_tw = col_max_text_width[i]
        utilization = max_tw / alloc if alloc > 0 else 0
        est_lines = max(1, max_tw / usable) if usable > 0 else 1
        empty_ratio = col_all_empty_count[i] / data_row_count if data_row_count > 0 else 0

        columns.append({
            'header': headers[i] if i < len(headers) else f'col{i}',
            'allocatedWidth': alloc,
            'maxTextWidth': max_tw,
            'utilization': round(utilization, 3),
            'estLines': round(est_lines, 1),
            'emptyRatio': round(empty_ratio, 2),
        })

    # 헤더 텍스트 오버플로우 감지 (헤더는 볼드 → 폭 보정)
    for i, col in enumerate(columns):
        header_text = col['header']
        header_width = int(estimate_text_width_dxa(header_text) * BOLD_WIDTH_FACTOR)
        usable = max(col['allocatedWidth'] - CELL_PADDING_DXA, 1)
        if header_width > usable:
            overflow = header_width - usable
            issues.append({
                'type': 'HEADER_OVERFLOW',
                'severity': 'SUGGEST',
                'message': f"헤더 '{header_text}' 텍스트({header_width} DXA)가 "
                           f"가용 너비({usable} DXA)를 {overflow} DXA 초과 — 줄바꿈 발생",
                'col': i,
                'headerWidth': header_width,
                'usable': usable,
                'minAlloc': header_width + CELL_PADDING_DXA,
            })

    # 불균형 감지
    for i, col in enumerate(columns):
        # WIDTH_IMBALANCE: 한 컬럼이 2줄 이상 AND 인접 컬럼이 50% 미만 활용
        if col['estLines'] >= WIDTH_IMBALANCE_LINES_MIN:
            for j in range(num_cols):
                if j != i and columns[j]['utilization'] < WIDTH_IMBALANCE_UTIL_LOW:
                    issues.append({
                        'type': 'WIDTH_IMBALANCE',
                        'severity': 'SUGGEST',
                        'message': f"'{col['header']}' 컬럼이 ~{col['estLines']:.0f}줄 줄바꿈, "
                                   f"'{columns[j]['header']}' 컬럼은 {columns[j]['utilization']*100:.0f}%만 사용",
                        'squeezedCol': i,
                        'wasteCol': j,
                    })
                    break  # 한 쌍만 보고

        # WIDE_WASTE: 컬럼이 30% 미만 활용
        if col['utilization'] < WIDE_WASTE_THRESHOLD and col['allocatedWidth'] > 1500:
            issues.append({
                'type': 'WIDE_WASTE',
                'severity': 'INFO',
                'message': f"'{col['header']}' 컬럼이 {col['utilization']*100:.0f}%만 사용 (할당: {col['allocatedWidth']} DXA)",
            })

        # CELL_OVERFLOW: 개별 셀 4줄 이상
        if col['estLines'] >= CELL_OVERFLOW_LINES:
            issues.append({
                'type': 'CELL_OVERFLOW',
                'severity': 'INFO',
                'message': f"'{col['header']}' 컬럼에 ~{col['estLines']:.0f}줄 셀 존재",
            })

        # EMPTY_COLUMN: 80% 이상 행이 비어있음
        if col['emptyRatio'] >= EMPTY_COL_THRESHOLD and data_row_count >= 3:
            issues.append({
                'type': 'EMPTY_COLUMN',
                'severity': 'INFO',
                'message': f"'{col['header']}' 컬럼의 {col['emptyRatio']*100:.0f}% 행이 비어있음",
            })

    # 너비 재분배 제안 (WIDTH_IMBALANCE 또는 HEADER_OVERFLOW가 있을 때)
    suggested_widths = None
    has_width_issue = any(iss['type'] in ('WIDTH_IMBALANCE', 'HEADER_OVERFLOW') for iss in issues)
    if has_width_issue:
        ideals = []
        for i, col in enumerate(columns):
            # 데이터 기반 ideal
            data_ideal = int(col['maxTextWidth'] * 1.2) + CELL_PADDING_DXA
            # 헤더 기반 최소 (볼드 보정)
            header_min = int(estimate_text_width_dxa(col['header']) * BOLD_WIDTH_FACTOR) + CELL_PADDING_DXA
            ideal = max(MIN_READABLE_WIDTH_DXA, data_ideal, header_min)
            ideals.append(ideal)
        total_ideal = sum(ideals)
        if total_ideal > 0:
            suggested_widths = [max(MIN_READABLE_WIDTH_DXA, round(ideal / total_ideal * TOTAL_TABLE_WIDTH_DXA))
                                for ideal in ideals]
            # 보정: 합계가 정확히 TOTAL_TABLE_WIDTH_DXA가 되도록
            diff = TOTAL_TABLE_WIDTH_DXA - sum(suggested_widths)
            if diff != 0 and suggested_widths:
                # 가장 넓은 컬럼에서 보정
                max_idx = suggested_widths.index(max(suggested_widths))
                suggested_widths[max_idx] += diff

            for iss in issues:
                if iss['type'] in ('WIDTH_IMBALANCE', 'HEADER_OVERFLOW'):
                    iss['suggestedWidths'] = suggested_widths

    if not issues and not columns:
        return None

    return {
        'index': table_index,
        'headers': headers,
        'section': section_heading,
        'rows': len(rows_xml),
        'cols': num_cols,
        'columns': columns,
        'issues': issues,
        'suggestedWidths': suggested_widths,
    }


# ============================================================
# 2. 콘텐츠 정합성 (소스 MD vs DOCX)
# ============================================================

def count_md_elements(md_path, header_clean_until=None):
    """마크다운 파일의 요소 수 카운트

    header_clean_until: converter가 제거하는 헤더 영역의 끝 (예: "## 변경 이력").
        지정 시 이 제목 이전의 모든 요소(H1, ## 목차, TOC 불릿 등)를 카운트에서 제외.
    """
    if not os.path.exists(md_path):
        return None

    with open(md_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    counts = {
        'h2': 0, 'h3': 0, 'h4': 0,
        'tables': 0, 'codeBlocks': 0,
        'images': 0, 'bullets': 0,
        'infoBoxes': 0, 'warningBoxes': 0,
    }

    in_code_block = False
    in_table = False
    prev_non_empty = ''  # 직전 비어있지 않은 줄 (다이어그램 주석 감지용)

    # headerCleanUntil 이전 영역 스킵 (converter가 제거하는 부분)
    in_header_area = bool(header_clean_until)

    for line in lines:
        stripped = line.strip()

        # headerCleanUntil 이전 영역 스킵
        if in_header_area:
            if header_clean_until and stripped == header_clean_until:
                in_header_area = False
                # 이 제목 자체는 카운트 (converter가 유지하는 영역)
                counts['h2'] += 1
            continue

        # 코드블록 토글
        if stripped.startswith('```'):
            if in_code_block:
                in_code_block = False
            else:
                in_code_block = True
                # 다이어그램 코드블록은 이미지로 변환되므로 이미지로 카운트
                if re.match(r'^<!--\s*diagram:', prev_non_empty):
                    counts['images'] += 1
                else:
                    counts['codeBlocks'] += 1
            continue

        if in_code_block:
            continue

        # 테이블 (| 로 시작하는 행)
        # 구분선 |---| 도 테이블의 일부이므로 연속성 유지
        if stripped.startswith('|'):
            if not in_table:
                # 구분선이 아닌 실제 데이터 행일 때만 새 테이블 시작
                if not re.match(r'^\|[\s\-:|]+\|$', stripped):
                    counts['tables'] += 1
                    in_table = True
            continue
        else:
            in_table = False

        # 제목
        if stripped.startswith('#### '):
            counts['h4'] += 1
        elif stripped.startswith('### '):
            counts['h3'] += 1
        elif stripped.startswith('## '):
            counts['h2'] += 1

        # 이미지
        if re.match(r'^!\[', stripped):
            counts['images'] += 1

        # 불릿
        if re.match(r'^[-*+]\s', stripped):
            counts['bullets'] += 1

        # 인포/경고 박스
        if stripped.startswith('> 참고:') or stripped.startswith('> 중요:'):
            counts['infoBoxes'] += 1
        elif stripped.startswith('> 주의:'):
            counts['warningBoxes'] += 1

        # 직전 비어있지 않은 줄 추적 (다이어그램 주석 감지용)
        if stripped:
            prev_non_empty = stripped

    return counts


def count_docx_elements(body):
    """DOCX body 요소에서 요소 수 카운트 (validate-docx.py 패턴)"""
    counts = {
        'h2': 0, 'h3': 0, 'h4': 0,
        'tables': 0, 'codeBlocks': 0,
        'images': 0, 'bullets': 0,
        'infoBoxes': 0, 'warningBoxes': 0,
    }

    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        if tag == 'p':
            style = get_paragraph_style(child)

            # 이미지
            if get_image_size_pt(child):
                counts['images'] += 1

            # 제목
            elif style.startswith('Heading'):
                level_str = style.replace('Heading', '')
                if level_str == '2':
                    counts['h2'] += 1
                elif level_str == '3':
                    counts['h3'] += 1
                elif level_str == '4':
                    counts['h4'] += 1

            # 불릿
            elif child.find(f'{{{W}}}pPr') is not None:
                pPr = child.find(f'{{{W}}}pPr')
                if pPr.find(f'{{{W}}}numPr') is not None:
                    counts['bullets'] += 1

        elif tag == 'tbl':
            tbl_type = classify_table(child)
            if tbl_type in ('code_dark', 'code_light'):
                counts['codeBlocks'] += 1
            elif tbl_type == 'info_box':
                counts['infoBoxes'] += 1
            elif tbl_type == 'warning_box':
                counts['warningBoxes'] += 1
            elif tbl_type == 'data_table':
                counts['tables'] += 1

    return counts


def compare_content(md_counts, docx_counts):
    """소스 vs DOCX 요소 수 비교"""
    comparison = {}
    issues = []

    keys = ['h2', 'h3', 'h4', 'tables', 'codeBlocks', 'images', 'bullets', 'infoBoxes', 'warningBoxes']
    labels = {
        'h2': 'H2 섹션', 'h3': 'H3 소제목', 'h4': 'H4 세부항목',
        'tables': '테이블', 'codeBlocks': '코드블록', 'images': '이미지',
        'bullets': '불릿', 'infoBoxes': '정보박스', 'warningBoxes': '경고박스',
    }

    for key in keys:
        src = md_counts.get(key, 0)
        docx = docx_counts.get(key, 0)
        match = src == docx
        comparison[key] = {'source': src, 'docx': docx, 'match': match}

        if docx < src:
            diff = src - docx
            issues.append({
                'type': 'CONTENT_MISSING',
                'severity': 'WARN',
                'message': f"{labels.get(key, key)}: 소스 {src}개 → DOCX {docx}개 ({diff}개 누락)",
                'element': key,
                'sourceCnt': src,
                'docxCnt': docx,
            })
        elif docx > src:
            diff = docx - src
            issues.append({
                'type': 'CONTENT_EXTRA',
                'severity': 'INFO',
                'message': f"{labels.get(key, key)}: 소스 {src}개 → DOCX {docx}개 ({diff}개 추가)",
                'element': key,
                'sourceCnt': src,
                'docxCnt': docx,
            })

    return comparison, issues


# ============================================================
# 3. 코드블록 무결성
# ============================================================

def check_code_integrity(body):
    """코드블록(다크/라이트 테이블)의 무결성 검사"""
    issues = []
    code_index = 0

    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if tag != 'tbl':
            continue

        tbl_type = classify_table(child)
        if tbl_type not in ('code_dark', 'code_light'):
            continue

        code_index += 1
        # 코드블록 텍스트 추출
        code_text = []
        for tr in child.findall(f'{{{W}}}tr'):
            for tc in tr.findall(f'{{{W}}}tc'):
                for p in tc.findall(f'{{{W}}}p'):
                    t = extract_text(p)
                    if t:
                        code_text.append(t)

        full_code = '\n'.join(code_text).strip()

        # 빈 코드블록
        if not full_code:
            issues.append({
                'type': 'EMPTY_CODE',
                'severity': 'WARN',
                'message': f"코드블록 #{code_index}이 비어있음",
                'codeIndex': code_index,
            })
            continue

        # JSON 무결성 — { 로 시작하면 } 로 끝나야
        # 다이어그램/ASCII art 등 비-JSON 텍스트 제외: " 또는 : 포함 여부로 판별
        trimmed = full_code.strip()
        looks_like_json = ('"' in trimmed or ':' in trimmed) and '│' not in trimmed and '─' not in trimmed
        if looks_like_json:
            if trimmed.startswith('{') and not trimmed.endswith('}'):
                issues.append({
                    'type': 'TRUNCATED_JSON',
                    'severity': 'WARN',
                    'message': f"코드블록 #{code_index}: JSON이 '}}' 로 끝나지 않음 (잘린 가능성)",
                    'codeIndex': code_index,
                    'preview': trimmed[-60:],
                })
            elif trimmed.startswith('[') and not trimmed.endswith(']'):
                issues.append({
                    'type': 'TRUNCATED_JSON',
                    'severity': 'WARN',
                    'message': f"코드블록 #{code_index}: JSON 배열이 ']' 로 끝나지 않음 (잘린 가능성)",
                    'codeIndex': code_index,
                    'preview': trimmed[-60:],
                })

    return issues


# ============================================================
# 4. 제목 구조
# ============================================================

def check_heading_structure(elements):
    """제목 구조 이상 감지"""
    issues = []
    headings = [e for e in elements if e['type'] == 'heading']

    # 동일 텍스트 연속 제목
    for i in range(1, len(headings)):
        if headings[i]['text'] == headings[i-1]['text'] and headings[i]['level'] == headings[i-1]['level']:
            issues.append({
                'type': 'DUPLICATE_HEADING',
                'severity': 'WARN',
                'message': f"연속 동일 제목: H{headings[i]['level']} \"{headings[i]['text'][:40]}\"",
            })

    # 긴 H2 섹션 (H3 없이 2페이지 분량 초과)
    for i, h in enumerate(headings):
        if h['level'] != 2:
            continue
        # 이 H2와 다음 H2 사이에 H3가 있는지, 그리고 콘텐츠 양
        next_h2_idx = None
        has_h3 = False
        content_height = 0
        for j in range(i + 1, len(headings)):
            if headings[j]['level'] == 2:
                next_h2_idx = j
                break
            if headings[j]['level'] == 3:
                has_h3 = True

        if not has_h3:
            # 이 H2 섹션의 추정 높이 계산
            start_idx = h.get('elem_index', 0)
            end_idx = headings[next_h2_idx].get('elem_index', len(elements)) if next_h2_idx else len(elements)
            section_height = sum(
                e.get('est_height', 0) for e in elements[start_idx:end_idx]
            )
            if section_height > USABLE_HEIGHT_PT * 2:
                issues.append({
                    'type': 'LONG_SECTION_NO_SUBDIVISION',
                    'severity': 'INFO',
                    'message': f"H2 \"{h['text'][:40]}\" 아래 H3 없이 ~{section_height:.0f}pt (약 {section_height/USABLE_HEIGHT_PT:.1f}페이지)",
                })

    return issues


# ============================================================
# 5. 페이지 분포 (validate-docx.py 데이터 활용)
# ============================================================

def check_page_distribution(elements):
    """페이지 분포 분석 — 희소 페이지 감지"""
    # 간단한 페이지 시뮬레이션
    pages = []
    current_height = 0.0

    for elem in elements:
        est_h = elem.get('est_height', 0)
        if elem['type'] == 'page_break':
            pages.append(current_height)
            current_height = 0.0
            continue
        if current_height + est_h > USABLE_HEIGHT_PT and current_height > 0:
            pages.append(current_height)
            current_height = 0.0
        current_height += est_h

    if current_height > 0:
        pages.append(current_height)

    issues = []
    consecutive_sparse = 0

    for i, height in enumerate(pages):
        fill_pct = (height / USABLE_HEIGHT_PT) * 100 if USABLE_HEIGHT_PT > 0 else 0
        if fill_pct < SPARSE_PAGE_PCT:
            issues.append({
                'type': 'SPARSE_PAGE',
                'severity': 'INFO',
                'message': f"페이지 {i+1}: {fill_pct:.1f}% 채움률 (희소)",
                'page': i + 1,
                'fillPct': round(fill_pct, 1),
            })
            consecutive_sparse += 1
            if consecutive_sparse >= 2:
                issues.append({
                    'type': 'CONSECUTIVE_SPARSE',
                    'severity': 'INFO',
                    'message': f"페이지 {i}~{i+1}: 연속 희소 페이지",
                })
        else:
            consecutive_sparse = 0

    return issues


# ============================================================
# 6. 테이블 가독성 (컬럼 수)
# ============================================================

def check_table_readability(table_analyses):
    """테이블 가독성 이슈 (컬럼 수 초과)"""
    issues = []
    for ta in table_analyses:
        if ta['cols'] >= MAX_COLUMNS:
            issues.append({
                'type': 'TOO_MANY_COLUMNS',
                'severity': 'INFO',
                'message': f"테이블 #{ta['index']} ({ta['section'][:30]}): {ta['cols']}개 컬럼 — 가로 A4에서도 좁을 수 있음",
                'tableIndex': ta['index'],
                'headers': ta['headers'],
            })
    return issues


def check_image_aspect_ratio(body):
    """이미지 비율 이슈 — 다이어그램이 너무 좁게 렌더링된 경우 감지"""
    issues = []
    current_heading = '(문서 시작)'
    content_width_pt = TOTAL_TABLE_WIDTH_DXA / 20  # DXA → pt
    min_width_pt = content_width_pt * MIN_IMAGE_WIDTH_PCT
    img_index = 0

    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        if tag == 'p':
            style = get_paragraph_style(child)
            if style.startswith('Heading'):
                text = extract_text(child)
                if text:
                    current_heading = text

            img_size = get_image_size_pt(child)
            if img_size:
                img_index += 1
                w_pt, h_pt = img_size
                ratio = w_pt / h_pt if h_pt > 0 else 1.0

                if w_pt < min_width_pt:
                    pct = w_pt / content_width_pt * 100
                    issues.append({
                        'type': 'NARROW_IMAGE',
                        'severity': 'WARN',
                        'message': f'이미지 #{img_index} ({current_heading[:30]}): '
                                   f'폭 {w_pt:.0f}pt — 페이지 너비의 {pct:.0f}%로 가독성 부족 '
                                   f'(비율 {ratio:.2f})',
                        'imageIndex': img_index,
                        'section': current_heading,
                        'width_pt': round(w_pt, 1),
                        'height_pt': round(h_pt, 1),
                        'aspectRatio': round(ratio, 2),
                        'action': '다이어그램 방향 변경 (flowchart TD→LR) '
                                  '또는 노드 그룹핑으로 가로 비율 확보',
                    })
                elif h_pt < MIN_IMAGE_HEIGHT_PT:
                    issues.append({
                        'type': 'FLAT_IMAGE',
                        'severity': 'WARN',
                        'message': f'이미지 #{img_index} ({current_heading[:30]}): '
                                   f'높이 {h_pt:.0f}pt — 최소 {MIN_IMAGE_HEIGHT_PT}pt 미만으로 '
                                   f'가독성 부족 (비율 {ratio:.2f})',
                        'imageIndex': img_index,
                        'section': current_heading,
                        'width_pt': round(w_pt, 1),
                        'height_pt': round(h_pt, 1),
                        'aspectRatio': round(ratio, 2),
                        'action': '노드를 복수 행으로 그룹핑 (composite state, subgraph) '
                                  '하여 높이 확보. 단순 LR 전환만으로는 해결 불가',
                    })

    return issues


# ============================================================
# 메인 분석 파이프라인
# ============================================================

def analyze_docx(docx_path, config_path=None):
    """DOCX 전체 분석 → 구조화된 결과"""
    global TOTAL_TABLE_WIDTH_DXA, USABLE_HEIGHT_PT
    if not os.path.exists(docx_path):
        print(f"[ERROR] 파일을 찾을 수 없습니다: {docx_path}", file=sys.stderr)
        sys.exit(1)

    # 페이지 크기 자동 감지
    TOTAL_TABLE_WIDTH_DXA, USABLE_HEIGHT_PT = detect_content_width(docx_path)

    result = {
        'file': os.path.basename(docx_path),
        'checks': {},
        'summary': {'WARN': 0, 'SUGGEST': 0, 'INFO': 0},
    }

    # doc-config에서 소스 MD 경로 + headerCleanUntil 읽기
    config = None
    md_path = None
    header_clean_until = None
    if config_path and os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        if 'source' in config:
            md_path = config['source']
        header_clean_until = config.get('headerCleanUntil')

    with zipfile.ZipFile(docx_path, 'r') as z:
        tree = ET.parse(z.open('word/document.xml'))
        root = tree.getroot()
        body = root.find(f'{{{W}}}body')
        if body is None:
            result['checks']['error'] = 'body 요소를 찾을 수 없음'
            return result

        # === 요소 흐름 파싱 (페이지 분포 + 제목 구조에 사용) ===
        elements = []
        last_heading_text = '(문서 시작)'
        elem_idx = 0
        data_table_index = 0

        for child in body:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

            if tag == 'p':
                style = get_paragraph_style(child)
                text = extract_text(child)

                if has_page_break(child):
                    elements.append({'type': 'page_break', 'est_height': 0, 'elem_index': elem_idx})

                img_size = get_image_size_pt(child)
                if img_size:
                    elements.append({
                        'type': 'image', 'est_height': img_size[1] + EST_IMAGE_SPACING,
                        'elem_index': elem_idx,
                    })
                elif style.startswith('Heading'):
                    level_str = style.replace('Heading', '')
                    level = int(level_str) if level_str.isdigit() else 0
                    est_h = {2: EST_H2, 3: EST_H3, 4: EST_H4}.get(level, EST_PARAGRAPH)
                    elements.append({
                        'type': 'heading', 'level': level, 'text': text,
                        'est_height': est_h, 'elem_index': elem_idx,
                    })
                    last_heading_text = text
                elif child.find(f'{{{W}}}pPr') is not None and \
                     child.find(f'{{{W}}}pPr').find(f'{{{W}}}numPr') is not None:
                    elements.append({'type': 'bullet', 'est_height': EST_BULLET, 'elem_index': elem_idx})
                elif not text:
                    elements.append({'type': 'empty', 'est_height': EST_EMPTY, 'elem_index': elem_idx})
                else:
                    line_count = max(1, len(text) / 80) if text else 1
                    elements.append({
                        'type': 'paragraph', 'est_height': round(EST_PARAGRAPH * line_count, 1),
                        'elem_index': elem_idx,
                    })
                elem_idx += 1

            elif tag == 'tbl':
                tbl_type = classify_table(child)
                rows_count = len(child.findall(f'{{{W}}}tr'))

                if tbl_type in ('code_dark', 'code_light'):
                    est_h = rows_count * EST_CODE_ROW + 20
                elif tbl_type == 'info_box':
                    est_h = EST_INFO_BOX
                elif tbl_type == 'warning_box':
                    est_h = EST_INFO_BOX
                else:
                    est_h = EST_TABLE_HEADER + max(0, rows_count - 1) * EST_TABLE_ROW

                elements.append({
                    'type': 'table', 'tbl_type': tbl_type, 'est_height': est_h,
                    'elem_index': elem_idx,
                })
                elem_idx += 1

        # === 1. 컬럼 너비 분석 ===
        table_analyses = []
        data_table_index = 0
        current_heading = '(문서 시작)'

        for child in body:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 'p':
                style = get_paragraph_style(child)
                if style.startswith('Heading'):
                    text = extract_text(child)
                    if text:
                        current_heading = text
            elif tag == 'tbl':
                tbl_type = classify_table(child)
                if tbl_type == 'data_table':
                    data_table_index += 1
                    analysis = analyze_table_widths(child, data_table_index, current_heading)
                    if analysis:
                        table_analyses.append(analysis)

        # tableWidths 결과 취합
        tw_status = 'OK'
        tw_issues_all = []
        for ta in table_analyses:
            tw_issues_all.extend(ta['issues'])
        if any(iss['type'] == 'WIDTH_IMBALANCE' for iss in tw_issues_all):
            tw_status = 'SUGGEST'

        result['checks']['tableWidths'] = {
            'status': tw_status,
            'tables': [{
                'index': ta['index'],
                'headers': ta['headers'],
                'section': ta['section'],
                'rows': ta['rows'],
                'cols': ta['cols'],
                'columns': ta['columns'],
                'issues': ta['issues'],
                'suggestedWidths': ta.get('suggestedWidths'),
            } for ta in table_analyses if ta['issues']],
            'analyzedCount': len(table_analyses),
        }

        # === 2. 콘텐츠 정합성 ===
        if md_path and os.path.exists(md_path):
            md_counts = count_md_elements(md_path, header_clean_until=header_clean_until)
            docx_counts = count_docx_elements(body)
            if md_counts:
                comparison, content_issues = compare_content(md_counts, docx_counts)
                cf_status = 'WARN' if any(i['severity'] == 'WARN' for i in content_issues) else 'OK'
                result['checks']['contentFidelity'] = {
                    'status': cf_status,
                    'sourcePath': md_path,
                    'comparison': comparison,
                    'issues': content_issues,
                }
        else:
            result['checks']['contentFidelity'] = {
                'status': 'SKIP',
                'message': '--config 없음 또는 소스 파일 없음',
            }

        # === 3. 테이블 가독성 ===
        readability_issues = check_table_readability(table_analyses)
        result['checks']['tableReadability'] = {
            'status': 'INFO' if readability_issues else 'OK',
            'issues': readability_issues,
        }

        # === 4. 코드블록 무결성 ===
        code_issues = check_code_integrity(body)
        result['checks']['codeIntegrity'] = {
            'status': 'WARN' if any(i['severity'] == 'WARN' for i in code_issues) else 'OK',
            'issues': code_issues,
        }

        # === 5. 페이지 분포 ===
        page_issues = check_page_distribution(elements)
        result['checks']['pageDistribution'] = {
            'status': 'INFO' if page_issues else 'OK',
            'issues': page_issues,
        }

        # === 6. 제목 구조 ===
        heading_issues = check_heading_structure(elements)
        result['checks']['headingStructure'] = {
            'status': 'WARN' if any(i['severity'] == 'WARN' for i in heading_issues) else (
                'INFO' if heading_issues else 'OK'),
            'issues': heading_issues,
        }

        # === 7. 이미지 비율 ===
        image_issues = check_image_aspect_ratio(body)
        result['checks']['imageAspectRatio'] = {
            'status': 'WARN' if image_issues else 'OK',
            'issues': image_issues,
        }

    # === 전체 요약 ===
    for check_name, check_data in result['checks'].items():
        if isinstance(check_data, dict) and 'issues' in check_data:
            for iss in check_data['issues']:
                sev = iss.get('severity', 'INFO')
                if sev in result['summary']:
                    result['summary'][sev] += 1

    return result


# ============================================================
# 텍스트 리포트 출력
# ============================================================

def print_report(result):
    sep = '─' * 60
    print()
    print('=' * 60)
    print('  DOCX AI 셀프리뷰 리포트')
    print('=' * 60)
    print(f'  파일: {result["file"]}')

    checks = result['checks']

    # 콘텐츠 정합성
    cf = checks.get('contentFidelity', {})
    print(f'\n{sep}')
    print(f'  콘텐츠 정합성 [{cf.get("status", "?")}]')
    print(f'{sep}')
    if cf.get('status') == 'SKIP':
        print(f'  {cf.get("message", "")}')
    elif 'comparison' in cf:
        for key, val in cf['comparison'].items():
            mark = 'O' if val['match'] else 'X'
            print(f'  [{mark}] {key}: 소스 {val["source"]} → DOCX {val["docx"]}')
        for iss in cf.get('issues', []):
            print(f'  [{iss["severity"]}] {iss["message"]}')

    # 컬럼 너비
    tw = checks.get('tableWidths', {})
    print(f'\n{sep}')
    print(f'  컬럼 너비 분석 [{tw.get("status", "?")}] — {tw.get("analyzedCount", 0)}개 테이블 분석')
    print(f'{sep}')
    for tbl in tw.get('tables', []):
        print(f'  테이블 #{tbl["index"]} ({tbl["section"][:40]})')
        print(f'    헤더: {" | ".join(tbl["headers"])}')
        for col in tbl.get('columns', []):
            print(f'    - {col["header"]}: 할당 {col["allocatedWidth"]} DXA, '
                  f'활용 {col["utilization"]*100:.0f}%, ~{col["estLines"]:.1f}줄')
        for iss in tbl.get('issues', []):
            print(f'    [{iss["severity"]}] {iss["message"]}')
        if tbl.get('suggestedWidths'):
            print(f'    제안 너비: {tbl["suggestedWidths"]}')

    # 테이블 가독성
    tr = checks.get('tableReadability', {})
    if tr.get('issues'):
        print(f'\n{sep}')
        print(f'  테이블 가독성 [{tr.get("status", "?")}]')
        print(f'{sep}')
        for iss in tr['issues']:
            print(f'  [{iss["severity"]}] {iss["message"]}')

    # 코드 무결성
    ci = checks.get('codeIntegrity', {})
    if ci.get('issues'):
        print(f'\n{sep}')
        print(f'  코드블록 무결성 [{ci.get("status", "?")}]')
        print(f'{sep}')
        for iss in ci['issues']:
            print(f'  [{iss["severity"]}] {iss["message"]}')

    # 이미지 비율
    ia = checks.get('imageAspectRatio', {})
    if ia.get('issues'):
        print(f'\n{sep}')
        print(f'  이미지 비율 [{ia.get("status", "?")}]')
        print(f'{sep}')
        for iss in ia['issues']:
            print(f'  [{iss["severity"]}] {iss["message"]}')
            print(f'    → {iss["action"]}')

    # 페이지 분포
    pd = checks.get('pageDistribution', {})
    if pd.get('issues'):
        print(f'\n{sep}')
        print(f'  페이지 분포 [{pd.get("status", "?")}]')
        print(f'{sep}')
        for iss in pd['issues']:
            print(f'  [{iss["severity"]}] {iss["message"]}')

    # 제목 구조
    hs = checks.get('headingStructure', {})
    if hs.get('issues'):
        print(f'\n{sep}')
        print(f'  제목 구조 [{hs.get("status", "?")}]')
        print(f'{sep}')
        for iss in hs['issues']:
            print(f'  [{iss["severity"]}] {iss["message"]}')

    # 요약
    summary = result['summary']
    print(f'\n{sep}')
    total = sum(summary.values())
    print(f'  요약: {total}건 (WARN: {summary["WARN"]}, SUGGEST: {summary["SUGGEST"]}, INFO: {summary["INFO"]})')
    print('=' * 60)
    print()


# ============================================================
# 메인
# ============================================================

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('사용법: python -X utf8 tools/review-docx.py <파일.docx> [--config <config.json>] [--json]')
        print('예시:   python -X utf8 tools/review-docx.py output/문서.docx --config doc-configs/문서.json --json')
        sys.exit(1)

    docx_path = sys.argv[1]
    json_mode = '--json' in sys.argv

    config_path = None
    if '--config' in sys.argv:
        idx = sys.argv.index('--config')
        if idx + 1 < len(sys.argv):
            config_path = sys.argv[idx + 1]

    result = analyze_docx(docx_path, config_path)

    if json_mode:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_report(result)

"""
DOCX 구조 검증 + 레이아웃 분석 스크립트
생성된 DOCX를 ZIP 해체 → XML 파싱 → 구조 리포트 + 페이지 레이아웃 시뮬레이션

사용법: python -X utf8 tools/validate-docx.py output/문서.docx
        python -X utf8 tools/validate-docx.py output/문서.docx --json
"""

import sys
import os
import io
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
    'pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    'cp': 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'dcterms': 'http://purl.org/dc/terms/',
    'ap': 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
}

# ============================================================
# 레이아웃 상수 (단위: pt)
# ============================================================
MARGIN_TOP_PT = 54            # 상단 여백 (~19mm)
MARGIN_BOTTOM_PT = 54         # 하단 여백
HEADER_FOOTER_PT = 30         # 머릿글/바닥글 예약 공간

# 기본값 (Landscape A4) — detect_orientation()이 실제 값으로 갱신
USABLE_HEIGHT_PT = 457        # landscape 기본
CHARS_PER_LINE = 100          # landscape 기본

# 요소별 추정 높이 (pt)
EST_H2 = 42        # H2 제목 (18pt 폰트 + before/after spacing)
EST_H3 = 34        # H3 제목
EST_H4 = 28        # H4 제목
EST_PARAGRAPH = 22  # 일반 단락
EST_BULLET = 20     # 불릿 항목
EST_EMPTY = 8       # 빈 단락 / spacer
EST_TABLE_HEADER = 28   # 테이블 헤더 행
EST_TABLE_ROW = 22      # 테이블 데이터 행
EST_CODE_ROW = 16       # 코드 블록 행
EST_INFO_BOX = 45       # 정보/경고 박스
EST_IMAGE_SPACING = 30  # 이미지 전후 spacing
EMU_TO_PT = 1 / 12700   # EMU → pt 변환
DXA_TO_PT = 1 / 20      # DXA → pt 변환


def detect_orientation(docx_path):
    """DOCX의 w:pgSz에서 페이지 크기를 읽어 orientation과 가용 높이를 계산"""
    try:
        with zipfile.ZipFile(docx_path, 'r') as z:
            tree = ET.parse(z.open('word/document.xml'))
            root = tree.getroot()
            body = root.find(f'{{{NS["w"]}}}body')
            if body is None:
                return 'landscape', 457, 100

            # sectPr은 body의 마지막 자식이거나 body 안에 있음
            sect_pr = body.find(f'{{{NS["w"]}}}sectPr')
            if sect_pr is None:
                return 'landscape', 457, 100

            pg_sz = sect_pr.find(f'{{{NS["w"]}}}pgSz')
            if pg_sz is None:
                return 'landscape', 457, 100

            w = int(pg_sz.get(f'{{{NS["w"]}}}w', '15840'))
            h = int(pg_sz.get(f'{{{NS["w"]}}}h', '12240'))

            # margin 읽기
            pg_mar = sect_pr.find(f'{{{NS["w"]}}}pgMar')
            margin_top = 1080  # 기본값
            margin_bottom = 1080
            if pg_mar is not None:
                margin_top = int(pg_mar.get(f'{{{NS["w"]}}}top', '1080'))
                margin_bottom = int(pg_mar.get(f'{{{NS["w"]}}}bottom', '1080'))

            # orientation 판정: w > h → landscape
            orientation = 'portrait' if w <= h else 'landscape'

            # 가용 높이 계산 (DXA → pt)
            page_height_pt = h * DXA_TO_PT
            margin_top_pt = margin_top * DXA_TO_PT
            margin_bottom_pt = margin_bottom * DXA_TO_PT
            usable = page_height_pt - margin_top_pt - margin_bottom_pt - HEADER_FOOTER_PT

            # 글자 수/줄 추정 (콘텐츠 너비 기준)
            content_width_dxa = w - 1440 - 1440  # 좌우 여백 각 1440 DXA
            chars_per_line = max(40, int(content_width_dxa / 130))  # 약 130 DXA/글자

            return orientation, round(usable), chars_per_line
    except Exception:
        return 'landscape', 457, 100


# ============================================================
# XML 파싱 유틸리티
# ============================================================

def extract_text(element):
    """w:p 요소에서 텍스트 추출"""
    texts = []
    for t in element.iter(f'{{{NS["w"]}}}t'):
        if t.text:
            texts.append(t.text)
    return ''.join(texts).strip()


def get_paragraph_style(p):
    """w:p 요소에서 스타일명 추출"""
    pPr = p.find(f'{{{NS["w"]}}}pPr')
    if pPr is not None:
        pStyle = pPr.find(f'{{{NS["w"]}}}pStyle')
        if pStyle is not None:
            return pStyle.get(f'{{{NS["w"]}}}val', '')
    return ''


def has_page_break_explicit(p):
    """명시적 페이지 나누기 (스크립트가 넣은 것)만 감지"""
    for br in p.iter(f'{{{NS["w"]}}}br'):
        if br.get(f'{{{NS["w"]}}}type') == 'page':
            return True
    return False


def get_table_shading(tbl):
    """테이블 첫 번째 셀의 배경색"""
    for tc in tbl.iter(f'{{{NS["w"]}}}tc'):
        tcPr = tc.find(f'{{{NS["w"]}}}tcPr')
        if tcPr is not None:
            shd = tcPr.find(f'{{{NS["w"]}}}shd')
            if shd is not None:
                return shd.get(f'{{{NS["w"]}}}fill', '')
        break
    return ''


def count_table_rows(tbl):
    return len(tbl.findall(f'{{{NS["w"]}}}tr'))


def count_table_cols(tbl):
    first_row = tbl.find(f'{{{NS["w"]}}}tr')
    if first_row is not None:
        return len(first_row.findall(f'{{{NS["w"]}}}tc'))
    return 0


def get_table_header_text(tbl):
    first_row = tbl.find(f'{{{NS["w"]}}}tr')
    if first_row is not None:
        cells = []
        for tc in first_row.findall(f'{{{NS["w"]}}}tc'):
            cell_text = []
            for p in tc.findall(f'{{{NS["w"]}}}p'):
                cell_text.append(extract_text(p))
            cells.append('|'.join(cell_text))
        return cells
    return []


def classify_table(tbl):
    bg = get_table_shading(tbl)
    rows = count_table_rows(tbl)
    cols = count_table_cols(tbl)
    bg_upper = bg.upper() if bg else ''
    # 다크 코드블록 (동적 테마 색상)
    if bg_upper and bg_upper in _THEME_COLORS['dark_codes']:
        return 'code_dark'
    # 라이트 코드블록 / JSON
    if cols == 1 and bg_upper and bg_upper in _THEME_COLORS['light_codes']:
        return 'code_light'
    # 정보 박스
    if cols == 1 and bg_upper and bg_upper in _THEME_COLORS['info_boxes']:
        return 'info_box'
    # 경고 박스
    if cols == 1 and bg_upper and bg_upper in _THEME_COLORS['warning_boxes']:
        return 'warning_box'
    if cols == 2 and rows <= 5:
        headers = get_table_header_text(tbl)
        if any('버전' in h or '수정일' in h for h in headers):
            return 'cover_meta'
    # 데이터 테이블 헤더 (동적 테마 색상)
    if bg_upper and bg_upper in _THEME_COLORS['header_bgs']:
        return 'data_table'
    return 'data_table'


def get_image_size_pt(p):
    """단락에서 이미지 크기(pt) 추출. 없으면 None"""
    for extent in p.iter(f'{{{NS["wp"]}}}extent'):
        cx = int(extent.get('cx', '0'))
        cy = int(extent.get('cy', '0'))
        if cx > 0 and cy > 0:
            return (cx * EMU_TO_PT, cy * EMU_TO_PT)
    return None


# ============================================================
# 문서 분석 (요소 흐름 + 구조 정보)
# ============================================================

def analyze_document(docx_path):
    """DOCX 문서 분석 → 요소 흐름 리스트 + 메타 정보"""
    global USABLE_HEIGHT_PT, CHARS_PER_LINE
    if not os.path.exists(docx_path):
        print(f"[ERROR] 파일을 찾을 수 없습니다: {docx_path}")
        sys.exit(1)

    # 페이지 크기 자동 감지
    orientation, usable_h, chars_line = detect_orientation(docx_path)
    USABLE_HEIGHT_PT = usable_h
    CHARS_PER_LINE = chars_line

    report = {
        'file': os.path.basename(docx_path),
        'file_size': os.path.getsize(docx_path),
        'elements': [],       # 순서대로 모든 요소
        'headings': [],
        'page_breaks': [],
        'tables': [],
        'image_details': [],   # 이미지 상세 정보
        'images': 0,
        'paragraphs': 0,
        'empty_paragraphs': 0,
        'bullets': 0,
        'has_header': False,
        'has_footer': False,
        'header_text': '',
        'footer_text': '',
        'core_props': {},
        'issues': [],
    }

    with zipfile.ZipFile(docx_path, 'r') as z:
        file_list = z.namelist()

        # ── 헤더/푸터 확인 ──
        for name in file_list:
            if 'header' in name and name.endswith('.xml'):
                report['has_header'] = True
                tree = ET.parse(z.open(name))
                root = tree.getroot()
                texts = [t.text.strip() for t in root.iter(f'{{{NS["w"]}}}t') if t.text]
                report['header_text'] = ' '.join(texts)
            if 'footer' in name and name.endswith('.xml'):
                report['has_footer'] = True
                tree = ET.parse(z.open(name))
                root = tree.getroot()
                texts = [t.text.strip() for t in root.iter(f'{{{NS["w"]}}}t') if t.text]
                report['footer_text'] = ' '.join(texts)

        # ── core.xml (메타데이터) ──
        if 'docProps/core.xml' in file_list:
            tree = ET.parse(z.open('docProps/core.xml'))
            root = tree.getroot()
            title = root.find(f'{{{NS["dc"]}}}title')
            creator = root.find(f'{{{NS["dc"]}}}creator')
            if title is not None and title.text:
                report['core_props']['title'] = title.text
            if creator is not None and creator.text:
                report['core_props']['creator'] = creator.text

        # ── document.xml (본문) ──
        tree = ET.parse(z.open('word/document.xml'))
        root = tree.getroot()
        body = root.find(f'{{{NS["w"]}}}body')
        if body is None:
            report['issues'].append('body 요소를 찾을 수 없음')
            return report

        idx = 0
        last_heading = None
        last_heading_text = None

        for child in body:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

            if tag == 'p':
                report['paragraphs'] += 1
                style = get_paragraph_style(child)
                text = extract_text(child)

                # 페이지 나누기
                if has_page_break_explicit(child):
                    elem = {'type': 'page_break', 'index': idx, 'after': last_heading or '(문서 시작)', 'est_height': 0}
                    report['elements'].append(elem)
                    report['page_breaks'].append(elem)

                # 이미지
                img_size = get_image_size_pt(child)
                if img_size:
                    report['images'] += 1
                    img_h = img_size[1] + EST_IMAGE_SPACING
                    elem = {
                        'type': 'image', 'index': idx,
                        'width_pt': round(img_size[0], 1),
                        'height_pt': round(img_size[1], 1),
                        'est_height': round(img_h, 1),
                        'section': last_heading_text or '(문서 시작)',
                    }
                    report['elements'].append(elem)
                    report['image_details'].append(elem)

                # 제목
                elif style.startswith('Heading'):
                    level_str = style.replace('Heading', '')
                    level = int(level_str) if level_str.isdigit() else 0
                    est_h = {2: EST_H2, 3: EST_H3, 4: EST_H4}.get(level, EST_PARAGRAPH)
                    elem = {'type': 'heading', 'level': level, 'text': text, 'index': idx, 'est_height': est_h}
                    report['elements'].append(elem)
                    report['headings'].append(elem)
                    last_heading = f'H{level}: {text}'
                    last_heading_text = text

                # 불릿
                elif child.find(f'{{{NS["w"]}}}pPr') is not None and \
                     child.find(f'{{{NS["w"]}}}pPr').find(f'{{{NS["w"]}}}numPr') is not None:
                    report['bullets'] += 1
                    elem = {'type': 'bullet', 'text': text[:30], 'index': idx, 'est_height': EST_BULLET}
                    report['elements'].append(elem)

                # 빈 단락
                elif not text and not has_page_break_explicit(child):
                    report['empty_paragraphs'] += 1
                    elem = {'type': 'empty', 'index': idx, 'est_height': EST_EMPTY}
                    report['elements'].append(elem)

                # 일반 텍스트
                else:
                    # 긴 텍스트는 줄바꿈 추정 (글자수/줄은 orientation에 따라 다름)
                    line_count = max(1, len(text) / max(1, CHARS_PER_LINE * 0.8)) if text else 1
                    est_h = EST_PARAGRAPH * line_count
                    elem = {'type': 'paragraph', 'text': text[:40], 'index': idx, 'est_height': round(est_h, 1)}
                    report['elements'].append(elem)

                idx += 1

            elif tag == 'tbl':
                tbl_type = classify_table(child)
                rows = count_table_rows(child)
                cols = count_table_cols(child)
                headers = get_table_header_text(child)

                # 높이 추정
                if tbl_type in ('code_dark', 'code_light'):
                    est_h = rows * EST_CODE_ROW + 20
                elif tbl_type == 'info_box':
                    est_h = EST_INFO_BOX
                else:
                    est_h = EST_TABLE_HEADER + (rows - 1) * EST_TABLE_ROW

                elem = {
                    'type': 'table', 'tbl_type': tbl_type,
                    'rows': rows, 'cols': cols,
                    'headers': headers[:5],
                    'index': idx, 'est_height': round(est_h, 1),
                    'after': last_heading or '(문서 시작)',
                }
                report['elements'].append(elem)
                report['tables'].append(elem)
                idx += 1

    return report


# ============================================================
# 페이지 레이아웃 시뮬레이션
# ============================================================

def simulate_layout(report):
    """요소 흐름을 순회하며 페이지 위치를 추정하고 레이아웃 문제를 감지"""

    pages = []         # 각 페이지의 요소 목록
    current_page = []  # 현재 페이지에 쌓인 요소들
    current_y = 0.0    # 현재 페이지에서 사용된 높이 (pt)
    current_started_by_break = False  # 현재 페이지가 명시적 break로 시작되었는지
    recommendations = []

    for elem in report['elements']:
        etype = elem['type']

        # 페이지 나누기 → 현재 페이지 닫고 새 페이지 시작
        if etype == 'page_break':
            current_page.append(elem)
            pages.append({'elements': current_page, 'used_height': current_y, 'started_by_break': current_started_by_break})
            current_page = []
            current_y = 0.0
            current_started_by_break = True  # 다음 페이지는 break로 시작
            continue

        est_h = elem.get('est_height', 0)

        # 자동 페이지 넘김 시뮬레이션 (Word가 자동으로 넘기는 것)
        if current_y + est_h > USABLE_HEIGHT_PT and current_y > 0:
            pages.append({'elements': current_page, 'used_height': current_y, 'started_by_break': current_started_by_break})
            current_page = []
            current_y = 0.0
            current_started_by_break = False  # 자동 넘김은 break가 아님

        current_page.append(elem)
        current_y += est_h

    # 마지막 페이지
    if current_page:
        pages.append({'elements': current_page, 'used_height': current_y, 'started_by_break': current_started_by_break})

    # ── 레이아웃 문제 감지 ──

    for page_num, page in enumerate(pages, 1):
        elems = page['elements']
        y_accum = 0.0

        for i, elem in enumerate(elems):
            y_accum += elem.get('est_height', 0)

            # 규칙 1: 이미지가 페이지 나누기 없이 이전 콘텐츠와 같이 배치됨
            if elem['type'] == 'image':
                remaining = USABLE_HEIGHT_PT - y_accum
                page_started_by_break = page.get('started_by_break', False)

                # 오버플로우로 넘어온 경우: 이전 페이지가 break로 시작되었고
                # 이전 페이지에 이 이미지의 섹션 제목이 있으면 의도된 배치
                if not page_started_by_break and page_num > 1:
                    prev_page = pages[page_num - 2]
                    if prev_page.get('started_by_break', False):
                        img_section = elem.get('section', '')
                        prev_has_heading = any(
                            e.get('type') == 'heading' and img_section and img_section in e.get('text', '')
                            for e in prev_page['elements']
                        )
                        if prev_has_heading:
                            page_started_by_break = True  # 의도된 배치로 간주

                if not page_started_by_break and page_num > 1:
                    section = elem.get('section', '?')
                    recommendations.append({
                        'type': 'IMAGE_NEEDS_PAGE_BREAK',
                        'code': 'IMAGE_NEEDS_PAGE_BREAK',
                        'severity': 'WARN',
                        'page': page_num,
                        'index': elem['index'],
                        'section': section,
                        'message': f'이미지({elem["width_pt"]:.0f}x{elem["height_pt"]:.0f}pt)가 이전 콘텐츠와 같은 페이지에 배치됨',
                        'detail': f'섹션 "{section}" 앞에 페이지 나누기를 추가하면 이미지가 깔끔하게 표시됩니다',
                        'action': f'이미지 포함 섹션 앞에 pageBreak() 추가 권장',
                        'context': {'imageSize': {'width': round(elem.get('width_pt', 0)), 'height': round(elem.get('height_pt', 0))}, 'pageRemaining': round(remaining)},
                    })

                # 이미지가 페이지 하단에 걸쳐 잘릴 수 있는지
                if remaining < 0:
                    recommendations.append({
                        'type': 'IMAGE_OVERFLOW',
                        'code': 'IMAGE_OVERFLOW',
                        'severity': 'WARN',
                        'page': page_num,
                        'index': elem['index'],
                        'message': f'이미지가 페이지 경계를 넘김 (초과 {-remaining:.0f}pt)',
                        'detail': f'Word가 자동으로 다음 페이지로 밀 수 있으나, 앞에 빈 공간이 발생할 수 있음',
                        'action': f'이미지 섹션 앞에 pageBreak() 추가하여 의도적으로 배치 권장',
                        'context': {'overflow': round(-remaining)},
                    })

            # 규칙 2: 제목이 페이지 맨 하단에 혼자 남음 (orphan heading)
            if elem['type'] == 'heading':
                remaining = USABLE_HEIGHT_PT - y_accum
                if remaining < 60:  # 제목 아래 60pt 미만 공간 → 내용 들어갈 자리 없음
                    recommendations.append({
                        'type': 'ORPHAN_HEADING',
                        'code': 'ORPHAN_HEADING',
                        'severity': 'INFO',
                        'page': page_num,
                        'index': elem['index'],
                        'message': f'H{elem["level"]} "{elem["text"][:30]}" 이 페이지 하단에 위치 (남은 공간 {remaining:.0f}pt)',
                        'detail': f'제목만 현재 페이지에 남고 내용은 다음 페이지로 넘어갈 수 있음',
                        'action': f'제목 앞에 pageBreak() 추가 고려',
                        'context': {'headingLevel': elem['level'], 'remainingSpace': round(remaining)},
                    })

            # 규칙 3: 큰 테이블이 페이지 중간에서 잘림
            if elem['type'] == 'table' and elem.get('tbl_type') == 'data_table':
                remaining = USABLE_HEIGHT_PT - y_accum + elem['est_height']
                if elem['est_height'] > remaining and remaining < USABLE_HEIGHT_PT * 0.4:
                    recommendations.append({
                        'type': 'TABLE_SPLIT',
                        'code': 'TABLE_SPLIT',
                        'severity': 'INFO',
                        'page': page_num,
                        'index': elem['index'],
                        'message': f'테이블({elem["rows"]}행)이 페이지 하단에서 잘릴 수 있음',
                        'detail': f'테이블 높이 ~{elem["est_height"]:.0f}pt, 남은 공간 ~{remaining:.0f}pt',
                        'action': f'테이블 앞에 pageBreak() 추가 또는 테이블 크기 조정 고려',
                        'context': {'rows': elem.get('rows', 0), 'tableHeight': round(elem.get('est_height', 0)), 'remainingSpace': round(remaining)},
                    })

    layout = {
        'total_pages_estimated': len(pages),
        'pages': [],
        'recommendations': recommendations,
    }

    for i, page in enumerate(pages, 1):
        page_summary = {
            'page': i,
            'used_height': round(page['used_height'], 1),
            'fill_pct': round(page['used_height'] / USABLE_HEIGHT_PT * 100, 1),
            'has_image': any(e['type'] == 'image' for e in page['elements']),
            'heading_count': sum(1 for e in page['elements'] if e['type'] == 'heading'),
            'table_count': sum(1 for e in page['elements'] if e['type'] == 'table'),
        }
        layout['pages'].append(page_summary)

    return layout


# ============================================================
# 구조적 문제 감지
# ============================================================

def check_issues(report):
    issues = report['issues']

    if not report['has_header']:
        issues.append('[WARN] 머릿글(header)이 없습니다')
    if not report['has_footer']:
        issues.append('[WARN] 바닥글(footer)이 없습니다')

    prev_level = 0
    for h in report['headings']:
        if h['level'] > prev_level + 1 and prev_level > 0:
            issues.append(f'[WARN] 제목 계층 건너뛰기: H{prev_level} → H{h["level"]} ("{h["text"]}")')
        prev_level = h['level']

    data_tables = [t for t in report['tables'] if t['tbl_type'] == 'data_table']
    if not data_tables:
        issues.append('[INFO] 데이터 테이블이 없습니다')

    if not report['page_breaks']:
        issues.append('[INFO] 페이지 나누기가 없습니다 (단일 페이지 문서?)')

    for i in range(1, len(report['page_breaks'])):
        curr = report['page_breaks'][i]['index']
        prev = report['page_breaks'][i - 1]['index']
        if curr - prev <= 2:
            issues.append(f'[WARN] 연속 페이지 나누기 감지 (index {prev} → {curr}). 빈 페이지 발생 가능')

    return issues


# ============================================================
# 리포트 출력
# ============================================================

def print_report(report, layout):
    sep = '─' * 60

    print()
    print(f'{"=" * 60}')
    print(f'  DOCX 구조 검증 리포트')
    print(f'{"=" * 60}')

    # ── 기본 정보 ──
    print(f'\n{sep}')
    print(f'  파일: {report["file"]}')
    print(f'  크기: {report["file_size"]:,} bytes')
    if report['core_props']:
        for k, v in report['core_props'].items():
            print(f'  {k}: {v}')
    print(f'  머릿글: {"O" if report["has_header"] else "X"} {report["header_text"][:50]}')
    print(f'  바닥글: {"O" if report["has_footer"] else "X"} {report["footer_text"][:50]}')

    # ── 요소 통계 ──
    print(f'\n{sep}')
    print(f'  요소 통계')
    print(f'{sep}')

    data_tables = [t for t in report['tables'] if t.get('tbl_type') == 'data_table']
    code_blocks = [t for t in report['tables'] if t.get('tbl_type') in ('code_dark', 'code_light')]
    info_boxes = [t for t in report['tables'] if t.get('tbl_type') == 'info_box']

    print(f'  총 단락:      {report["paragraphs"]:>5}개')
    print(f'  빈 단락:      {report["empty_paragraphs"]:>5}개')
    print(f'  제목:         {len(report["headings"]):>5}개 (H1:{sum(1 for h in report["headings"] if h["level"]==1)} H2:{sum(1 for h in report["headings"] if h["level"]==2)} H3:{sum(1 for h in report["headings"] if h["level"]==3)} H4:{sum(1 for h in report["headings"] if h["level"]==4)})')
    print(f'  불릿:         {report["bullets"]:>5}개')
    print(f'  데이터 테이블: {len(data_tables):>5}개')
    print(f'  코드 블록:     {len(code_blocks):>5}개 (다크:{sum(1 for t in code_blocks if t.get("tbl_type")=="code_dark")} 라이트:{sum(1 for t in code_blocks if t.get("tbl_type")=="code_light")})')
    print(f'  정보 박스:     {len(info_boxes):>5}개')
    print(f'  이미지:        {report["images"]:>5}개')
    for img in report['image_details']:
        print(f'                 └ {img["width_pt"]:.0f}x{img["height_pt"]:.0f}pt (섹션: {img["section"][:30]})')
    print(f'  페이지 나누기: {len(report["page_breaks"]):>5}개')

    # ── 문서 구조 ──
    print(f'\n{sep}')
    print(f'  문서 구조')
    print(f'{sep}')

    events = []
    for e in report['elements']:
        if e['type'] == 'heading':
            events.append(('heading', e['index'], e))
        elif e['type'] == 'page_break':
            events.append(('pagebreak', e['index'], e))
        elif e['type'] == 'table' and e.get('tbl_type') == 'data_table':
            events.append(('table', e['index'], e))
        elif e['type'] == 'image':
            events.append(('image', e['index'], e))

    events.sort(key=lambda x: x[1])

    page = 1
    for event_type, idx_val, data in events:
        if event_type == 'pagebreak':
            print(f'  {"---":>6} ── 페이지 나누기 ── (p.{page} → p.{page+1})')
            page += 1
        elif event_type == 'heading':
            indent = '  ' * data['level']
            print(f'  [{idx_val:>4}] {indent}H{data["level"]}: {data["text"][:45]}')
        elif event_type == 'table':
            header_preview = ', '.join(data['headers'][:4])
            print(f'  [{idx_val:>4}]     표 {data["rows"]}x{data["cols"]} [{header_preview[:40]}]')
        elif event_type == 'image':
            print(f'  [{idx_val:>4}]     이미지 {data["width_pt"]:.0f}x{data["height_pt"]:.0f}pt')

    # ── 페이지 레이아웃 분석 ──
    print(f'\n{sep}')
    print(f'  페이지 레이아웃 분석 (추정, 가용 높이 {USABLE_HEIGHT_PT:.0f}pt)')
    print(f'{sep}')

    for pg in layout['pages']:
        fill_bar = '█' * int(pg['fill_pct'] / 5) + '░' * (20 - int(pg['fill_pct'] / 5))
        extras = []
        if pg['has_image']:
            extras.append('이미지')
        if pg['table_count'] > 0:
            extras.append(f'표{pg["table_count"]}')
        extra_str = f' [{", ".join(extras)}]' if extras else ''
        print(f'  p.{pg["page"]:>2}  {fill_bar} {pg["fill_pct"]:>5.1f}% ({pg["used_height"]:.0f}pt){extra_str}')

    print(f'\n  추정 총 페이지: {layout["total_pages_estimated"]}페이지')

    # ── 이슈 ──
    issues = check_issues(report)
    if issues:
        print(f'\n{sep}')
        print(f'  구조 이슈 ({len(issues)}건)')
        print(f'{sep}')
        for issue in issues:
            print(f'  {issue}')
    else:
        print(f'\n  구조 이슈 없음')

    # ── 레이아웃 권장사항 ──
    recs = layout['recommendations']
    if recs:
        print(f'\n{sep}')
        print(f'  레이아웃 권장사항 ({len(recs)}건)')
        print(f'{sep}')
        for r in recs:
            print(f'  [{r["severity"]}] p.{r["page"]} index[{r["index"]}] {r["message"]}')
            print(f'         → {r["detail"]}')
            print(f'         → {r["action"]}')
    else:
        print(f'\n  레이아웃 권장사항 없음')

    print(f'\n{"=" * 60}')
    print()


# ============================================================
# JSON 출력
# ============================================================

def build_json_output(report, layout):
    """검증 결과를 구조화된 JSON으로 변환"""

    data_tables = [t for t in report['tables'] if t.get('tbl_type') == 'data_table']
    code_blocks = [t for t in report['tables'] if t.get('tbl_type') in ('code_dark', 'code_light')]
    info_boxes = [t for t in report['tables'] if t.get('tbl_type') == 'info_box']

    # 구조 이슈도 수집
    issues_text = check_issues(report)

    # heading 레벨별 카운트
    heading_counts = {}
    for h in report['headings']:
        key = f'h{h["level"]}'
        heading_counts[key] = heading_counts.get(key, 0) + 1

    stats = {
        'paragraphs': report['paragraphs'],
        'emptyParagraphs': report['empty_paragraphs'],
        'headings': len(report['headings']),
        'headingsByLevel': heading_counts,
        'bullets': report['bullets'],
        'tables': len(data_tables),
        'codeBlocks': len(code_blocks),
        'infoBoxes': len(info_boxes),
        'images': report['images'],
        'pageBreaks': len(report['page_breaks']),
        'estimatedPages': layout['total_pages_estimated'],
    }

    # 이슈 목록 (구조 + 레이아웃 통합)
    all_issues = []
    for issue_text in issues_text:
        severity = 'WARN' if '[WARN]' in issue_text else 'INFO'
        cleaned = issue_text.replace('[WARN] ', '').replace('[INFO] ', '')
        all_issues.append({
            'type': 'STRUCTURE',
            'code': 'STRUCTURE',
            'severity': severity,
            'message': cleaned,
        })
    for rec in layout['recommendations']:
        all_issues.append(rec)

    # 페이지 상세
    pages = []
    for pg in layout['pages']:
        pages.append({
            'page': pg['page'],
            'usedHeight': pg['used_height'],
            'fillPct': pg['fill_pct'],
            'hasImage': pg['has_image'],
            'headingCount': pg['heading_count'],
            'tableCount': pg['table_count'],
        })

    result = {
        'file': report['file'],
        'fileSize': report['file_size'],
        'hasHeader': report['has_header'],
        'hasFooter': report['has_footer'],
        'coreProps': report['core_props'],
        'stats': stats,
        'issues': all_issues,
        'pages': pages,
    }

    return result


# ============================================================
# 메인
# ============================================================
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('사용법: python -X utf8 tools/validate-docx.py <파일.docx>')
        print('        python -X utf8 tools/validate-docx.py <파일.docx> --json')
        print('예시:   python -X utf8 tools/validate-docx.py output/gendocs_프로젝트_소개서_v0.1.0.docx')
        sys.exit(1)

    docx_path = sys.argv[1]
    json_mode = '--json' in sys.argv

    report = analyze_document(docx_path)
    layout = simulate_layout(report)

    if json_mode:
        result = build_json_output(report, layout)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_report(report, layout)

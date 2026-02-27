"""
DOCX 텍스트 + 이미지 추출 스크립트 (ZIP + XML 방식)
python-docx 의존성 없이, 내장 모듈만으로 DOCX 내용을 구조화하여 추출합니다.

사용법: python -X utf8 tools/extract-docx.py output/문서.docx
        python -X utf8 tools/extract-docx.py output/문서.docx --json
        python -X utf8 tools/extract-docx.py output/문서.docx --extract-images output/images/
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
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
}

W = NS['w']
R = NS['r']
WP = NS['wp']
A = NS['a']
PIC = NS['pic']
EMU_TO_PT = 1 / 12700  # EMU → pt 변환


# ============================================================
# XML 파싱 유틸리티
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
    """페이지 나누기 존재 여부"""
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


def get_table_rows(tbl):
    """테이블의 모든 행을 [row][col] 텍스트 배열로 추출"""
    rows = []
    for tr in tbl.findall(f'{{{W}}}tr'):
        cells = []
        for tc in tr.findall(f'{{{W}}}tc'):
            cell_texts = []
            for p in tc.findall(f'{{{W}}}p'):
                t = extract_text(p)
                if t:
                    cell_texts.append(t)
            cells.append('\n'.join(cell_texts))
        rows.append(cells)
    return rows


def classify_table(tbl):
    """테이블 유형 판별: code_dark, code_light, info_box, warning_box, data_table"""
    bg = get_table_shading(tbl).upper()
    rows = get_table_rows(tbl)
    cols = len(rows[0]) if rows else 0

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


def get_heading_level(style_name):
    """스타일명에서 제목 레벨 추출. 제목이 아니면 0 반환"""
    if not style_name:
        return 0
    s = style_name.lower()
    if s.startswith('heading'):
        try:
            return int(s.replace('heading', '').strip())
        except ValueError:
            return 0
    for i in range(1, 7):
        if s == f'heading{i}' or s == f'heading {i}':
            return i
    return 0


# ============================================================
# 이미지 관련
# ============================================================

def parse_relationships(z):
    """word/_rels/document.xml.rels에서 rId → 파일 경로 매핑 추출"""
    rels = {}
    rels_path = 'word/_rels/document.xml.rels'
    if rels_path not in z.namelist():
        return rels

    tree = ET.parse(z.open(rels_path))
    root = tree.getroot()
    # rels 파일은 기본 네임스페이스가 다름
    rel_ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
    for rel in root.findall(f'{{{rel_ns}}}Relationship'):
        rid = rel.get('Id', '')
        target = rel.get('Target', '')
        rel_type = rel.get('Type', '')
        if 'image' in rel_type:
            rels[rid] = target  # e.g., "media/image1.png"
    return rels


def get_image_info(p, rels):
    """단락에서 이미지 정보 추출. 없으면 None 반환.
    반환: {'rId': 'rId7', 'media_path': 'word/media/image1.png', 'width_pt': 780, 'height_pt': 550, 'alt': '설명'}
    """
    # w:drawing 요소 탐색
    for drawing in p.iter(f'{{{W}}}drawing'):
        # wp:inline 또는 wp:anchor
        for container in list(drawing):
            container_tag = container.tag.split('}')[-1] if '}' in container.tag else container.tag
            if container_tag not in ('inline', 'anchor'):
                continue

            # 크기 추출 (wp:extent)
            extent = container.find(f'{{{WP}}}extent')
            width_pt = 0
            height_pt = 0
            if extent is not None:
                cx = int(extent.get('cx', '0'))
                cy = int(extent.get('cy', '0'))
                width_pt = round(cx * EMU_TO_PT, 1)
                height_pt = round(cy * EMU_TO_PT, 1)

            # alt 텍스트 (wp:docPr)
            doc_pr = container.find(f'{{{WP}}}docPr')
            alt = ''
            if doc_pr is not None:
                alt = doc_pr.get('descr', '') or doc_pr.get('name', '')

            # rId 추출 (a:blip r:embed)
            for blip in container.iter(f'{{{A}}}blip'):
                rid = blip.get(f'{{{R}}}embed', '')
                if rid and rid in rels:
                    media_target = rels[rid]
                    # target은 "media/image1.png" 형태 → "word/media/image1.png"
                    media_path = f'word/{media_target}' if not media_target.startswith('word/') else media_target
                    return {
                        'rId': rid,
                        'media_path': media_path,
                        'filename': os.path.basename(media_target),
                        'width_pt': width_pt,
                        'height_pt': height_pt,
                        'alt': alt,
                    }
    return None


def list_media_files(z):
    """DOCX 내 word/media/ 에 있는 모든 파일 목록"""
    return [n for n in z.namelist() if n.startswith('word/media/')]


def extract_images_to_dir(z, image_elements, output_dir):
    """이미지 파일들을 지정 디렉토리에 추출"""
    os.makedirs(output_dir, exist_ok=True)
    extracted = []
    for el in image_elements:
        if el['type'] != 'image':
            continue
        media_path = el.get('media_path', '')
        if not media_path:
            continue
        try:
            data = z.read(media_path)
            out_path = os.path.join(output_dir, el['filename'])
            with open(out_path, 'wb') as f:
                f.write(data)
            extracted.append(out_path)
        except KeyError:
            print(f"  [SKIP] {media_path} 를 ZIP에서 찾을 수 없음", file=sys.stderr)
    return extracted


# ============================================================
# 메인 추출 로직
# ============================================================

def extract_document(docx_path, image_output_dir=None):
    """DOCX에서 구조화된 콘텐츠 추출 (이미지 포함)"""
    if not os.path.exists(docx_path):
        print(f"[ERROR] 파일을 찾을 수 없습니다: {docx_path}", file=sys.stderr)
        sys.exit(1)

    elements = []

    with zipfile.ZipFile(docx_path, 'r') as z:
        # 릴레이션십 파싱 (rId → 이미지 파일 매핑)
        rels = parse_relationships(z)
        media_files = list_media_files(z)

        # document.xml 파싱
        tree = ET.parse(z.open('word/document.xml'))
        root = tree.getroot()
        body = root.find(f'{{{W}}}body')
        if body is None:
            print("[ERROR] document.xml에 body 요소가 없습니다.", file=sys.stderr)
            sys.exit(1)

        for child in body:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

            # ── 단락 (w:p) ──
            if tag == 'p':
                text = extract_text(child)
                style = get_paragraph_style(child)
                level = get_heading_level(style)
                is_break = has_page_break(child)
                is_list = style.lower().startswith('list') if style else False

                # 이미지 감지
                img_info = get_image_info(child, rels)

                if is_break:
                    elements.append({'type': 'pageBreak'})

                if img_info:
                    el = {'type': 'image'}
                    el.update(img_info)
                    if image_output_dir:
                        el['extracted_path'] = os.path.join(image_output_dir, img_info['filename'])
                    elements.append(el)
                elif level > 0 and text:
                    elements.append({'type': 'heading', 'level': level, 'text': text})
                elif is_list and text:
                    elements.append({'type': 'listItem', 'text': text})
                elif text:
                    elements.append({'type': 'paragraph', 'text': text})
                # 빈 단락은 생략

            # ── 테이블 (w:tbl) ──
            elif tag == 'tbl':
                tbl_type = classify_table(child)
                rows = get_table_rows(child)

                if tbl_type in ('code_dark', 'code_light'):
                    code_lines = []
                    for row in rows:
                        for cell in row:
                            code_lines.append(cell)
                    elements.append({
                        'type': 'codeBlock',
                        'content': '\n'.join(code_lines),
                        'dark': tbl_type == 'code_dark'
                    })
                elif tbl_type == 'info_box':
                    text = '\n'.join(cell for row in rows for cell in row if cell)
                    elements.append({'type': 'infoBox', 'text': text})
                elif tbl_type == 'warning_box':
                    text = '\n'.join(cell for row in rows for cell in row if cell)
                    elements.append({'type': 'warningBox', 'text': text})
                else:
                    if rows and len(rows) > 0:
                        headers = rows[0]
                        data = rows[1:] if len(rows) > 1 else []
                        elements.append({
                            'type': 'table',
                            'headers': headers,
                            'rows': data
                        })

        # 이미지 파일 추출
        if image_output_dir:
            extracted = extract_images_to_dir(z, elements, image_output_dir)
            if extracted:
                print(f"이미지 {len(extracted)}개 추출 → {image_output_dir}", file=sys.stderr)

    return elements, media_files


# ============================================================
# 출력 포맷
# ============================================================

def print_text(elements):
    """사람이 읽을 수 있는 텍스트 형식으로 출력"""
    print(f"추출 요소: {len(elements)}개\n")

    for i, el in enumerate(elements):
        t = el['type']

        if t == 'pageBreak':
            print("--- PAGE BREAK ---")
        elif t == 'heading':
            prefix = '#' * el['level']
            print(f"{prefix} {el['text']}")
        elif t == 'paragraph':
            print(f"  {el['text']}")
        elif t == 'listItem':
            print(f"  - {el['text']}")
        elif t == 'table':
            headers = el['headers']
            print(f"\n  [TABLE] {' | '.join(headers)}")
            for row in el['rows']:
                print(f"    {' | '.join(row)}")
            print()
        elif t == 'codeBlock':
            lang = 'dark' if el.get('dark') else 'light'
            preview = el['content'][:80].replace('\n', '\\n')
            print(f"  [CODE-{lang}] {preview}...")
        elif t == 'infoBox':
            print(f"  [INFO] {el['text'][:80]}...")
        elif t == 'warningBox':
            print(f"  [WARN] {el['text'][:80]}...")
        elif t == 'image':
            size = f"{el.get('width_pt', 0):.0f}x{el.get('height_pt', 0):.0f}pt"
            alt = el.get('alt', '') or el.get('filename', '')
            path = el.get('extracted_path', el.get('filename', ''))
            print(f"  [IMAGE] {alt} ({size}) → {path}")


def print_json(elements):
    """JSON 형식으로 출력"""
    print(json.dumps(elements, ensure_ascii=False, indent=2))


def print_stats(elements, media_files):
    """요소 통계 출력"""
    counts = {}
    for el in elements:
        t = el['type']
        counts[t] = counts.get(t, 0) + 1

    heading_levels = {}
    for el in elements:
        if el['type'] == 'heading':
            key = f"h{el['level']}"
            heading_levels[key] = heading_levels.get(key, 0) + 1

    table_col_patterns = {}
    for el in elements:
        if el['type'] == 'table':
            key = '|'.join(el['headers'])
            table_col_patterns[key] = table_col_patterns.get(key, 0) + 1

    print("=" * 60)
    print("추출 통계")
    print("=" * 60)
    for t, c in sorted(counts.items()):
        print(f"  {t}: {c}")

    if heading_levels:
        print(f"\n제목 레벨별:")
        for k, v in sorted(heading_levels.items()):
            print(f"  {k}: {v}")

    if table_col_patterns:
        print(f"\n테이블 헤더 패턴 ({len(table_col_patterns)}종):")
        for k, v in sorted(table_col_patterns.items(), key=lambda x: -x[1]):
            print(f"  [{v}회] {k}")

    if media_files:
        print(f"\n내장 미디어 파일 ({len(media_files)}개):")
        for mf in media_files:
            print(f"  {mf}")


# ============================================================
# 메인
# ============================================================

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("사용법: python -X utf8 tools/extract-docx.py <파일.docx> [--json] [--extract-images <출력폴더>]")
        sys.exit(1)

    docx_path = sys.argv[1]
    json_mode = '--json' in sys.argv

    # --extract-images 옵션 파싱
    image_output_dir = None
    if '--extract-images' in sys.argv:
        idx = sys.argv.index('--extract-images')
        if idx + 1 < len(sys.argv):
            image_output_dir = sys.argv[idx + 1]
        else:
            print("[ERROR] --extract-images 뒤에 출력 폴더를 지정하세요.", file=sys.stderr)
            sys.exit(1)

    elements, media_files = extract_document(docx_path, image_output_dir)

    if json_mode:
        print_json(elements)
    else:
        print_stats(elements, media_files)
        print()
        print_text(elements)

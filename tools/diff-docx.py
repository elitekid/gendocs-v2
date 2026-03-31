"""
DOCX XML-level 비교 도구

두 DOCX 파일의 XML 구조를 심층 비교하여 페이지 설정, 스타일, 요소 구조,
테이블, 런 속성, 간격 차이를 한 번에 분석합니다.

사용법: python -X utf8 tools/diff-docx.py <reference.docx> <generated.docx>
        python -X utf8 tools/diff-docx.py <reference.docx> <generated.docx> --json

순수 Python (zipfile + xml.etree.ElementTree), 외부 의존성 없음.
"""

import sys
import os
import io
import json
import zipfile
import xml.etree.ElementTree as ET

# Windows UTF-8 출력
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
}

W = NS['w']
A = NS['a']
WP = NS['wp']

# ============================================================
# 특수 블록 판별용 배경색
# ============================================================
DARK_CODE_COLORS = {'1E1E1E', '2D2D2D'}
LIGHT_CODE_COLORS = {'F5F5F5', 'F0F0F0', 'F5F7FA'}
INFO_BOX_COLORS = {'E8F0F7'}
WARNING_BOX_COLORS = {'FEF6E6'}
SPECIAL_BG_COLORS = DARK_CODE_COLORS | LIGHT_CODE_COLORS | INFO_BOX_COLORS | WARNING_BOX_COLORS

EMU_TO_DXA = 1 / 635  # 1 DXA = 635 EMU (approx)
EMU_TO_PT = 1 / 12700
HALF_PT_TO_PT = 0.5  # half-point to point


# ============================================================
# XML 유틸리티
# ============================================================

def _read_xml(z, path):
    """ZIP에서 XML 파싱. 없으면 None 반환."""
    if path in z.namelist():
        return ET.parse(z.open(path)).getroot()
    return None


def _attr(el, attr_name):
    """w:xxx 네임스페이스 속성 읽기."""
    if el is None:
        return None
    return el.get(f'{{{W}}}{attr_name}')


def _find(el, *tags):
    """중첩 w:xxx 태그를 순서대로 탐색."""
    cur = el
    for tag in tags:
        if cur is None:
            return None
        cur = cur.find(f'{{{W}}}{tag}')
    return cur


def _extract_text(element):
    """w:p 요소에서 텍스트 추출."""
    texts = []
    for t in element.iter(f'{{{W}}}t'):
        if t.text:
            texts.append(t.text)
    return ''.join(texts).strip()


def _get_style(p):
    """w:p 스타일명."""
    pStyle = _find(p, 'pPr', 'pStyle')
    return _attr(pStyle, 'val') or '' if pStyle is not None else ''


def _has_page_break(p):
    for br in p.iter(f'{{{W}}}br'):
        if br.get(f'{{{W}}}type') == 'page':
            return True
    return False


def _is_bold(val_str):
    """
    Bold 판정. <w:b/> 또는 <w:b val="true"|"1"> → True.
    <w:b val="false"|"0"> → False (= bold 태그 없음과 동일).
    None(태그 없음) → False.
    """
    if val_str is None:
        return False
    v = val_str.lower()
    if v in ('false', '0'):
        return False
    return True


def _is_italic(val_str):
    """Italic 판정. 동일 로직."""
    if val_str is None:
        return False
    v = val_str.lower()
    if v in ('false', '0'):
        return False
    return True


def _get_bool_prop(rPr, tag):
    """rPr에서 bool 속성 추출. 태그 없으면 None, 있으면 val 반환."""
    if rPr is None:
        return None
    el = rPr.find(f'{{{W}}}{tag}')
    if el is None:
        return None
    return el.get(f'{{{W}}}val', 'true')  # <w:b/> → val 없으면 "true"


def _normalize_bool(val_str):
    """Bool 속성 정규화: True/False/None."""
    if val_str is None:
        return False
    v = str(val_str).lower()
    if v in ('false', '0'):
        return False
    return True


def _get_shading_color(el):
    """요소(tcPr 또는 pPr)에서 shading fill 색상 추출."""
    if el is None:
        return None
    shd = el.find(f'{{{W}}}shd')
    if shd is not None:
        fill = shd.get(f'{{{W}}}fill', '')
        if fill and fill.upper() != 'AUTO':
            return fill.upper()
    return None


def _table_first_cell_bg(tbl):
    """테이블 첫 셀 배경색."""
    for tc in tbl.iter(f'{{{W}}}tc'):
        tcPr = tc.find(f'{{{W}}}tcPr')
        c = _get_shading_color(tcPr)
        if c:
            return c
        break
    return None


def _classify_table(tbl):
    """테이블 유형: code_dark, code_light, info_box, warning_box, data_table."""
    bg = (_table_first_cell_bg(tbl) or '').upper()
    rows = tbl.findall(f'{{{W}}}tr')
    first_row = rows[0] if rows else None
    cols = len(first_row.findall(f'{{{W}}}tc')) if first_row is not None else 0

    if bg in DARK_CODE_COLORS:
        return 'code_dark'
    if cols == 1 and bg in LIGHT_CODE_COLORS:
        return 'code_light'
    if cols == 1 and bg in INFO_BOX_COLORS:
        return 'info_box'
    if cols == 1 and bg in WARNING_BOX_COLORS:
        return 'warning_box'
    return 'data_table'


def _has_image(p):
    """단락에 이미지가 포함되어 있는지."""
    for _ in p.iter(f'{{{WP}}}inline'):
        return True
    for _ in p.iter(f'{{{WP}}}anchor'):
        return True
    return False


def _get_image_size(p):
    """이미지 크기 (EMU → pt)."""
    for drawing in [*p.iter(f'{{{WP}}}inline'), *p.iter(f'{{{WP}}}anchor')]:
        extent = drawing.find(f'{{{WP}}}extent')
        if extent is not None:
            cx = int(extent.get('cx', 0))
            cy = int(extent.get('cy', 0))
            return round(cx * EMU_TO_PT, 1), round(cy * EMU_TO_PT, 1)
    return None, None


# ============================================================
# DOCX 열기
# ============================================================

def open_docx(path):
    """DOCX 파일을 열어 (zipfile, document_root, styles_root) 반환."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")
    z = zipfile.ZipFile(path, 'r')
    doc = _read_xml(z, 'word/document.xml')
    styles = _read_xml(z, 'word/styles.xml')
    return z, doc, styles


# ============================================================
# 1. Page Setup 비교
# ============================================================

def compare_page_setup(doc_ref, doc_gen):
    """sectPr에서 페이지 설정 비교."""
    diffs = []
    matches = []

    def get_sect_pr(doc_root):
        body = doc_root.find(f'{{{W}}}body')
        if body is None:
            return None
        return body.find(f'{{{W}}}sectPr')

    sp_ref = get_sect_pr(doc_ref)
    sp_gen = get_sect_pr(doc_gen)

    if sp_ref is None and sp_gen is None:
        matches.append({'field': 'sectPr', 'note': 'Both missing'})
        return {'diffs': diffs, 'matches': matches}

    # pgSz
    def get_pg_sz(sp):
        if sp is None:
            return {}
        pgSz = sp.find(f'{{{W}}}pgSz')
        if pgSz is None:
            return {}
        return {
            'width': pgSz.get(f'{{{W}}}w'),
            'height': pgSz.get(f'{{{W}}}h'),
            'orient': pgSz.get(f'{{{W}}}orient', 'portrait'),
        }

    sz_ref = get_pg_sz(sp_ref)
    sz_gen = get_pg_sz(sp_gen)

    for field in ['width', 'height', 'orient']:
        vr = sz_ref.get(field)
        vg = sz_gen.get(field)
        entry = {'field': f'pgSz.{field}', 'ref': vr, 'gen': vg}
        if vr == vg:
            matches.append(entry)
        else:
            diffs.append(entry)

    # pgMar
    def get_pg_mar(sp):
        if sp is None:
            return {}
        pgMar = sp.find(f'{{{W}}}pgMar')
        if pgMar is None:
            return {}
        result = {}
        for attr in ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter']:
            val = pgMar.get(f'{{{W}}}{attr}')
            if val:
                result[attr] = val
        return result

    mar_ref = get_pg_mar(sp_ref)
    mar_gen = get_pg_mar(sp_gen)
    all_keys = sorted(set(list(mar_ref.keys()) + list(mar_gen.keys())))
    for k in all_keys:
        vr = mar_ref.get(k)
        vg = mar_gen.get(k)
        entry = {'field': f'pgMar.{k}', 'ref': vr, 'gen': vg}
        if vr == vg:
            matches.append(entry)
        else:
            diffs.append(entry)

    return {'diffs': diffs, 'matches': matches}


# ============================================================
# 2. Document Defaults 비교
# ============================================================

def compare_doc_defaults(styles_ref, styles_gen):
    """docDefaults 비교 (기본 폰트, 크기)."""
    diffs = []
    matches = []

    def get_defaults(styles_root):
        if styles_root is None:
            return {}
        dd = styles_root.find(f'{{{W}}}docDefaults')
        if dd is None:
            return {}
        result = {}
        # rPrDefault
        rPrDefault = _find(dd, 'rPrDefault', 'rPr')
        if rPrDefault is not None:
            rFonts = rPrDefault.find(f'{{{W}}}rFonts')
            if rFonts is not None:
                for attr in ['ascii', 'hAnsi', 'eastAsia', 'cs']:
                    v = rFonts.get(f'{{{W}}}{attr}')
                    if v:
                        result[f'font.{attr}'] = v
            sz = rPrDefault.find(f'{{{W}}}sz')
            if sz is not None:
                result['fontSize'] = _attr(sz, 'val')
            szCs = rPrDefault.find(f'{{{W}}}szCs')
            if szCs is not None:
                result['fontSizeCs'] = _attr(szCs, 'val')
        # pPrDefault
        pPrDefault = _find(dd, 'pPrDefault', 'pPr')
        if pPrDefault is not None:
            spacing = pPrDefault.find(f'{{{W}}}spacing')
            if spacing is not None:
                for attr in ['before', 'after', 'line', 'lineRule']:
                    v = spacing.get(f'{{{W}}}{attr}')
                    if v:
                        result[f'spacing.{attr}'] = v
        return result

    def_ref = get_defaults(styles_ref)
    def_gen = get_defaults(styles_gen)
    all_keys = sorted(set(list(def_ref.keys()) + list(def_gen.keys())))

    for k in all_keys:
        vr = def_ref.get(k)
        vg = def_gen.get(k)
        entry = {'field': k, 'ref': vr, 'gen': vg}
        if vr == vg:
            matches.append(entry)
        else:
            diffs.append(entry)

    return {'diffs': diffs, 'matches': matches}


# ============================================================
# 3. Heading Styles 비교
# ============================================================

def compare_heading_styles(styles_ref, styles_gen):
    """Heading1~6 스타일 비교."""
    diffs = []
    matches = []

    def get_heading_props(styles_root, style_id):
        if styles_root is None:
            return None
        for style in styles_root.findall(f'{{{W}}}style'):
            sid = style.get(f'{{{W}}}styleId', '')
            if sid.lower() == style_id.lower():
                props = {}
                # name
                name_el = style.find(f'{{{W}}}name')
                if name_el is not None:
                    props['name'] = _attr(name_el, 'val')

                # rPr
                rPr = style.find(f'{{{W}}}rPr')
                if rPr is not None:
                    rFonts = rPr.find(f'{{{W}}}rFonts')
                    if rFonts is not None:
                        for attr in ['ascii', 'hAnsi', 'eastAsia']:
                            v = rFonts.get(f'{{{W}}}{attr}')
                            if v:
                                props[f'font.{attr}'] = v
                    sz = rPr.find(f'{{{W}}}sz')
                    if sz is not None:
                        props['size'] = _attr(sz, 'val')
                    color = rPr.find(f'{{{W}}}color')
                    if color is not None:
                        props['color'] = (_attr(color, 'val') or '').upper()
                    b_val = _get_bool_prop(rPr, 'b')
                    props['bold'] = _normalize_bool(b_val)
                    i_val = _get_bool_prop(rPr, 'i')
                    props['italic'] = _normalize_bool(i_val)

                # pPr spacing
                pPr = style.find(f'{{{W}}}pPr')
                if pPr is not None:
                    spacing = pPr.find(f'{{{W}}}spacing')
                    if spacing is not None:
                        for attr in ['before', 'after']:
                            v = spacing.get(f'{{{W}}}{attr}')
                            if v:
                                props[f'spacing.{attr}'] = v

                return props
        return None

    for level in range(1, 7):
        style_id = f'Heading{level}'
        p_ref = get_heading_props(styles_ref, style_id)
        p_gen = get_heading_props(styles_gen, style_id)

        if p_ref is None and p_gen is None:
            continue
        if p_ref is None:
            diffs.append({'field': style_id, 'ref': 'MISSING', 'gen': 'EXISTS'})
            continue
        if p_gen is None:
            diffs.append({'field': style_id, 'ref': 'EXISTS', 'gen': 'MISSING'})
            continue

        all_keys = sorted(set(list(p_ref.keys()) + list(p_gen.keys())))
        for k in all_keys:
            vr = p_ref.get(k)
            vg = p_gen.get(k)
            entry = {'field': f'{style_id}.{k}', 'ref': vr, 'gen': vg}
            if vr == vg:
                matches.append(entry)
            else:
                diffs.append(entry)

    return {'diffs': diffs, 'matches': matches}


# ============================================================
# 4. Element Structure 비교
# ============================================================

def _build_element_list(doc_root):
    """문서 body에서 순서대로 요소 목록 생성."""
    body = doc_root.find(f'{{{W}}}body')
    if body is None:
        return []

    elements = []
    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        if tag == 'p':
            style = _get_style(child)
            text = _extract_text(child)
            has_break = _has_page_break(child)
            has_img = _has_image(child)

            if has_img:
                w, h = _get_image_size(child)
                elements.append({
                    'type': 'image',
                    'text': text[:60],
                    'width_pt': w,
                    'height_pt': h,
                    'style': style,
                })
            elif has_break and not text:
                elements.append({'type': 'page_break', 'text': '', 'style': style})
            elif style.lower().startswith('heading'):
                level = 0
                s = style.lower().replace('heading', '').strip()
                try:
                    level = int(s)
                except ValueError:
                    pass
                elements.append({
                    'type': f'heading{level}',
                    'text': text[:80],
                    'style': style,
                })
            elif style == 'ListParagraph' or style.startswith('ListBullet'):
                elements.append({'type': 'bullet', 'text': text[:60], 'style': style})
            elif not text and not has_break:
                elements.append({'type': 'spacer', 'text': '', 'style': style})
            else:
                elements.append({'type': 'paragraph', 'text': text[:80], 'style': style})

                if has_break:
                    elements[-1]['has_page_break'] = True

        elif tag == 'tbl':
            tbl_type = _classify_table(child)
            rows = child.findall(f'{{{W}}}tr')
            first_row = rows[0] if rows else None
            cols = len(first_row.findall(f'{{{W}}}tc')) if first_row is not None else 0

            # Extract header text for data tables
            header_text = ''
            if tbl_type == 'data_table' and first_row is not None:
                cells = first_row.findall(f'{{{W}}}tc')
                hdrs = []
                for tc in cells:
                    ct = []
                    for p in tc.findall(f'{{{W}}}p'):
                        t = _extract_text(p)
                        if t:
                            ct.append(t)
                    hdrs.append('|'.join(ct) if ct else '')
                header_text = '|'.join(hdrs)[:80]

            text_preview = ''
            if tbl_type in ('code_dark', 'code_light'):
                # Get first line of code
                for tr in rows[:1]:
                    for tc in tr.findall(f'{{{W}}}tc'):
                        for p in tc.findall(f'{{{W}}}p'):
                            t = _extract_text(p)
                            if t:
                                text_preview = t[:60]
                                break
            elif tbl_type in ('info_box', 'warning_box'):
                for tr in rows[:1]:
                    for tc in tr.findall(f'{{{W}}}tc'):
                        for p in tc.findall(f'{{{W}}}p'):
                            t = _extract_text(p)
                            if t:
                                text_preview = t[:60]
                                break

            elements.append({
                'type': tbl_type,
                'rows': len(rows),
                'cols': cols,
                'header': header_text,
                'text': text_preview,
            })

        elif tag == 'sectPr':
            pass  # handled separately
        else:
            elements.append({'type': f'unknown:{tag}', 'text': ''})

    return elements


def compare_element_structure(doc_ref, doc_gen):
    """요소 목록 순차 비교."""
    els_ref = _build_element_list(doc_ref)
    els_gen = _build_element_list(doc_gen)

    # Count by type
    def count_by_type(els):
        counts = {}
        for e in els:
            t = e['type']
            counts[t] = counts.get(t, 0) + 1
        return counts

    counts_ref = count_by_type(els_ref)
    counts_gen = count_by_type(els_gen)
    all_types = sorted(set(list(counts_ref.keys()) + list(counts_gen.keys())))

    count_diffs = []
    count_matches = []
    for t in all_types:
        cr = counts_ref.get(t, 0)
        cg = counts_gen.get(t, 0)
        entry = {'type': t, 'ref': cr, 'gen': cg}
        if cr == cg:
            count_matches.append(entry)
        else:
            count_diffs.append(entry)

    # Sequential comparison (LCS-like diff)
    seq_diffs = []
    i, j = 0, 0
    max_report = 50
    while i < len(els_ref) and j < len(els_gen) and len(seq_diffs) < max_report:
        er = els_ref[i]
        eg = els_gen[j]

        if er['type'] == eg['type']:
            # Same type — check details
            if er['type'] == 'data_table':
                if er.get('rows') != eg.get('rows') or er.get('cols') != eg.get('cols'):
                    seq_diffs.append({
                        'index': i,
                        'type': 'table_shape',
                        'ref': f"{er.get('rows')}x{er.get('cols')}",
                        'gen': f"{eg.get('rows')}x{eg.get('cols')}",
                        'header': er.get('header', ''),
                    })
            i += 1
            j += 1
        else:
            # Type mismatch — try to find alignment
            # Look ahead in gen for matching ref element
            found_in_gen = None
            for k in range(j + 1, min(j + 5, len(els_gen))):
                if els_gen[k]['type'] == er['type']:
                    found_in_gen = k
                    break

            found_in_ref = None
            for k in range(i + 1, min(i + 5, len(els_ref))):
                if els_ref[k]['type'] == eg['type']:
                    found_in_ref = k
                    break

            if found_in_gen is not None and (found_in_ref is None or (found_in_gen - j) <= (found_in_ref - i)):
                # Extra elements in gen before match
                for k in range(j, found_in_gen):
                    seq_diffs.append({
                        'index': k,
                        'type': 'extra_in_gen',
                        'element': els_gen[k]['type'],
                        'text': els_gen[k].get('text', ''),
                    })
                j = found_in_gen
            elif found_in_ref is not None:
                # Missing elements in gen
                for k in range(i, found_in_ref):
                    seq_diffs.append({
                        'index': k,
                        'type': 'missing_in_gen',
                        'element': els_ref[k]['type'],
                        'text': els_ref[k].get('text', ''),
                    })
                i = found_in_ref
            else:
                seq_diffs.append({
                    'index': i,
                    'type': 'type_mismatch',
                    'ref': er['type'],
                    'gen': eg['type'],
                    'ref_text': er.get('text', ''),
                    'gen_text': eg.get('text', ''),
                })
                i += 1
                j += 1

    # Remaining elements
    while i < len(els_ref) and len(seq_diffs) < max_report:
        seq_diffs.append({
            'index': i,
            'type': 'missing_in_gen',
            'element': els_ref[i]['type'],
            'text': els_ref[i].get('text', ''),
        })
        i += 1

    while j < len(els_gen) and len(seq_diffs) < max_report:
        seq_diffs.append({
            'index': j,
            'type': 'extra_in_gen',
            'element': els_gen[j]['type'],
            'text': els_gen[j].get('text', ''),
        })
        j += 1

    return {
        'refCount': len(els_ref),
        'genCount': len(els_gen),
        'countDiffs': count_diffs,
        'countMatches': count_matches,
        'sequenceDiffs': seq_diffs,
        '_elements_ref': els_ref,
        '_elements_gen': els_gen,
    }


# ============================================================
# 5. Table Structure 비교
# ============================================================

def _extract_tables(doc_root):
    """문서에서 데이터 테이블만 추출 (특수 블록 제외)."""
    body = doc_root.find(f'{{{W}}}body')
    if body is None:
        return []

    tables = []
    for tbl in body.findall(f'{{{W}}}tbl'):
        tbl_type = _classify_table(tbl)
        if tbl_type != 'data_table':
            continue

        rows = tbl.findall(f'{{{W}}}tr')
        first_row = rows[0] if rows else None
        cols = len(first_row.findall(f'{{{W}}}tc')) if first_row is not None else 0

        # Column widths
        col_widths = []
        if first_row is not None:
            for tc in first_row.findall(f'{{{W}}}tc'):
                tcPr = tc.find(f'{{{W}}}tcPr')
                tcW = _find(tcPr, 'tcW') if tcPr is not None else None
                w = _attr(tcW, 'w') if tcW is not None else None
                col_widths.append(w)

        # Header text
        header_cells = []
        if first_row is not None:
            for tc in first_row.findall(f'{{{W}}}tc'):
                ct = []
                for p in tc.findall(f'{{{W}}}p'):
                    t = _extract_text(p)
                    if t:
                        ct.append(t)
                header_cells.append(' '.join(ct))

        # Header fill colors
        header_fills = []
        if first_row is not None:
            for tc in first_row.findall(f'{{{W}}}tc'):
                tcPr = tc.find(f'{{{W}}}tcPr')
                c = _get_shading_color(tcPr)
                header_fills.append(c)

        # Cell margins (from tblPr)
        tblPr = tbl.find(f'{{{W}}}tblPr')
        cell_margins = {}
        if tblPr is not None:
            cm = tblPr.find(f'{{{W}}}tblCellMar')
            if cm is not None:
                for side in ['top', 'left', 'bottom', 'right', 'start', 'end']:
                    s = cm.find(f'{{{W}}}{side}')
                    if s is not None:
                        cell_margins[side] = _attr(s, 'w')

        # Borders (tblBorders)
        borders = {}
        if tblPr is not None:
            tblBorders = tblPr.find(f'{{{W}}}tblBorders')
            if tblBorders is not None:
                for btype in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
                    b = tblBorders.find(f'{{{W}}}{btype}')
                    if b is not None:
                        borders[btype] = {
                            'val': _attr(b, 'val'),
                            'sz': _attr(b, 'sz'),
                            'color': (_attr(b, 'color') or '').upper(),
                        }

        tables.append({
            'rows': len(rows),
            'cols': cols,
            'colWidths': col_widths,
            'headerCells': header_cells,
            'headerFills': header_fills,
            'cellMargins': cell_margins,
            'borders': borders,
        })

    return tables


def compare_table_structure(doc_ref, doc_gen):
    """데이터 테이블 구조 비교."""
    tbls_ref = _extract_tables(doc_ref)
    tbls_gen = _extract_tables(doc_gen)

    diffs = []
    matches = []

    count_entry = {'field': 'tableCount', 'ref': len(tbls_ref), 'gen': len(tbls_gen)}
    if len(tbls_ref) == len(tbls_gen):
        matches.append(count_entry)
    else:
        diffs.append(count_entry)

    # Compare matched pairs by position
    for idx in range(min(len(tbls_ref), len(tbls_gen))):
        tr = tbls_ref[idx]
        tg = tbls_gen[idx]
        prefix = f'table[{idx}]'
        header_label = '|'.join(tr['headerCells'])[:50]

        for field in ['rows', 'cols']:
            vr = tr[field]
            vg = tg[field]
            entry = {'field': f'{prefix}.{field}', 'ref': vr, 'gen': vg, 'header': header_label}
            if vr == vg:
                matches.append(entry)
            else:
                diffs.append(entry)

        # Column widths
        for ci in range(min(len(tr['colWidths']), len(tg['colWidths']))):
            wr = tr['colWidths'][ci]
            wg = tg['colWidths'][ci]
            entry = {'field': f'{prefix}.colWidth[{ci}]', 'ref': wr, 'gen': wg, 'header': header_label}
            if wr == wg:
                matches.append(entry)
            else:
                diffs.append(entry)

        # Header fills
        for ci in range(min(len(tr['headerFills']), len(tg['headerFills']))):
            fr = tr['headerFills'][ci]
            fg = tg['headerFills'][ci]
            entry = {'field': f'{prefix}.headerFill[{ci}]', 'ref': fr, 'gen': fg, 'header': header_label}
            if fr == fg:
                matches.append(entry)
            else:
                diffs.append(entry)

        # Cell margins
        all_mar_keys = sorted(set(list(tr['cellMargins'].keys()) + list(tg['cellMargins'].keys())))
        for k in all_mar_keys:
            vr = tr['cellMargins'].get(k)
            vg = tg['cellMargins'].get(k)
            entry = {'field': f'{prefix}.cellMargin.{k}', 'ref': vr, 'gen': vg, 'header': header_label}
            if vr == vg:
                matches.append(entry)
            else:
                diffs.append(entry)

        # Borders
        all_border_keys = sorted(set(list(tr['borders'].keys()) + list(tg['borders'].keys())))
        for bk in all_border_keys:
            br = tr['borders'].get(bk, {})
            bg = tg['borders'].get(bk, {})
            if isinstance(br, dict) and isinstance(bg, dict):
                for prop in ['val', 'sz', 'color']:
                    vr = br.get(prop)
                    vg = bg.get(prop)
                    entry = {'field': f'{prefix}.border.{bk}.{prop}', 'ref': vr, 'gen': vg, 'header': header_label}
                    if vr == vg:
                        matches.append(entry)
                    else:
                        diffs.append(entry)
            else:
                entry = {'field': f'{prefix}.border.{bk}', 'ref': str(br), 'gen': str(bg), 'header': header_label}
                diffs.append(entry)

    return {'diffs': diffs, 'matches': matches}


# ============================================================
# 6. Run Properties 비교 (per-element)
# ============================================================

def _extract_run_props(p_element):
    """단락의 첫 번째 런에서 속성 추출."""
    runs = p_element.findall(f'{{{W}}}r')
    if not runs:
        return None

    # Use first non-empty run
    for r in runs:
        text = ''
        for t in r.findall(f'{{{W}}}t'):
            if t.text:
                text += t.text
        if not text.strip():
            continue

        rPr = r.find(f'{{{W}}}rPr')
        props = {}
        if rPr is not None:
            rFonts = rPr.find(f'{{{W}}}rFonts')
            if rFonts is not None:
                for attr in ['ascii', 'hAnsi', 'eastAsia']:
                    v = rFonts.get(f'{{{W}}}{attr}')
                    if v:
                        props[f'font.{attr}'] = v
            sz = rPr.find(f'{{{W}}}sz')
            if sz is not None:
                props['size'] = _attr(sz, 'val')
            color = rPr.find(f'{{{W}}}color')
            if color is not None:
                props['color'] = (_attr(color, 'val') or '').upper()
            b_val = _get_bool_prop(rPr, 'b')
            props['bold'] = _normalize_bool(b_val)
            i_val = _get_bool_prop(rPr, 'i')
            props['italic'] = _normalize_bool(i_val)
        return props

    return None


def compare_run_properties(doc_ref, doc_gen):
    """요소별 런 속성 비교 (순차 매칭)."""
    diffs = []

    body_ref = doc_ref.find(f'{{{W}}}body')
    body_gen = doc_gen.find(f'{{{W}}}body')
    if body_ref is None or body_gen is None:
        return {'diffs': diffs}

    paras_ref = body_ref.findall(f'{{{W}}}p')
    paras_gen = body_gen.findall(f'{{{W}}}p')

    max_compare = min(len(paras_ref), len(paras_gen))
    max_report = 40

    for idx in range(max_compare):
        if len(diffs) >= max_report:
            break

        pr = paras_ref[idx]
        pg = paras_gen[idx]

        style_r = _get_style(pr)
        style_g = _get_style(pg)

        # Only compare if same type
        if style_r != style_g:
            continue

        rp_ref = _extract_run_props(pr)
        rp_gen = _extract_run_props(pg)

        if rp_ref is None or rp_gen is None:
            continue

        text_ref = _extract_text(pr)[:50]

        all_keys = sorted(set(list(rp_ref.keys()) + list(rp_gen.keys())))
        for k in all_keys:
            vr = rp_ref.get(k)
            vg = rp_gen.get(k)
            if vr != vg:
                diffs.append({
                    'elementIndex': idx,
                    'style': style_r,
                    'text': text_ref,
                    'property': k,
                    'ref': vr,
                    'gen': vg,
                })

    return {'diffs': diffs, 'refParagraphs': len(paras_ref), 'genParagraphs': len(paras_gen)}


# ============================================================
# 7. Spacing 비교
# ============================================================

def compare_spacing(doc_ref, doc_gen):
    """단락 간격 비교 + spacer 감지."""
    diffs = []

    body_ref = doc_ref.find(f'{{{W}}}body')
    body_gen = doc_gen.find(f'{{{W}}}body')
    if body_ref is None or body_gen is None:
        return {'diffs': diffs}

    def extract_spacing_list(body):
        result = []
        for p in body.findall(f'{{{W}}}p'):
            style = _get_style(p)
            text = _extract_text(p)
            pPr = p.find(f'{{{W}}}pPr')
            spacing_before = None
            spacing_after = None
            spacing_line = None
            if pPr is not None:
                sp = pPr.find(f'{{{W}}}spacing')
                if sp is not None:
                    spacing_before = sp.get(f'{{{W}}}before')
                    spacing_after = sp.get(f'{{{W}}}after')
                    spacing_line = sp.get(f'{{{W}}}line')
            is_spacer = not text and not _has_page_break(p)
            result.append({
                'style': style,
                'text': text[:50],
                'before': spacing_before,
                'after': spacing_after,
                'line': spacing_line,
                'isSpacer': is_spacer,
            })
        return result

    sp_ref = extract_spacing_list(body_ref)
    sp_gen = extract_spacing_list(body_gen)

    # Count spacers
    spacer_ref = sum(1 for s in sp_ref if s['isSpacer'])
    spacer_gen = sum(1 for s in sp_gen if s['isSpacer'])
    if spacer_ref != spacer_gen:
        diffs.append({
            'type': 'spacer_count',
            'ref': spacer_ref,
            'gen': spacer_gen,
        })

    # Compare matched paragraphs spacing
    max_compare = min(len(sp_ref), len(sp_gen))
    max_report = 30
    for idx in range(max_compare):
        if len(diffs) >= max_report:
            break
        sr = sp_ref[idx]
        sg = sp_gen[idx]
        if sr['style'] != sg['style']:
            continue
        for prop in ['before', 'after', 'line']:
            vr = sr[prop]
            vg = sg[prop]
            if vr != vg:
                diffs.append({
                    'type': 'spacing_diff',
                    'elementIndex': idx,
                    'style': sr['style'],
                    'text': sr['text'],
                    'property': prop,
                    'ref': vr,
                    'gen': vg,
                })

    return {
        'diffs': diffs,
        'refSpacers': spacer_ref,
        'genSpacers': spacer_gen,
        'refParagraphs': len(sp_ref),
        'genParagraphs': len(sp_gen),
    }


# ============================================================
# 전체 비교 실행
# ============================================================

def compare_docx(ref_path, gen_path):
    """두 DOCX 파일 전체 비교."""
    z_ref, doc_ref, styles_ref = open_docx(ref_path)
    z_gen, doc_gen, styles_gen = open_docx(gen_path)

    try:
        results = {}
        results['pageSetup'] = compare_page_setup(doc_ref, doc_gen)
        results['docDefaults'] = compare_doc_defaults(styles_ref, styles_gen)
        results['headingStyles'] = compare_heading_styles(styles_ref, styles_gen)
        results['elementStructure'] = compare_element_structure(doc_ref, doc_gen)
        results['tableStructure'] = compare_table_structure(doc_ref, doc_gen)
        results['runProperties'] = compare_run_properties(doc_ref, doc_gen)
        results['spacing'] = compare_spacing(doc_ref, doc_gen)

        # Summary
        total_diffs = 0
        by_category = {}
        for cat, data in results.items():
            if cat.startswith('_'):
                continue
            count = 0
            if 'diffs' in data:
                count = len(data['diffs'])
            elif 'countDiffs' in data:
                count = len(data.get('countDiffs', [])) + len(data.get('sequenceDiffs', []))
            total_diffs += count
            by_category[cat] = count

        results['summary'] = {
            'totalDiffs': total_diffs,
            'byCategory': by_category,
            'refFile': os.path.basename(ref_path),
            'genFile': os.path.basename(gen_path),
        }

        return results
    finally:
        z_ref.close()
        z_gen.close()


# ============================================================
# 텍스트 출력
# ============================================================

def _icon(is_match):
    return 'OK' if is_match else 'DIFF'


def format_text_report(results):
    """결과를 텍스트 리포트로 포맷."""
    lines = []
    summary = results['summary']
    lines.append('=== DOCX Comparison Report ===')
    lines.append(f'  REF: {summary["refFile"]}')
    lines.append(f'  GEN: {summary["genFile"]}')
    lines.append('')

    # Page Setup
    lines.append('[Page Setup]')
    ps = results['pageSetup']
    for m in ps['matches']:
        lines.append(f'  OK    {m["field"]}: {m["ref"]}')
    for d in ps['diffs']:
        lines.append(f'  DIFF  {d["field"]}: REF={d["ref"]} vs GEN={d["gen"]}')
    lines.append('')

    # Doc Defaults
    lines.append('[Document Defaults]')
    dd = results['docDefaults']
    for m in dd['matches']:
        lines.append(f'  OK    {m["field"]}: {m["ref"]}')
    for d in dd['diffs']:
        lines.append(f'  DIFF  {d["field"]}: REF={d["ref"]} vs GEN={d["gen"]}')
    lines.append('')

    # Heading Styles
    lines.append('[Heading Styles]')
    hs = results['headingStyles']
    for m in hs['matches']:
        lines.append(f'  OK    {m["field"]}: {m["ref"]}')
    for d in hs['diffs']:
        lines.append(f'  DIFF  {d["field"]}: REF={d["ref"]} vs GEN={d["gen"]}')
    lines.append('')

    # Element Structure
    lines.append('[Element Structure]')
    es = results['elementStructure']
    lines.append(f'  REF: {es["refCount"]} elements, GEN: {es["genCount"]} elements')
    if es['countDiffs']:
        lines.append('  Type count differences:')
        for d in es['countDiffs']:
            lines.append(f'    {d["type"]}: REF={d["ref"]} vs GEN={d["gen"]}')
    if es['sequenceDiffs']:
        lines.append(f'  Sequence differences ({len(es["sequenceDiffs"])}):')
        for d in es['sequenceDiffs'][:20]:
            dt = d['type']
            if dt == 'missing_in_gen':
                lines.append(f'    [{d["index"]}] MISSING: {d["element"]} "{d.get("text", "")}"')
            elif dt == 'extra_in_gen':
                lines.append(f'    [{d["index"]}] EXTRA:   {d["element"]} "{d.get("text", "")}"')
            elif dt == 'type_mismatch':
                lines.append(f'    [{d["index"]}] MISMATCH: REF={d["ref"]} vs GEN={d["gen"]}')
            elif dt == 'table_shape':
                lines.append(f'    [{d["index"]}] TABLE SHAPE: REF={d["ref"]} vs GEN={d["gen"]} ({d.get("header", "")})')
        if len(es['sequenceDiffs']) > 20:
            lines.append(f'    ... and {len(es["sequenceDiffs"]) - 20} more')
    lines.append('')

    # Table Structure
    lines.append('[Table Structure]')
    ts = results['tableStructure']
    for m in ts['matches']:
        extra = f' ({m["header"]})' if m.get('header') else ''
        lines.append(f'  OK    {m["field"]}: {m["ref"]}{extra}')
    for d in ts['diffs']:
        extra = f' ({d["header"]})' if d.get('header') else ''
        lines.append(f'  DIFF  {d["field"]}: REF={d["ref"]} vs GEN={d["gen"]}{extra}')
    lines.append('')

    # Run Properties
    lines.append('[Run Properties]')
    rp = results['runProperties']
    lines.append(f'  REF paragraphs: {rp.get("refParagraphs", "?")}, GEN paragraphs: {rp.get("genParagraphs", "?")}')
    if rp['diffs']:
        lines.append(f'  Differences ({len(rp["diffs"])}):')
        for d in rp['diffs'][:20]:
            lines.append(f'    [{d["elementIndex"]}] {d["style"]} "{d["text"]}" — {d["property"]}: REF={d["ref"]} vs GEN={d["gen"]}')
        if len(rp['diffs']) > 20:
            lines.append(f'    ... and {len(rp["diffs"]) - 20} more')
    else:
        lines.append('  No run property differences found.')
    lines.append('')

    # Spacing
    lines.append('[Spacing]')
    sp = results['spacing']
    lines.append(f'  REF spacers: {sp.get("refSpacers", "?")}, GEN spacers: {sp.get("genSpacers", "?")}')
    if sp['diffs']:
        lines.append(f'  Differences ({len(sp["diffs"])}):')
        for d in sp['diffs'][:20]:
            if d['type'] == 'spacer_count':
                lines.append(f'    Spacer count: REF={d["ref"]} vs GEN={d["gen"]}')
            else:
                lines.append(f'    [{d.get("elementIndex", "?")}] {d.get("style", "")} "{d.get("text", "")}" — {d.get("property", "")}: REF={d.get("ref")} vs GEN={d.get("gen")}')
        if len(sp['diffs']) > 20:
            lines.append(f'    ... and {len(sp["diffs"]) - 20} more')
    else:
        lines.append('  No spacing differences found.')
    lines.append('')

    # Summary
    lines.append('[Summary]')
    lines.append(f'  Total differences: {summary["totalDiffs"]}')
    cats = ', '.join(f'{k}={v}' for k, v in summary['byCategory'].items() if v > 0)
    lines.append(f'  By category: {cats if cats else "(none)"}')

    return '\n'.join(lines)


def format_json_output(results):
    """결과를 JSON으로 포맷 (내부 요소 목록 제거)."""
    output = {}
    for k, v in results.items():
        if k == 'elementStructure':
            # Remove internal element lists
            output[k] = {kk: vv for kk, vv in v.items() if not kk.startswith('_')}
        else:
            output[k] = v
    return output


# ============================================================
# CLI
# ============================================================

def main():
    args = sys.argv[1:]
    use_json = '--json' in args
    args = [a for a in args if a != '--json']

    if len(args) < 2:
        print('Usage: python -X utf8 tools/diff-docx.py <reference.docx> <generated.docx> [--json]')
        print('')
        print('Compare two DOCX files at XML level:')
        print('  - Page setup, document defaults, heading styles')
        print('  - Element structure (sequential + count)')
        print('  - Table structure (widths, borders, fills)')
        print('  - Run properties (font, size, color, bold)')
        print('  - Spacing (before/after, spacers)')
        sys.exit(1)

    ref_path = args[0]
    gen_path = args[1]

    try:
        results = compare_docx(ref_path, gen_path)
    except FileNotFoundError as e:
        if use_json:
            print(json.dumps({'error': str(e)}, ensure_ascii=False))
        else:
            print(f'ERROR: {e}')
        sys.exit(1)
    except zipfile.BadZipFile as e:
        if use_json:
            print(json.dumps({'error': f'Invalid DOCX: {e}'}, ensure_ascii=False))
        else:
            print(f'ERROR: Invalid DOCX file — {e}')
        sys.exit(1)

    if use_json:
        output = format_json_output(results)
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(format_text_report(results))


if __name__ == '__main__':
    main()

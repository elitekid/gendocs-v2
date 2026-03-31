#!/usr/bin/env python3
"""
DOCX 스타일 명세 추출 스크립트 (ZIP + XML 방식)

레퍼런스 DOCX 파일에서 페이지 설정, 폰트, 색상, 간격, 테이블 스타일 등
문서 스타일 명세를 종합적으로 추출합니다. 커스텀 converter 작성 전에 사용합니다.

사용법: python -X utf8 tools/extract-docx-spec.py output/문서.docx
        python -X utf8 tools/extract-docx-spec.py output/문서.docx --json
"""

import sys
import os
import io
import json
import argparse
import zipfile
import xml.etree.ElementTree as ET

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
EMU_TO_PT = 1 / 12700  # EMU → pt

# Known paper sizes (width x height in DXA, portrait orientation)
PAPER_SIZES = {
    (12240, 15840): 'US Letter',
    (15840, 12240): 'US Letter (landscape)',
    (11906, 16838): 'A4',
    (16838, 11906): 'A4 (landscape)',
    (12242, 15842): 'US Letter',  # rounding variants
    (11907, 16839): 'A4',
}


# ============================================================
# XML 파싱 유틸리티
# ============================================================

def _attr(el, attr_name):
    """w: 네임스페이스 속성 값 추출 (없으면 None)"""
    if el is None:
        return None
    return el.get(f'{{{W}}}{attr_name}')


def _int_attr(el, attr_name, default=None):
    """w: 네임스페이스 정수 속성 값 추출"""
    v = _attr(el, attr_name)
    if v is None:
        return default
    try:
        return int(v)
    except (ValueError, TypeError):
        return default


def _find(el, *path):
    """w: 네임스페이스 경로로 하위 요소 탐색"""
    cur = el
    for p in path:
        if cur is None:
            return None
        cur = cur.find(f'{{{W}}}{p}')
    return cur


def _extract_text(element):
    """w:p 요소에서 텍스트 추출"""
    texts = []
    for t in element.iter(f'{{{W}}}t'):
        if t.text:
            texts.append(t.text)
    return ''.join(texts).strip()


def _get_paragraph_style(p):
    """w:p 요소에서 스타일명 추출"""
    pPr = p.find(f'{{{W}}}pPr')
    if pPr is not None:
        pStyle = pPr.find(f'{{{W}}}pStyle')
        if pStyle is not None:
            return pStyle.get(f'{{{W}}}val', '')
    return ''


def _get_heading_level(style_name):
    """스타일명에서 제목 레벨 추출. 제목이 아니면 0"""
    if not style_name:
        return 0
    s = style_name.lower().replace(' ', '')
    if s.startswith('heading'):
        try:
            return int(s[7:])
        except (ValueError, IndexError):
            return 0
    return 0


def _parse_xml_from_zip(z, path):
    """ZIP 내 XML 파일 파싱. 없으면 None"""
    if path not in z.namelist():
        return None
    try:
        return ET.parse(z.open(path)).getroot()
    except Exception:
        return None


def _parse_borders(border_el):
    """w:tblBorders 또는 w:tcBorders에서 테두리 정보 추출"""
    if border_el is None:
        return None
    borders = {}
    for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b = border_el.find(f'{{{W}}}{side}')
        if b is not None:
            entry = {}
            val = _attr(b, 'val')
            if val:
                entry['style'] = val
            sz = _int_attr(b, 'sz')
            if sz is not None:
                entry['size'] = sz
            color = _attr(b, 'color')
            if color:
                entry['color'] = color
            space = _int_attr(b, 'space')
            if space is not None:
                entry['space'] = space
            if entry:
                borders[side] = entry
    return borders if borders else None


def _parse_cell_margins(margins_el):
    """w:tblCellMar에서 셀 마진 추출 (DXA)"""
    if margins_el is None:
        return None
    result = {}
    for side in ('top', 'start', 'left', 'bottom', 'end', 'right'):
        m = margins_el.find(f'{{{W}}}{side}')
        if m is not None:
            w_val = _int_attr(m, 'w')
            if w_val is not None:
                # normalize start→left, end→right
                key = side
                if side == 'start':
                    key = 'left'
                elif side == 'end':
                    key = 'right'
                result[key] = w_val
    return result if result else None


# ============================================================
# 1. Page Setup
# ============================================================

def extract_page_setup(doc_root):
    """word/document.xml의 w:sectPr에서 페이지 설정 추출"""
    body = doc_root.find(f'{{{W}}}body')
    if body is None:
        return None

    sect_pr = body.find(f'{{{W}}}sectPr')
    if sect_pr is None:
        # 마지막 자식에서 찾기
        for child in reversed(list(body)):
            sect_pr = child.find(f'{{{W}}}sectPr')
            if sect_pr is not None:
                break
    if sect_pr is None:
        return None

    result = {}

    # Page size
    pg_sz = sect_pr.find(f'{{{W}}}pgSz')
    if pg_sz is not None:
        w = _int_attr(pg_sz, 'w')
        h = _int_attr(pg_sz, 'h')
        orient = _attr(pg_sz, 'orient')
        if w is not None:
            result['width'] = w
        if h is not None:
            result['height'] = h
        # Dimensions take precedence over orient attribute (DOCX may have mismatched orient)
        if w and h:
            result['orientation'] = 'landscape' if w > h else 'portrait'
        elif orient:
            result['orientation'] = orient
        else:
            result['orientation'] = 'unknown'

        # Paper size name
        if w and h:
            key = (w, h)
            if key in PAPER_SIZES:
                result['paperSize'] = PAPER_SIZES[key]
            else:
                # Try with portrait normalization
                portrait_key = (min(w, h), max(w, h))
                for pk, pn in PAPER_SIZES.items():
                    if (min(pk[0], pk[1]), max(pk[0], pk[1])) == portrait_key:
                        result['paperSize'] = pn.replace(' (landscape)', '')
                        break
                else:
                    result['paperSize'] = f'Custom ({w}x{h} DXA)'

        # DXA to mm for readability (1 inch = 1440 DXA, 1 inch = 25.4 mm)
        if w and h:
            result['widthMm'] = round(w / 1440 * 25.4, 1)
            result['heightMm'] = round(h / 1440 * 25.4, 1)

    # Margins
    pg_mar = sect_pr.find(f'{{{W}}}pgMar')
    if pg_mar is not None:
        margins = {}
        for side in ('top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'):
            v = _int_attr(pg_mar, side)
            if v is not None:
                margins[side] = v
        if margins:
            result['margins'] = margins

    # Header/footer references
    for ref_type, tag in [('headerRef', 'headerReference'), ('footerRef', 'footerReference')]:
        refs = sect_pr.findall(f'{{{W}}}{tag}')
        if refs:
            ref_list = []
            for ref in refs:
                ref_list.append({
                    'type': _attr(ref, 'type') or 'default',
                    'rId': ref.get(f'{{{R}}}id', '')
                })
            result[ref_type] = ref_list

    # Columns
    cols = sect_pr.find(f'{{{W}}}cols')
    if cols is not None:
        num = _int_attr(cols, 'num')
        if num and num > 1:
            result['columns'] = num

    return result


# ============================================================
# 2. Document Defaults
# ============================================================

def extract_doc_defaults(styles_root):
    """word/styles.xml의 w:docDefaults에서 기본 스타일 추출"""
    if styles_root is None:
        return None

    doc_defaults = styles_root.find(f'{{{W}}}docDefaults')
    if doc_defaults is None:
        return None

    result = {}

    # Run defaults (rPrDefault)
    rpr_default = _find(doc_defaults, 'rPrDefault', 'rPr')
    if rpr_default is not None:
        # Font
        rfonts = rpr_default.find(f'{{{W}}}rFonts')
        if rfonts is not None:
            fonts = {}
            for attr in ('ascii', 'eastAsia', 'hAnsi', 'cs'):
                v = _attr(rfonts, attr)
                if v:
                    fonts[attr] = v
            if fonts:
                result['font'] = fonts.get('ascii') or fonts.get('hAnsi') or next(iter(fonts.values()))
                result['fontDetails'] = fonts

        # Size
        sz = rpr_default.find(f'{{{W}}}sz')
        if sz is not None:
            v = _int_attr(sz, 'val')
            if v:
                result['fontSize'] = v  # half-points
                result['fontSizePt'] = v / 2

        sz_cs = rpr_default.find(f'{{{W}}}szCs')
        if sz_cs is not None:
            v = _int_attr(sz_cs, 'val')
            if v:
                result['fontSizeCs'] = v

        # Language
        lang = rpr_default.find(f'{{{W}}}lang')
        if lang is not None:
            langs = {}
            for attr in ('val', 'eastAsia', 'bidi'):
                v = _attr(lang, attr)
                if v:
                    langs[attr] = v
            if langs:
                result['language'] = langs

    # Paragraph defaults (pPrDefault)
    ppr_default = _find(doc_defaults, 'pPrDefault', 'pPr')
    if ppr_default is not None:
        spacing = ppr_default.find(f'{{{W}}}spacing')
        if spacing is not None:
            sp = {}
            for attr in ('before', 'after', 'line', 'lineRule'):
                v = _attr(spacing, attr)
                if v is not None:
                    try:
                        sp[attr] = int(v)
                    except ValueError:
                        sp[attr] = v
            if sp:
                result['paragraphSpacing'] = sp

    return result


# ============================================================
# 3. Heading Styles
# ============================================================

def extract_heading_styles(styles_root):
    """word/styles.xml에서 Heading1~6 스타일 추출"""
    if styles_root is None:
        return None

    result = {}

    for style_el in styles_root.findall(f'{{{W}}}style'):
        style_id = style_el.get(f'{{{W}}}styleId', '')
        style_type = style_el.get(f'{{{W}}}type', '')

        if style_type != 'paragraph':
            continue

        level = _get_heading_level(style_id)
        if level == 0:
            continue

        heading = {'styleId': style_id}

        # Display name
        name_el = style_el.find(f'{{{W}}}name')
        if name_el is not None:
            heading['name'] = _attr(name_el, 'val') or ''

        # Based on
        based_on = style_el.find(f'{{{W}}}basedOn')
        if based_on is not None:
            heading['basedOn'] = _attr(based_on, 'val') or ''

        # Outline level
        pPr = style_el.find(f'{{{W}}}pPr')
        if pPr is not None:
            outline = pPr.find(f'{{{W}}}outlineLvl')
            if outline is not None:
                heading['outlineLevel'] = _int_attr(outline, 'val')

            # Spacing
            spacing = pPr.find(f'{{{W}}}spacing')
            if spacing is not None:
                sp = {}
                for attr in ('before', 'after', 'line', 'lineRule'):
                    v = _attr(spacing, attr)
                    if v is not None:
                        try:
                            sp[attr] = int(v)
                        except ValueError:
                            sp[attr] = v
                if sp:
                    heading['spacing'] = sp

            # Keep next/with next
            if pPr.find(f'{{{W}}}keepNext') is not None:
                heading['keepNext'] = True
            if pPr.find(f'{{{W}}}keepLines') is not None:
                heading['keepLines'] = True

        # Run properties
        rPr = style_el.find(f'{{{W}}}rPr')
        if rPr is not None:
            # Font
            rfonts = rPr.find(f'{{{W}}}rFonts')
            if rfonts is not None:
                fonts = {}
                for attr in ('ascii', 'eastAsia', 'hAnsi', 'cs'):
                    v = _attr(rfonts, attr)
                    if v:
                        fonts[attr] = v
                if fonts:
                    heading['font'] = fonts.get('ascii') or fonts.get('hAnsi') or next(iter(fonts.values()))
                    if len(fonts) > 1:
                        heading['fontDetails'] = fonts

            # Size
            sz = rPr.find(f'{{{W}}}sz')
            if sz is not None:
                v = _int_attr(sz, 'val')
                if v:
                    heading['size'] = v
                    heading['sizePt'] = v / 2

            # Color
            color = rPr.find(f'{{{W}}}color')
            if color is not None:
                c = _attr(color, 'val')
                if c:
                    heading['color'] = c

            # Bold
            bold = rPr.find(f'{{{W}}}b')
            if bold is not None:
                val = _attr(bold, 'val')
                heading['bold'] = val != '0' and val != 'false'
            else:
                # Headings are typically bold by default
                heading['bold'] = True

            # Italic
            italic = rPr.find(f'{{{W}}}i')
            if italic is not None:
                val = _attr(italic, 'val')
                heading['italic'] = val != '0' and val != 'false'

            # Caps
            caps = rPr.find(f'{{{W}}}caps')
            if caps is not None:
                heading['caps'] = True

        key = f'Heading{level}'
        result[key] = heading

    return result if result else None


# ============================================================
# 4. Element Inventory
# ============================================================

def extract_element_inventory(doc_root):
    """word/document.xml에서 요소 인벤토리 추출"""
    body = doc_root.find(f'{{{W}}}body')
    if body is None:
        return None

    headings = {}
    tables = []
    paragraphs = 0
    list_items = 0
    images = 0
    page_breaks = 0
    empty_paragraphs = 0

    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        if tag == 'p':
            text = _extract_text(child)
            style = _get_paragraph_style(child)
            level = _get_heading_level(style)

            # Page break
            for br in child.iter(f'{{{W}}}br'):
                if br.get(f'{{{W}}}type') == 'page':
                    page_breaks += 1

            # Image
            has_image = False
            for drawing in child.iter(f'{{{W}}}drawing'):
                has_image = True
                images += 1

            if level > 0 and text:
                key = f'h{level}'
                headings[key] = headings.get(key, 0) + 1
            elif style and style.lower().startswith('list'):
                list_items += 1
            elif text:
                paragraphs += 1
            elif not has_image:
                empty_paragraphs += 1

        elif tag == 'tbl':
            tbl_info = _extract_table_info(child)
            tables.append(tbl_info)

    result = {
        'headings': headings,
        'totalHeadings': sum(headings.values()),
        'tables': tables,
        'totalTables': len(tables),
        'paragraphs': paragraphs,
        'listItems': list_items,
        'images': images,
        'pageBreaks': page_breaks,
        'emptyParagraphs': empty_paragraphs,
    }

    return result


def _extract_table_info(tbl):
    """단일 테이블의 상세 정보 추출"""
    rows = list(tbl.findall(f'{{{W}}}tr'))
    row_count = len(rows)

    # Column count and widths from first row
    col_count = 0
    col_widths = []
    if rows:
        first_row_cells = rows[0].findall(f'{{{W}}}tc')
        col_count = len(first_row_cells)
        for tc in first_row_cells:
            tc_pr = tc.find(f'{{{W}}}tcPr')
            if tc_pr is not None:
                tc_w = tc_pr.find(f'{{{W}}}tcW')
                if tc_w is not None:
                    w_val = _int_attr(tc_w, 'w')
                    w_type = _attr(tc_w, 'type') or 'dxa'
                    col_widths.append({'width': w_val, 'type': w_type})
                else:
                    col_widths.append(None)
            else:
                col_widths.append(None)

    # Header row text
    header_text = []
    if rows:
        for tc in rows[0].findall(f'{{{W}}}tc'):
            cell_texts = []
            for p in tc.findall(f'{{{W}}}p'):
                t = _extract_text(p)
                if t:
                    cell_texts.append(t)
            header_text.append(' '.join(cell_texts))

    # Shading colors (first row = header, detect body alt rows)
    shading_colors = set()
    header_fill = None
    body_fills = set()
    for i, tr in enumerate(rows):
        for tc in tr.findall(f'{{{W}}}tc'):
            tc_pr = tc.find(f'{{{W}}}tcPr')
            if tc_pr is not None:
                shd = tc_pr.find(f'{{{W}}}shd')
                if shd is not None:
                    fill = _attr(shd, 'fill')
                    if fill and fill.upper() != 'AUTO':
                        shading_colors.add(fill.upper())
                        if i == 0:
                            header_fill = fill.upper()
                        else:
                            body_fills.add(fill.upper())

    # Cell margins (from tblPr)
    tbl_pr = tbl.find(f'{{{W}}}tblPr')
    cell_margins = None
    tbl_borders = None
    if tbl_pr is not None:
        cell_margins = _parse_cell_margins(tbl_pr.find(f'{{{W}}}tblCellMar'))
        tbl_borders = _parse_borders(tbl_pr.find(f'{{{W}}}tblBorders'))

    # Classify table type by shading
    table_type = 'data'
    if col_count == 1 and shading_colors:
        colors = list(shading_colors)
        for c in colors:
            cl = c.upper()
            if cl in ('1E1E1E', '2D2D2D', '1E1F1E'):
                table_type = 'codeBlock_dark'
                break
            elif cl in ('F5F5F5', 'F0F0F0', 'EFEFEF'):
                table_type = 'codeBlock_light'
                break
            elif cl in ('E8F0F7', 'E8EFF7', 'DBE5F1'):
                table_type = 'infoBox'
                break
            elif cl in ('FEF6E6', 'FFF4E6', 'FDF2E6'):
                table_type = 'warningBox'
                break

    info = {
        'rowCount': row_count,
        'colCount': col_count,
        'headerText': header_text,
        'type': table_type,
    }

    if col_widths:
        # Filter None values
        widths_dxa = [cw['width'] for cw in col_widths if cw and cw.get('width')]
        if widths_dxa:
            info['colWidthsDxa'] = widths_dxa

    if header_fill:
        info['headerFill'] = header_fill
    if body_fills:
        info['bodyFills'] = sorted(body_fills)
    if cell_margins:
        info['cellMargins'] = cell_margins
    if tbl_borders:
        info['tableBorders'] = tbl_borders

    return info


# ============================================================
# 5. Spacing Patterns
# ============================================================

def extract_spacing_patterns(doc_root):
    """문서 내 간격 패턴 분석"""
    body = doc_root.find(f'{{{W}}}body')
    if body is None:
        return None

    spacing_combos = {}  # (before, after, line) → count
    spacer_paragraphs = 0  # empty paragraphs with only spacing

    for p in body.iter(f'{{{W}}}p'):
        text = _extract_text(p)
        style = _get_paragraph_style(p)
        level = _get_heading_level(style)

        pPr = p.find(f'{{{W}}}pPr')
        if pPr is None:
            continue

        spacing = pPr.find(f'{{{W}}}spacing')
        if spacing is None:
            continue

        before = _int_attr(spacing, 'before')
        after = _int_attr(spacing, 'after')
        line = _int_attr(spacing, 'line')

        # Spacer detection: empty paragraph with spacing
        if not text and not level:
            if before or after:
                spacer_paragraphs += 1

        key = (before, after, line)
        context = 'heading' if level > 0 else ('body' if text else 'empty')
        combo_key = f'{context}:{before or 0},{after or 0},{line or 0}'
        spacing_combos[combo_key] = spacing_combos.get(combo_key, 0) + 1

    # Sort by frequency
    sorted_combos = sorted(spacing_combos.items(), key=lambda x: -x[1])

    patterns = []
    for combo, count in sorted_combos:
        context, vals = combo.split(':', 1)
        before, after, line = vals.split(',')
        patterns.append({
            'context': context,
            'before': int(before),
            'after': int(after),
            'line': int(line),
            'count': count,
        })

    return {
        'patterns': patterns,
        'spacerParagraphs': spacer_paragraphs,
    }


# ============================================================
# 6. Table Styles (from styles.xml)
# ============================================================

def extract_table_styles(styles_root):
    """word/styles.xml에서 테이블 스타일 추출"""
    if styles_root is None:
        return None

    result = []

    for style_el in styles_root.findall(f'{{{W}}}style'):
        style_type = style_el.get(f'{{{W}}}type', '')
        if style_type != 'table':
            continue

        style_id = style_el.get(f'{{{W}}}styleId', '')
        name_el = style_el.find(f'{{{W}}}name')
        name = _attr(name_el, 'val') if name_el is not None else style_id

        info = {'styleId': style_id, 'name': name}

        # Table properties
        tbl_pr = style_el.find(f'{{{W}}}tblPr')
        if tbl_pr is not None:
            borders = _parse_borders(tbl_pr.find(f'{{{W}}}tblBorders'))
            if borders:
                info['borders'] = borders

            cell_mar = _parse_cell_margins(tbl_pr.find(f'{{{W}}}tblCellMar'))
            if cell_mar:
                info['cellMargins'] = cell_mar

        # Conditional formats (firstRow, etc.)
        conditionals = {}
        for tc_style in style_el.findall(f'{{{W}}}tblStylePr'):
            cond_type = _attr(tc_style, 'type')
            if not cond_type:
                continue

            cond = {}
            # Run properties (font, color, bold)
            rPr = tc_style.find(f'{{{W}}}rPr')
            if rPr is not None:
                bold = rPr.find(f'{{{W}}}b')
                if bold is not None:
                    cond['bold'] = True
                color = rPr.find(f'{{{W}}}color')
                if color is not None:
                    c = _attr(color, 'val')
                    if c:
                        cond['fontColor'] = c

            # Table cell properties (fill)
            tc_pr = tc_style.find(f'{{{W}}}tcPr')
            if tc_pr is not None:
                shd = tc_pr.find(f'{{{W}}}shd')
                if shd is not None:
                    fill = _attr(shd, 'fill')
                    if fill:
                        cond['fill'] = fill.upper()
                borders = _parse_borders(tc_pr.find(f'{{{W}}}tcBorders'))
                if borders:
                    cond['borders'] = borders

            if cond:
                conditionals[cond_type] = cond

        if conditionals:
            info['conditionalFormats'] = conditionals

        result.append(info)

    return result if result else None


# ============================================================
# 7. Run Properties Summary
# ============================================================

def extract_run_properties(doc_root):
    """문서 내 모든 런의 폰트/크기/색상/볼드 조합을 컨텍스트별 분류"""
    body = doc_root.find(f'{{{W}}}body')
    if body is None:
        return None

    # Collect runs grouped by context
    context_runs = {
        'heading': {},
        'tableHeader': {},
        'tableBody': {},
        'codeBlock': {},
        'bodyText': {},
        'listItem': {},
    }

    def _process_runs(element, context):
        for r in element.findall(f'{{{W}}}r'):
            rPr = r.find(f'{{{W}}}rPr')
            t = r.find(f'{{{W}}}t')
            if t is None or not t.text or not t.text.strip():
                continue

            props = {}

            if rPr is not None:
                # Font
                rfonts = rPr.find(f'{{{W}}}rFonts')
                if rfonts is not None:
                    f = _attr(rfonts, 'ascii') or _attr(rfonts, 'hAnsi') or _attr(rfonts, 'eastAsia')
                    if f:
                        props['font'] = f

                # Size
                sz = rPr.find(f'{{{W}}}sz')
                if sz is not None:
                    v = _int_attr(sz, 'val')
                    if v:
                        props['size'] = v
                        props['sizePt'] = v / 2

                # Color
                color = rPr.find(f'{{{W}}}color')
                if color is not None:
                    c = _attr(color, 'val')
                    if c:
                        props['color'] = c.upper()

                # Bold
                bold = rPr.find(f'{{{W}}}b')
                if bold is not None:
                    val = _attr(bold, 'val')
                    if val != '0' and val != 'false':
                        props['bold'] = True

                # Italic
                italic = rPr.find(f'{{{W}}}i')
                if italic is not None:
                    val = _attr(italic, 'val')
                    if val != '0' and val != 'false':
                        props['italic'] = True

                # Highlight / shading on run
                highlight = rPr.find(f'{{{W}}}highlight')
                if highlight is not None:
                    h = _attr(highlight, 'val')
                    if h:
                        props['highlight'] = h

                shd = rPr.find(f'{{{W}}}shd')
                if shd is not None:
                    fill = _attr(shd, 'fill')
                    if fill and fill.upper() != 'AUTO':
                        props['bgColor'] = fill.upper()

            if props:
                key = json.dumps(props, sort_keys=True)
                if key not in context_runs[context]:
                    context_runs[context][key] = {'props': props, 'count': 0, 'sample': ''}
                context_runs[context][key]['count'] += 1
                if not context_runs[context][key]['sample']:
                    context_runs[context][key]['sample'] = t.text.strip()[:40]

    # Walk through body elements
    for child in body:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        if tag == 'p':
            style = _get_paragraph_style(child)
            level = _get_heading_level(style)
            is_list = style.lower().startswith('list') if style else False

            if level > 0:
                _process_runs(child, 'heading')
            elif is_list:
                _process_runs(child, 'listItem')
            else:
                _process_runs(child, 'bodyText')

        elif tag == 'tbl':
            rows = list(child.findall(f'{{{W}}}tr'))
            for i, tr in enumerate(rows):
                # Detect code block table (single column, dark shading)
                is_code = False
                for tc in tr.findall(f'{{{W}}}tc'):
                    tc_pr = tc.find(f'{{{W}}}tcPr')
                    if tc_pr is not None:
                        shd = tc_pr.find(f'{{{W}}}shd')
                        if shd is not None:
                            fill = (_attr(shd, 'fill') or '').upper()
                            if fill in ('1E1E1E', '2D2D2D', '1E1F1E'):
                                is_code = True
                    break

                ctx = 'codeBlock' if is_code else ('tableHeader' if i == 0 else 'tableBody')
                for tc in tr.findall(f'{{{W}}}tc'):
                    for p in tc.findall(f'{{{W}}}p'):
                        _process_runs(p, ctx)

    # Convert to sorted lists
    result = {}
    for context, combos in context_runs.items():
        if not combos:
            continue
        sorted_combos = sorted(combos.values(), key=lambda x: -x['count'])
        result[context] = sorted_combos

    return result if result else None


# ============================================================
# Main extraction
# ============================================================

def extract_spec(docx_path):
    """DOCX 파일에서 종합 스타일 명세 추출"""
    if not os.path.exists(docx_path):
        print(f"[ERROR] 파일을 찾을 수 없습니다: {docx_path}", file=sys.stderr)
        sys.exit(1)

    spec = {'file': os.path.basename(docx_path)}

    with zipfile.ZipFile(docx_path, 'r') as z:
        # Parse core XML files
        doc_root = _parse_xml_from_zip(z, 'word/document.xml')
        styles_root = _parse_xml_from_zip(z, 'word/styles.xml')

        if doc_root is None:
            print("[ERROR] word/document.xml을 파싱할 수 없습니다.", file=sys.stderr)
            sys.exit(1)

        # 1. Page Setup
        page_setup = extract_page_setup(doc_root)
        spec['pageSetup'] = page_setup or 'not found'

        # 2. Document Defaults
        doc_defaults = extract_doc_defaults(styles_root)
        spec['docDefaults'] = doc_defaults or 'not found (styles.xml missing or no docDefaults)'

        # 3. Heading Styles
        heading_styles = extract_heading_styles(styles_root)
        spec['headingStyles'] = heading_styles or 'not found'

        # 4. Element Inventory
        elem_inv = extract_element_inventory(doc_root)
        spec['elementInventory'] = elem_inv or 'not found'

        # 5. Spacing Patterns
        spacing = extract_spacing_patterns(doc_root)
        spec['spacingPatterns'] = spacing or 'not found'

        # 6. Table Styles
        table_styles = extract_table_styles(styles_root)
        spec['tableStyles'] = table_styles or 'not found (no table styles in styles.xml)'

        # 7. Run Properties Summary
        run_props = extract_run_properties(doc_root)
        spec['runProperties'] = run_props or 'not found'

    return spec


# ============================================================
# Text output
# ============================================================

def print_text_report(spec):
    """사람이 읽을 수 있는 텍스트 리포트 출력"""
    sep = '=' * 70
    sub_sep = '-' * 50

    print(sep)
    print(f'  DOCX Style Specification: {spec["file"]}')
    print(sep)

    # 1. Page Setup
    print(f'\n{"1. Page Setup":}')
    print(sub_sep)
    ps = spec.get('pageSetup')
    if isinstance(ps, str):
        print(f'  {ps}')
    elif ps:
        print(f'  Size:        {ps.get("width", "?")} x {ps.get("height", "?")} DXA', end='')
        if 'widthMm' in ps:
            print(f'  ({ps["widthMm"]}mm x {ps["heightMm"]}mm)', end='')
        print()
        print(f'  Paper:       {ps.get("paperSize", "Unknown")}')
        print(f'  Orientation: {ps.get("orientation", "Unknown")}')
        margins = ps.get('margins', {})
        if margins:
            print(f'  Margins (DXA):')
            for side in ('top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'):
                if side in margins:
                    print(f'    {side:10s} {margins[side]:>6d}  ({margins[side] / 20:.1f}pt)')
        if ps.get('headerRef'):
            print(f'  Headers:     {len(ps["headerRef"])} reference(s)')
        if ps.get('footerRef'):
            print(f'  Footers:     {len(ps["footerRef"])} reference(s)')

    # 2. Document Defaults
    print(f'\n{"2. Document Defaults":}')
    print(sub_sep)
    dd = spec.get('docDefaults')
    if isinstance(dd, str):
        print(f'  {dd}')
    elif dd:
        if 'font' in dd:
            print(f'  Default font:  {dd["font"]}')
        if 'fontDetails' in dd:
            for k, v in dd['fontDetails'].items():
                print(f'    {k:10s} → {v}')
        if 'fontSizePt' in dd:
            print(f'  Default size:  {dd["fontSizePt"]}pt (half-pt: {dd["fontSize"]})')
        if 'language' in dd:
            print(f'  Language:      {dd["language"]}')
        if 'paragraphSpacing' in dd:
            sp = dd['paragraphSpacing']
            print(f'  Para spacing:  before={sp.get("before", 0)}, after={sp.get("after", 0)}, line={sp.get("line", 0)}')

    # 3. Heading Styles
    print(f'\n{"3. Heading Styles":}')
    print(sub_sep)
    hs = spec.get('headingStyles')
    if isinstance(hs, str):
        print(f'  {hs}')
    elif hs:
        for key in sorted(hs.keys()):
            h = hs[key]
            print(f'  {key}:')
            if 'font' in h:
                print(f'    Font:    {h["font"]}')
            if 'sizePt' in h:
                print(f'    Size:    {h["sizePt"]}pt')
            if 'color' in h:
                print(f'    Color:   #{h["color"]}')
            if 'bold' in h:
                print(f'    Bold:    {h["bold"]}')
            if 'italic' in h:
                print(f'    Italic:  {h["italic"]}')
            if 'spacing' in h:
                sp = h['spacing']
                print(f'    Spacing: before={sp.get("before", 0)}, after={sp.get("after", 0)}')

    # 4. Element Inventory
    print(f'\n{"4. Element Inventory":}')
    print(sub_sep)
    ei = spec.get('elementInventory')
    if isinstance(ei, str):
        print(f'  {ei}')
    elif ei:
        print(f'  Headings:          {ei.get("totalHeadings", 0)}', end='')
        if ei.get('headings'):
            parts = [f'{k}={v}' for k, v in sorted(ei['headings'].items())]
            print(f'  ({", ".join(parts)})', end='')
        print()
        print(f'  Tables:            {ei.get("totalTables", 0)}')
        print(f'  Paragraphs:        {ei.get("paragraphs", 0)}')
        print(f'  List items:        {ei.get("listItems", 0)}')
        print(f'  Images:            {ei.get("images", 0)}')
        print(f'  Page breaks:       {ei.get("pageBreaks", 0)}')
        print(f'  Empty paragraphs:  {ei.get("emptyParagraphs", 0)}')

        tables = ei.get('tables', [])
        if tables:
            print(f'\n  Tables detail:')
            for i, t in enumerate(tables):
                hdr = ' | '.join(t.get('headerText', []))
                if len(hdr) > 60:
                    hdr = hdr[:57] + '...'
                print(f'    [{i+1}] {t["type"]:16s} {t["rowCount"]:>3d} rows x {t["colCount"]:>2d} cols  [{hdr}]')
                if t.get('colWidthsDxa'):
                    widths_str = ', '.join(str(w) for w in t['colWidthsDxa'])
                    print(f'        Widths (DXA): {widths_str}')
                if t.get('headerFill'):
                    print(f'        Header fill:  #{t["headerFill"]}')
                if t.get('bodyFills'):
                    print(f'        Body fills:   {", ".join("#"+f for f in t["bodyFills"])}')

    # 5. Spacing Patterns
    print(f'\n{"5. Spacing Patterns":}')
    print(sub_sep)
    sp = spec.get('spacingPatterns')
    if isinstance(sp, str):
        print(f'  {sp}')
    elif sp:
        print(f'  Spacer paragraphs (empty + spacing): {sp.get("spacerParagraphs", 0)}')
        patterns = sp.get('patterns', [])
        if patterns:
            print(f'  {"Context":10s} {"Before":>7s} {"After":>7s} {"Line":>7s} {"Count":>6s}')
            for p in patterns[:15]:  # top 15
                print(f'  {p["context"]:10s} {p["before"]:>7d} {p["after"]:>7d} {p["line"]:>7d} {p["count"]:>6d}')
            if len(patterns) > 15:
                print(f'  ... and {len(patterns) - 15} more unique combinations')

    # 6. Table Styles
    print(f'\n{"6. Table Styles (from styles.xml)":}')
    print(sub_sep)
    ts = spec.get('tableStyles')
    if isinstance(ts, str):
        print(f'  {ts}')
    elif ts:
        for s in ts:
            print(f'  {s.get("styleId", "?")} ({s.get("name", "")})')
            if s.get('borders'):
                for side, b in s['borders'].items():
                    print(f'    Border {side}: {b}')
            if s.get('cellMargins'):
                print(f'    Cell margins: {s["cellMargins"]}')
            if s.get('conditionalFormats'):
                for cond_type, cond in s['conditionalFormats'].items():
                    parts = []
                    if cond.get('fill'):
                        parts.append(f'fill=#{cond["fill"]}')
                    if cond.get('fontColor'):
                        parts.append(f'font=#{cond["fontColor"]}')
                    if cond.get('bold'):
                        parts.append('bold')
                    print(f'    {cond_type}: {", ".join(parts)}')

    # 7. Run Properties
    print(f'\n{"7. Run Properties Summary":}')
    print(sub_sep)
    rp = spec.get('runProperties')
    if isinstance(rp, str):
        print(f'  {rp}')
    elif rp:
        for context in ('heading', 'tableHeader', 'tableBody', 'codeBlock', 'bodyText', 'listItem'):
            combos = rp.get(context)
            if not combos:
                continue
            print(f'\n  [{context}] ({len(combos)} unique combinations)')
            for c in combos[:5]:  # top 5
                p = c['props']
                parts = []
                if 'font' in p:
                    parts.append(p['font'])
                if 'sizePt' in p:
                    parts.append(f'{p["sizePt"]}pt')
                if 'color' in p:
                    parts.append(f'#{p["color"]}')
                if p.get('bold'):
                    parts.append('bold')
                if p.get('italic'):
                    parts.append('italic')
                if 'bgColor' in p:
                    parts.append(f'bg=#{p["bgColor"]}')
                desc = ', '.join(parts) if parts else '(inherited defaults)'
                sample = c.get('sample', '')
                if sample:
                    sample = f'  "{sample}"'
                print(f'    x{c["count"]:>4d}  {desc}{sample}')
            if len(combos) > 5:
                print(f'    ... and {len(combos) - 5} more')

    print(f'\n{sep}')


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description='DOCX 스타일 명세 추출 — 레퍼런스 문서에서 페이지 설정, 폰트, 색상, 간격, 테이블 스타일 등을 종합 추출'
    )
    parser.add_argument('docx_path', help='분석할 DOCX 파일 경로')
    parser.add_argument('--json', action='store_true', help='JSON 형식으로 출력')

    args = parser.parse_args()

    spec = extract_spec(args.docx_path)

    if args.json:
        print(json.dumps(spec, ensure_ascii=False, indent=2))
    else:
        print_text_report(spec)


if __name__ == '__main__':
    main()

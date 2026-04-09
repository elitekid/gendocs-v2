#!/usr/bin/env python3
"""
tools/extract-pdf-ir.py — PDF → IR JSON 변환

pymupdf로 PDF를 파싱하여 SemanticIR 호환 JSON을 stdout으로 출력한다.
lib/parsers/pdf-parser.js가 child_process로 호출.

사용법:
  python -X utf8 tools/extract-pdf-ir.py input.pdf --json
  python -X utf8 tools/extract-pdf-ir.py input.pdf --json --image-dir output/.images/
"""

import sys
import os
import json
import base64
import re
from collections import Counter

import fitz  # pymupdf

# ============================================================
# 상수
# ============================================================

BULLET_PATTERN = re.compile(r'^[\-·•▪▸►●○◆◇→☞✓✔★☐☑]\s')
NUMBERED_LIST_PATTERN = re.compile(r'^(\d+[\.\)]\s|[a-zA-Z][\.\)]\s)')
DOTTED_LINE_PATTERN = re.compile(r'\.{5,}|…{3,}|·{5,}')
# 섹션 번호: "0.", "4.1", "4.1.2" 등 (최소 1개의 점 필요)
SECTION_NUM_PATTERN = re.compile(r'^(\d+\.(?:\d+\.?)*)\s')


# ============================================================
# 마진/줄간격 계산
# ============================================================

def _calculate_margins(doc, skip_pages, body_size):
    """body_size 텍스트에서 좌/우 마진 + page_width 반환.
    좌: 최빈값, 우: 95 퍼센타일 (n>=20) 또는 좌측 대칭.
    """
    x_lefts, x_rights = [], []
    page_width = None
    for pi in range(len(doc)):
        if pi in skip_pages:
            continue
        page = doc[pi]
        if page_width is None:
            page_width = page.rect.width
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if round(span["size"]) == body_size and span["text"].strip():
                        x_lefts.append(round(span["bbox"][0]))
                        x_rights.append(round(span["bbox"][2]))
        if len(x_lefts) > 200:
            break
    base_margin = max(set(x_lefts), key=x_lefts.count) if x_lefts else 72
    if len(x_rights) >= 20:
        x_rights.sort()
        right_edge = x_rights[int(len(x_rights) * 0.95)]
        right_margin = round((page_width or 792) - right_edge)
    else:
        right_margin = base_margin
    return base_margin, right_margin, page_width or 792


def _calculate_line_spacing(doc, skip_pages, body_size):
    """본문 블록(body_size, 3줄+)에서 줄 간격 배수 계산 (쌍별 비율 중앙값)"""
    ratios = []
    for pi in range(len(doc)):
        if pi in skip_pages:
            continue
        page = doc[pi]
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            lines = block.get("lines", [])
            if len(lines) < 3:
                continue
            valid_spans = [s for l in lines for s in l.get("spans", []) if s["text"].strip()]
            if not valid_spans:
                continue
            if not all(round(s["size"]) == body_size for s in valid_spans):
                continue
            for i in range(1, len(lines)):
                pitch = lines[i]["bbox"][1] - lines[i-1]["bbox"][1]
                lh = lines[i]["bbox"][3] - lines[i]["bbox"][1]
                if lh > 0 and 0 < pitch < body_size * 3:
                    ratios.append(pitch / lh)
    if not ratios:
        return None
    ratios.sort()
    multiple = round(ratios[len(ratios) // 2], 2)
    return multiple if 0.8 <= multiple <= 3.0 else None


def _extract_table_grid(table, page_drawings):
    """t.cols/t.rows가 없을 때 drawings 세로선/가로선에서 컬럼·행 경계 추출.

    Returns (col_xs, row_ys) — 정렬된 x/y 좌표 리스트.
    col_xs: n+1개 (n컬럼), row_ys: m+1개 (m행).
    추출 실패 시 (None, None).
    """
    trect = fitz.Rect(table.bbox)
    vertical_xs = set()
    horizontal_ys = set()

    for d in page_drawings:
        drect = fitz.Rect(d.get("rect", (0, 0, 0, 0)))
        if not trect.intersects(drect):
            continue
        for item in d.get("items", []):
            if item[0] == "l":  # line
                p1, p2 = item[1], item[2]
                if abs(p1.x - p2.x) < 2:  # 세로선
                    vertical_xs.add(round(p1.x))
                elif abs(p1.y - p2.y) < 2:  # 가로선
                    horizontal_ys.add(round(p1.y))
            elif item[0] == "re":  # rect
                r = item[1]
                w, h = r.width, r.height
                if w < 3 and h > 5:  # 좁고 긴 = 세로선
                    vertical_xs.add(round(r.x0))
                elif h < 3 and w > 5:  # 낮고 넓은 = 가로선
                    horizontal_ys.add(round(r.y0))

    # 테이블 bbox 경계를 항상 포함 (우측/하단 선이 drawings에 없는 경우 보완)
    vertical_xs.add(round(trect.x0))
    vertical_xs.add(round(trect.x1))
    horizontal_ys.add(round(trect.y0))
    horizontal_ys.add(round(trect.y1))

    col_xs = sorted(vertical_xs) if len(vertical_xs) >= 2 else None
    row_ys = sorted(horizontal_ys) if len(horizontal_ys) >= 2 else None
    return col_xs, row_ys


def _find_spans_in_rect(text_blocks, rect):
    """캐싱된 text_blocks에서 rect 내부 span 반환"""
    result = []
    for block in text_blocks:
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not span["text"].strip():
                    continue
                sx, sy = span["bbox"][0], span["bbox"][1]
                if rect.x0 <= sx <= rect.x1 and rect.y0 <= sy <= rect.y1:
                    result.append(span)
    return result


# ============================================================
# Phase A: 표지/목차 감지
# ============================================================

def detect_cover_page(doc):
    """1페이지: 텍스트 < 100자 + 이미지 있음 → 표지"""
    if len(doc) < 1:
        return False
    page = doc[0]
    text = page.get_text().strip()
    images = page.get_images(full=False)
    return len(text) < 100 and len(images) > 0


def detect_toc_pages(doc, start_idx=1):
    """점선 패턴이 3줄 이상인 연속 페이지 → 목차"""
    toc_pages = set()
    for i in range(start_idx, min(start_idx + 5, len(doc))):
        page = doc[i]
        text = page.get_text()
        dotted_count = len(DOTTED_LINE_PATTERN.findall(text))
        if dotted_count >= 3:
            toc_pages.add(i)
        else:
            break  # 목차는 연속 페이지
    return toc_pages


def extract_cover_title(doc):
    """표지에서 가장 큰 폰트의 텍스트를 제목으로 추출"""
    page = doc[0]
    max_size = 0
    title = ""
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span["text"].strip()
                if text and span["size"] > max_size:
                    max_size = span["size"]
                    title = text
    return title


# ============================================================
# 1차 패스: 전체 문서 스캔
# ============================================================

def identify_headers(doc, skip_pages=None):
    """본문 기준 heading 레벨 맵 결정 (pymupdf4llm 방식)

    skip_pages로 표지/목차를 제외하고, body_size보다 큰 모든 크기를
    H2부터 매핑한다 (H1은 표지 전용).
    """
    if skip_pages is None:
        skip_pages = set()

    size_counts = Counter()
    for page_idx, page in enumerate(doc):
        if page_idx in skip_pages:
            continue
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    size = round(span["size"])
                    text = span["text"].strip()
                    if text:
                        size_counts[size] += len(text)

    if not size_counts:
        return 10, {}

    body_size = size_counts.most_common(1)[0][0]
    # 본문보다 최소 2pt 이상 큰 크기만 heading 후보 (반올림 오차 방지)
    header_sizes = sorted([s for s in size_counts if s >= body_size + 2], reverse=True)

    level_map = {}
    # H2부터 시작 (H1은 표지용), 최대 4단계 (H2~H5)
    for i, size in enumerate(header_sizes):
        level = i + 2  # H2, H3, H4, H5
        if level > 5:
            break
        level_map[size] = level

    return body_size, level_map


def collect_skip_lines(doc):
    """50%+ 반복 줄 수집 (헤더/푸터 필터링)"""
    page_count = len(doc)
    if page_count < 3:
        return set()

    line_counts = Counter()
    for page in doc:
        seen_on_page = set()
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                text = "".join(s["text"] for s in line.get("spans", [])).strip()
                if text and text not in seen_on_page:
                    seen_on_page.add(text)
                    line_counts[text] += 1

    threshold = page_count * 0.5
    return {text for text, count in line_counts.items() if count >= threshold}


# ============================================================
# 다단 감지 (marker-pdf 방식)
# ============================================================

def detect_columns(page):
    """x좌표 분포로 다단 감지"""
    x_starts = [b["bbox"][0] for b in page.get_text("dict")["blocks"] if b["type"] == 0]
    if not x_starts:
        return 1
    page_mid = page.rect.width / 2
    left = [x for x in x_starts if x < page_mid]
    right = [x for x in x_starts if x >= page_mid]
    return 2 if (len(left) >= 3 and len(right) >= 3) else 1


def sort_by_column(elements, num_cols, page_width):
    if num_cols == 1:
        return sorted(elements, key=lambda e: (e["y0"], e["x0"]))
    mid = page_width / 2
    left = sorted([e for e in elements if e["x0"] < mid], key=lambda e: e["y0"])
    right = sorted([e for e in elements if e["x0"] >= mid], key=lambda e: e["y0"])
    return left + right


# ============================================================
# 유틸
# ============================================================

def _is_mono_span(span):
    """flags bit3 (모노스페이스) 판정 — PDF 표준"""
    return bool(span.get("flags", 0) & 8)


def safe_get_text(span):
    """CJK 깨짐 감지 + 한글 폰트명 반환"""
    text = span.get("text", "")
    if "\ufffd" in text or "???" in text:
        return None, "CJK_ENCODING_ERROR"
    has_korean = any('\uac00' <= c <= '\ud7a3' for c in text)
    font_info = span.get("font", "unknown") if has_korean else None
    return text, font_info


def _measure_cell_padding_pdfminer(pdf_path, page_num, page_height,
                                    grid_cols, grid_rows, col_count):
    """pdfminer LTChar로 컬럼별 셀 패딩을 정확히 측정.

    데이터 행(헤더 제외)에서 컬럼별 최소 L/R/T/B 패딩을 측정.
    Returns: (table_padding, column_paddings)
      - table_padding: {"left": median_L, "top": median_T, ...} 테이블 대표값
      - column_paddings: [{"left":L, "top":T, "right":R, "bottom":B}, ...] 컬럼별
    """
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTChar
    except ImportError:
        return None, None

    def to_pm_y(y):
        return page_height - y

    chars = []
    try:
        for page_layout in extract_pages(pdf_path, page_numbers=[page_num]):
            def walk(obj):
                if isinstance(obj, LTChar):
                    chars.append(obj)
                if hasattr(obj, '__iter__'):
                    for child in obj:
                        walk(child)
            walk(page_layout)
    except Exception:
        return None, None

    if not chars:
        return None, None

    n_cols = min(len(grid_cols) - 1, col_count)
    col_left = [[] for _ in range(n_cols)]
    col_right = [[] for _ in range(n_cols)]
    col_top = [[] for _ in range(n_cols)]
    col_bottom = [[] for _ in range(n_cols)]

    n_data_rows = min(len(grid_rows) - 2, 5)
    for ri in range(1, 1 + n_data_rows):
        if ri >= len(grid_rows) - 1:
            break
        for ci in range(n_cols):
            cx0, cx1 = grid_cols[ci], grid_cols[ci + 1]
            ry_top = to_pm_y(grid_rows[ri])
            ry_bot = to_pm_y(grid_rows[ri + 1])
            if ry_top < ry_bot:
                ry_top, ry_bot = ry_bot, ry_top

            cell_chars = [c for c in chars
                          if cx0 + 0.3 < c.x0 < cx1 - 0.3
                          and ry_bot + 0.3 < c.y0 < ry_top - 0.3]
            if not cell_chars:
                continue

            l = min(c.x0 for c in cell_chars) - cx0
            r = cx1 - max(c.x1 for c in cell_chars)
            t = ry_top - max(c.y1 for c in cell_chars)
            b = min(c.y0 for c in cell_chars) - ry_bot

            if 0 <= l < 20: col_left[ci].append(l)
            if 0 <= r < 200: col_right[ci].append(r)  # R은 텍스트 길이에 따라 큼
            if 0 <= t < 20: col_top[ci].append(t)
            if 0 <= b < 20: col_bottom[ci].append(b)

    # 컬럼별 최소 L, T/B 중앙값
    column_paddings = []
    all_left = []
    all_top = []
    all_bottom = []
    for ci in range(n_cols):
        lp = round(min(col_left[ci]), 1) if col_left[ci] else 2.0
        tp = round(sorted(col_top[ci])[len(col_top[ci])//2], 1) if col_top[ci] else 2.0
        bp = round(sorted(col_bottom[ci])[len(col_bottom[ci])//2], 1) if col_bottom[ci] else 2.0
        # R패딩 = L패딩과 동일 (R측정값은 텍스트 길이에 의존하므로 신뢰 불가)
        rp = lp
        column_paddings.append({"left": lp, "top": tp, "right": rp, "bottom": bp})
        all_left.append(lp)
        all_top.append(tp)
        all_bottom.append(bp)

    # 테이블 대표값 (중앙값)
    all_left.sort()
    all_top.sort()
    all_bottom.sort()
    tbl_l = all_left[len(all_left)//2] if all_left else 2.0
    tbl_t = all_top[len(all_top)//2] if all_top else 2.0
    tbl_b = all_bottom[len(all_bottom)//2] if all_bottom else 2.0
    table_padding = {"left": tbl_l, "top": tbl_t, "right": tbl_l, "bottom": tbl_b}

    return table_padding, column_paddings


def _is_bold(span):
    """flags bit4 (bold) 판정 — PDF 표준"""
    return bool(span.get("flags", 0) & 16) or "Bold" in span.get("font", "")


def _build_faux_bold_map(pdf_path, page_num, page_height):
    """pdfminer로 페이지 내 faux bold 영역을 한 번에 수집.

    Returns: set of rounded pymupdf y좌표 (top-down). 해당 y에 faux bold 텍스트 존재.
    _span_style()에서 span의 y좌표가 이 세트에 있으면 bold.
    """
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTChar
    except ImportError:
        return set()

    bold_ys = set()  # pymupdf y좌표 (top-down)
    try:
        for page_layout in extract_pages(pdf_path, page_numbers=[page_num]):
            def walk(obj):
                if isinstance(obj, LTChar):
                    lw = getattr(obj.graphicstate, 'linewidth', 0)
                    if lw and lw > 0:
                        # pdfminer y1 (글자 상단, bottom-up) → pymupdf y (top-down)
                        pymupdf_y = round(page_height - obj.y1)
                        bold_ys.add(pymupdf_y)
                if hasattr(obj, '__iter__'):
                    for child in obj:
                        walk(child)
            walk(page_layout)
    except Exception:
        pass
    return bold_ys


def _detect_faux_bold_header(page, table_bbox, header_bottom_y):
    """pdfminer.six로 faux bold (stroke 기반) 감지.

    PDF에서 텍스트 렌더링 모드를 fill+stroke로 설정하고 linewidth > 0이면
    글자가 두꺼워 보이지만 pymupdf flags에는 bold로 안 잡힘.
    헤더 영역의 글자 중 linewidth > 0인 비율이 50% 이상이면 bold로 판정.
    """
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTTextBox, LTTextLine, LTChar
    except ImportError:
        return False

    pdf_path = page.parent.name
    page_num = page.number
    page_height = page.rect.height

    # pdfminer y좌표는 bottom-up, pymupdf는 top-down
    hdr_y_min = page_height - header_bottom_y
    hdr_y_max = page_height - table_bbox[1]
    hdr_x_min = table_bbox[0]
    hdr_x_max = table_bbox[2]

    bold_count = 0
    total_count = 0
    try:
        for page_layout in extract_pages(pdf_path, page_numbers=[page_num]):
            for element in page_layout:
                if not isinstance(element, (LTTextBox, LTTextLine)):
                    continue
                for line in element:
                    if not hasattr(line, '__iter__'):
                        continue
                    for char in line:
                        if not isinstance(char, LTChar):
                            continue
                        if (hdr_x_min <= char.x0 <= hdr_x_max and
                                hdr_y_min <= char.y0 <= hdr_y_max):
                            total_count += 1
                            lw = getattr(char.graphicstate, 'linewidth', 0)
                            if lw and lw > 0:
                                bold_count += 1
    except Exception:
        return False

    return total_count > 0 and bold_count > total_count * 0.5


# PDF 내부 폰트명 → Word 인식 폰트명
_FONT_MAP = {
    "MalgunGothic": "맑은 고딕",
    "MalgunGothicBold": "맑은 고딕",
    "Gulim": "Gulim",
    "GulimChe": "GulimChe",
    "Dotum": "Dotum",
    "DotumChe": "DotumChe",
    "Batang": "Batang",
}


def _map_font_name(raw_name):
    """PDF 폰트명에서 서브셋 접두사 제거 + Word 폰트명 매핑"""
    # 서브셋 접두사 제거 (BCDGEE+Gulim → Gulim)
    name = raw_name.split("+")[-1] if "+" in raw_name else raw_name
    return _FONT_MAP.get(name, name)


def _span_style(span, faux_bold_map=None):
    """span에서 스타일 속성 추출 (faux bold 포함)"""
    style = {
        "font": _map_font_name(span.get("font", "")),
        "size": round(span["size"], 1),
        "color": f"{span.get('color', 0) & 0xFFFFFF:06X}",
    }
    if _is_bold(span):
        style["bold"] = True
    elif faux_bold_map:
        # pymupdf span의 y좌표가 faux bold 맵에 있으면 bold
        span_y = round(span["bbox"][1])
        if span_y in faux_bold_map:
            style["bold"] = True
    if span.get("flags", 0) & 2:
        style["italic"] = True
    if _is_mono_span(span):
        style["mono"] = True
    return style


def _line_style(spans, faux_bold_map=None):
    """줄의 대표 스타일 (첫 span 기준)"""
    if not spans:
        return {}
    return _span_style(spans[0], faux_bold_map)


def _is_heading_candidate(line_text, font_size, body_size, level_map):
    """heading 후보인지 판정"""
    size = round(font_size)
    if size in level_map:
        return level_map[size]
    return None


# ============================================================
# 2차 패스: 노드 생성
# ============================================================

def process_text_block(block, level_map, body_size, skip_lines, table_rects, page_num,
                       base_margin=72, page_width=792, right_margin=72,
                       spacing_before=None, faux_bold_map=None):
    """텍스트 블록 → IR 노드들"""
    nodes = []
    spacing_applied = False

    # 블록 내 유효 라인 수 (align 판정: 단일 라인만)
    line_count = sum(
        1 for l in block.get("lines", [])
        if any(s["text"].strip() for s in l.get("spans", []))
    )

    for line in block.get("lines", []):
        spans = line.get("spans", [])
        if not spans:
            continue

        # 줄 텍스트 조합
        line_text = "".join(s["text"] for s in spans).strip()
        if not line_text:
            continue

        # 스킵 줄 (헤더/푸터)
        if line_text in skip_lines:
            continue

        # 페이지 번호 패턴 스킵
        if re.match(r'^\d+\s*/\s*\d+$', line_text) or re.match(r'^\d+$', line_text):
            continue

        # 테이블 영역 내 스킵
        line_rect = fitz.Rect(line["bbox"])
        if any(tr.intersects(line_rect) for tr in table_rects):
            continue

        first_bold = _is_bold(spans[0])
        # faux bold 체크
        if not first_bold and faux_bold_map:
            span_y = round(spans[0]["bbox"][1])
            if span_y in faux_bold_map:
                first_bold = True
        primary_size = round(spans[0]["size"])

        style = _line_style(spans, faux_bold_map)

        # 1) 섹션 번호 heading — 번호 깊이가 가장 정확한 레벨 정보
        #    (bold 또는 본문보다 큰 폰트 + 짧은 줄)
        sec_match = SECTION_NUM_PATTERN.match(line_text)
        if sec_match and len(line_text) < 80 and (first_bold or primary_size > body_size):
            num_str = sec_match.group(1).rstrip('.')
            depth = num_str.count('.') + 1  # "0." → 1, "4.1" → 2, "4.1.2" → 3
            sec_level = min(depth + 1, 5)   # depth 1 → H2, 2 → H3, 3 → H4, max H5
            h_node = {"type": "heading", "level": sec_level, "text": line_text,
                      "style": style, "_page": page_num}
            # indent
            h_indent = round(spans[0]["bbox"][0] - base_margin)
            if h_indent > 5:
                h_node["indent"] = h_indent
            if not spacing_applied and spacing_before is not None:
                h_node["spacingBefore"] = spacing_before
                spacing_applied = True
            nodes.append(h_node)
            continue

        # 2) 크기 기반 heading (본문보다 2pt+ 큰 폰트, 번호 없는 제목)
        level = _is_heading_candidate(line_text, spans[0]["size"], body_size, level_map)
        if level is not None and 3 <= len(line_text) <= 120:
            h_node = {"type": "heading", "level": level, "text": line_text,
                      "style": style, "_page": page_num}
            h_indent = round(spans[0]["bbox"][0] - base_margin)
            if h_indent > 5:
                h_node["indent"] = h_indent
            if not spacing_applied and spacing_before is not None:
                h_node["spacingBefore"] = spacing_before
                spacing_applied = True
            nodes.append(h_node)
            continue

        # 3) 불릿/리스트 감지 — PDF 원본은 dash 텍스트 그대로 유지 (paragraph + indent)
        # (listItem으로 변환하면 Word가 ● 불릿으로 바꿔서 원본과 달라짐)

        # 코드블록 감지 (flags bit3 모노스페이스)
        if all(_is_mono_span(s) for s in spans):
            # x좌표 기반 indent → 공백 정규화
            mono_x = spans[0]["bbox"][0]
            mono_indent = mono_x - base_margin
            # 텍스트 앞 기존 공백 수
            existing_spaces = len(line_text) - len(line_text.lstrip(' '))
            # 기존 공백의 폭 추정 (모노 폰트: 1 space ≈ fontSize * 0.6)
            mono_size = spans[0]["size"]
            space_width = mono_size * 0.6
            existing_indent = existing_spaces * space_width
            # 추가 indent 필요분
            extra_indent = mono_indent - existing_indent
            if extra_indent > space_width * 0.5:
                extra_spaces = round(extra_indent / space_width)
                mono_text = " " * extra_spaces + line_text
            else:
                mono_text = line_text
            nodes.append({"_mono_line": mono_text, "_mono_style": _span_style(spans[0], faux_bold_map),
                          "_page": page_num, "_y": spans[0]["bbox"][1]})
            continue

        # callout 감지
        if re.match(r'^(참고|주의|중요|경고)\s*[:：]', line_text):
            variant = "warning" if re.match(r'^(주의|경고)', line_text) else "info"
            nodes.append({"type": "callout", "variant": variant,
                          "runs": [{"text": line_text}], "style": style, "_page": page_num})
            continue

        # 일반 paragraph — runs 생성 (font/size/color/bold/italic 보존)
        runs = []
        for span in spans:
            text, font_info = safe_get_text(span)
            if text is None:
                continue
            run = {"text": text, "font": _map_font_name(span.get("font", "")),
                   "size": round(span["size"], 1),
                   "color": f"{span.get('color', 0) & 0xFFFFFF:06X}"}
            is_bold = _is_bold(span)
            if not is_bold and faux_bold_map:
                span_y = round(span["bbox"][1])
                is_bold = span_y in faux_bold_map
            if is_bold:
                run["bold"] = True
            if span.get("flags", 0) & 2:
                run["italic"] = True
            runs.append(run)

        if runs:
            p_node = {"type": "paragraph", "runs": runs, "_page": page_num}
            # indent
            p_indent = round(spans[0]["bbox"][0] - base_margin)
            if p_indent > 5:
                p_node["indent"] = p_indent
            # align (단일 라인 블록만)
            if line_count == 1:
                content_left = base_margin
                content_right = page_width - right_margin
                content_center = (content_left + content_right) / 2
                content_width = content_right - content_left
                lx0 = line["bbox"][0]; lx1 = line["bbox"][2]
                lcx = (lx0 + lx1) / 2; lw = lx1 - lx0
                if (abs(lcx - content_center) < 20 and lw < content_width * 0.8
                        and lx0 <= content_center):
                    p_node["align"] = "center"
                elif lx1 > content_right - 10 and lx0 > content_center:
                    p_node["align"] = "right"
            # spacingBefore (모든 요소에 적용)
            if not spacing_applied and spacing_before is not None:
                p_node["spacingBefore"] = spacing_before
                spacing_applied = True
            nodes.append(p_node)

    return nodes


def process_table(table, page_num, page=None, drawings=None, text_blocks=None,
                   faux_bold_map=None):
    """pymupdf Table → IR table 노드 (컬럼별 실제 너비 + 페이지 스타일)"""
    data = table.extract()
    if not data or len(data) < 1:
        return None

    raw_headers = data[0]
    valid_headers = [h for h in raw_headers if h]
    if not valid_headers:
        valid_headers = [f"Col{i+1}" for i in range(len(raw_headers))]

    rows_data = []
    for row in data[1:]:
        valid_cells = [cell for cell in row if cell is not None]
        if valid_cells:
            rows_data.append(valid_cells)

    col_count = len(valid_headers)

    # 컬럼/행 경계 추출: cells → drawings fallback → 균등 분배
    grid_cols = None
    grid_rows = None

    # 1순위: table.cells에서 x/y 좌표 추출 (pymupdf 1.26+)
    if hasattr(table, 'cells') and table.cells:
        xs = sorted(set(round(c[0], 1) for c in table.cells) |
                     set(round(c[2], 1) for c in table.cells))
        ys = sorted(set(round(c[1], 1) for c in table.cells) |
                     set(round(c[3], 1) for c in table.cells))
        if len(xs) >= col_count + 1:
            grid_cols = xs
        if len(ys) >= 2:
            grid_rows = ys

    # 2순위: drawings fallback
    if grid_cols is None and drawings:
        dc, dr = _extract_table_grid(table, drawings)
        if dc and len(dc) >= col_count + 1:
            grid_cols = dc
        elif dc and len(dc) >= 2:
            grid_cols = dc
        if grid_rows is None and dr and len(dr) >= 2:
            grid_rows = dr

    # 컬럼 너비 계산
    col_widths = []
    if grid_cols and len(grid_cols) >= col_count + 1:
        for j in range(col_count):
            w = round(grid_cols[j + 1] - grid_cols[j], 1)
            col_widths.append(w)
    if len(col_widths) != col_count:
        table_width = table.bbox[2] - table.bbox[0]
        col_widths = [round(table_width / col_count, 1)] * col_count

    columns = [{"header": h, "width": col_widths[i]} for i, h in enumerate(valid_headers)]

    # 행 높이 계산 (grid_rows가 있을 때)
    # PDF 셀 bbox 높이를 그대로 사용 — Word trHeight(exact)와 시각적으로 일치
    row_heights = None
    if grid_rows and len(grid_rows) >= 2:
        row_heights = [round(grid_rows[j + 1] - grid_rows[j], 1)
                       for j in range(len(grid_rows) - 1)]

    ir_rows = []
    for row in rows_data:
        ir_row = []
        for i in range(col_count):
            text = row[i] if i < len(row) else ""
            ir_row.append({"runs": [{"text": (text or "")}]})
        ir_rows.append(ir_row)

    # 테이블 영역 내 텍스트 스타일 추출
    table_style = {}
    blocks_to_scan = text_blocks if text_blocks else (
        [b for b in page.get_text("dict")["blocks"] if b["type"] == 0] if page else []
    )
    if blocks_to_scan:
        table_rect = fitz.Rect(table.bbox)
        fonts = set()
        sizes = []
        bold_count = 0
        total_count = 0
        header_bold_count = 0
        header_total = 0
        header_spans_list = []
        header_bottom = table.bbox[1] + 30
        for block in blocks_to_scan:
            if block["type"] != 0:
                continue
            block_rect = fitz.Rect(block["bbox"])
            if not table_rect.intersects(block_rect):
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    fonts.add(span["font"])
                    sizes.append(round(span["size"], 1))
                    total_count += 1
                    if _is_bold(span):
                        bold_count += 1
                    # 헤더 행 판정
                    if span["bbox"][1] < header_bottom:
                        header_total += 1
                        header_spans_list.append(span)
                        if _is_bold(span):
                            header_bold_count += 1
        if fonts:
            table_style["font"] = _map_font_name(sorted(fonts)[0])
        if sizes:
            table_style["size"] = max(set(sizes), key=sizes.count)
        if header_total > 0:
            if header_bold_count > header_total * 0.5:
                table_style["headerBold"] = True
            else:
                # faux bold 감지: 헤더 행 첫 줄 span의 y좌표가 faux_bold_map에 있는지
                if faux_bold_map and header_spans_list:
                    first_hdr_y = round(header_spans_list[0]["bbox"][1])
                    table_style["headerBold"] = first_hdr_y in faux_bold_map
                else:
                    table_style["headerBold"] = False

        # headerColor
        header_colors = [f"{s['color'] & 0xFFFFFF:06X}" for s in header_spans_list if s["text"].strip()]
        if header_colors:
            most_common_color = max(set(header_colors), key=header_colors.count)
            if most_common_color != "000000":
                table_style["headerColor"] = most_common_color

    # cellPadding — pdfminer LTRect(셀 경계) + LTChar(글자 위치)로 정확 측정
    # 컬럼별 + 테이블 대표 cellPadding (pdfminer 기반 정밀 측정)
    if page and grid_cols and grid_rows and len(grid_cols) >= 2 and len(grid_rows) >= 3:
        tbl_pad, col_pads = _measure_cell_padding_pdfminer(
            page.parent.name, page.number, page.rect.height,
            grid_cols, grid_rows, col_count)
        if tbl_pad:
            table_style["cellPadding"] = tbl_pad
        if col_pads:
            for ci, cp in enumerate(col_pads):
                if ci < len(columns):
                    columns[ci]["padding"] = cp

    # 셀 align — 데이터 행은 left 기본값. 헤더 행만 center 감지.
    # (데이터 행은 좁은 컬럼에서 오탐 빈발하므로 감지하지 않음)
    if (blocks_to_scan and grid_cols and grid_rows
            and len(grid_cols) > 1 and len(grid_rows) > 1):
        # 헤더 행(row 0)의 각 셀 center 여부 판정
        header_center_count = 0
        for col_idx in range(min(len(grid_cols) - 1, col_count)):
            cell_rect = fitz.Rect(
                grid_cols[col_idx], grid_rows[0],
                grid_cols[col_idx + 1], grid_rows[1]
            )
            cell_center = (cell_rect.x0 + cell_rect.x1) / 2
            cell_width = cell_rect.width
            spans = _find_spans_in_rect(blocks_to_scan, cell_rect)
            if spans:
                scx = (spans[0]["bbox"][0] + spans[0]["bbox"][2]) / 2
                if abs(scx - cell_center) < cell_width * 0.2:
                    header_center_count += 1
        # 과반수 이상이면 헤더 전체 center
        if header_center_count > col_count * 0.5:
            table_style["headerCenter"] = True

    # headerBold인데 headerCenter 미감지 → bold 헤더는 대부분 center이므로 fallback
    if table_style.get("headerBold") and not table_style.get("headerCenter"):
        table_style["headerCenter"] = True

    # cellBg (drawings에서)
    if (drawings and grid_cols and grid_rows):
        n_rows_bg = len(grid_rows) - 1
        n_cols_bg = len(grid_cols) - 1
        for row_idx in range(min(n_rows_bg, len(ir_rows))):
            for col_idx in range(min(n_cols_bg, col_count)):
                cell_rect = fitz.Rect(
                    grid_cols[col_idx], grid_rows[row_idx],
                    grid_cols[col_idx + 1], grid_rows[row_idx + 1]
                )
                cell_area = cell_rect.width * cell_rect.height
                if cell_area <= 0:
                    continue
                for d in drawings:
                    fill = d.get("fill")
                    if not fill:
                        continue
                    rgb = fill[:3]
                    avg = sum(rgb) / 3
                    if avg > 0.94 or avg < 0.06:
                        continue
                    hex_c = "".join(f"{int(c*255):02X}" for c in rgb)
                    d_rect = fitz.Rect(d["rect"])
                    overlap = cell_rect & d_rect
                    if overlap.is_empty:
                        continue
                    if (overlap.width * overlap.height) > cell_area * 0.7:
                        ir_rows[row_idx][col_idx]["bg"] = hex_c
                        break

    node = {"type": "table", "columns": columns, "rows": ir_rows, "_page": page_num}
    if row_heights:
        node["rowHeights"] = row_heights
    # pymupdf가 1행만 감지한 경우: extract()[0]이 데이터일 수 있음 (cross-page 연속)
    if len(data) == 1:
        node["_singleRow"] = True
    if table_style:
        node["style"] = table_style
    return node


def process_image(doc, xref, rect, image_dir, page_num):
    """이미지 → IR image 노드"""
    width_pt = rect.width
    height_pt = rect.height

    node = {
        "type": "image",
        "width": round(width_pt),
        "height": round(height_pt),
        "_page": page_num,
    }

    try:
        pix = fitz.Pixmap(doc, xref)
        if pix.n > 4:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        if pix.alpha:
            pix = fitz.Pixmap(pix, 0)

        if image_dir:
            os.makedirs(image_dir, exist_ok=True)
            img_path = os.path.join(image_dir, f"img_{xref}.png")
            pix.save(img_path)
            node["path"] = img_path
        else:
            img_bytes = pix.tobytes("png")
            node["data"] = base64.b64encode(img_bytes).decode("ascii")
    except Exception:
        node["path"] = None

    return node


# ============================================================
# 후처리: 모노 줄 병합
# ============================================================

def merge_mono_lines(nodes):
    """연속 모노스페이스 줄 → codeBlock 노드로 병합 (줄 간격 측정 포함)"""
    merged = []
    code_lines = []
    code_ys = []
    code_page = None
    code_style = None

    def _flush():
        cb = {"type": "codeBlock", "lines": code_lines,
              "language": "", "_page": code_page}
        if code_style:
            cb["style"] = dict(code_style)
        # 줄 간격 계산 (y좌표 차이의 중앙값)
        if len(code_ys) >= 2:
            gaps = [round(code_ys[i+1] - code_ys[i], 1)
                    for i in range(len(code_ys) - 1) if code_ys[i+1] > code_ys[i]]
            if gaps:
                gaps.sort()
                median_gap = gaps[len(gaps) // 2]
                if "style" not in cb:
                    cb["style"] = {}
                cb["style"]["lineSpacing"] = median_gap
        merged.append(cb)

    for node in nodes:
        if "_mono_line" in node:
            # 페이지가 바뀌면 이전 코드블록 flush (페이지별 section 지원)
            node_page = node.get("_page")
            if code_lines and node_page is not None and code_page is not None and node_page != code_page:
                _flush()
                code_lines = []
                code_ys = []
                code_page = None
                code_style = None
            code_lines.append(node["_mono_line"])
            if node.get("_y") is not None:
                code_ys.append(node["_y"])
            if code_page is None:
                code_page = node.get("_page")
            if code_style is None:
                code_style = node.get("_mono_style")
        else:
            if code_lines:
                _flush()
                code_lines = []
                code_ys = []
                code_page = None
                code_style = None
            merged.append(node)

    if code_lines:
        _flush()

    return merged


# ============================================================
# 후처리: 연속 listItem → list 노드 병합
# ============================================================

def merge_list_items(nodes):
    """연속 listItem → IR list 노드 (layout-to-docx 호환)"""
    merged = []
    items = []
    list_page = None
    list_style = None

    for node in nodes:
        if node.get("type") == "listItem":
            text = "".join(r["text"] for r in node.get("runs", []))
            items.append(text)
            if list_page is None:
                list_page = node.get("_page")
            if list_style is None and node.get("style"):
                list_style = node["style"]
        else:
            if items:
                ln = {"type": "list", "ordered": False,
                      "items": items, "_page": list_page}
                if list_style:
                    ln["style"] = list_style
                merged.append(ln)
                items = []
                list_page = None
                list_style = None
            merged.append(node)

    if items:
        ln = {"type": "list", "ordered": False,
              "items": items, "_page": list_page}
        if list_style:
            ln["style"] = list_style
        merged.append(ln)

    return merged


# ============================================================
# 후처리: JSON 중괄호 깊이 추적 → codeBlock
# ============================================================

def detect_json_blocks(nodes):
    """JSON 패턴({/[ 시작 + 깊이 추적) → codeBlock 변환.

    brace_depth > 0이면 paragraph뿐 아니라 기존 codeBlock도 흡수하여
    하나의 JSON 블록으로 병합한다.
    """
    result = []
    json_lines = []
    brace_depth = 0
    json_page = None
    json_style = None

    def _extract_text(node):
        if node.get("type") == "paragraph":
            return "".join(r["text"] for r in node.get("runs", [])).strip()
        if node.get("type") == "codeBlock":
            return "\n".join(node.get("lines", []))
        return None

    def _extract_lines(node):
        if node.get("type") == "codeBlock":
            return node.get("lines", [])
        if node.get("type") == "paragraph":
            text = "".join(r["text"] for r in node.get("runs", [])).strip()
            return [text] if text else []
        return []

    def _flush():
        nonlocal json_lines, brace_depth, json_page, json_style
        if json_lines:
            cb = {"type": "codeBlock", "lines": json_lines,
                  "language": "json", "_page": json_page}
            if json_style:
                cb["style"] = json_style
            result.append(cb)
        json_lines = []
        brace_depth = 0
        json_page = None
        json_style = None

    for node in nodes:
        text = _extract_text(node)

        # JSON 진행 중 → 모든 텍스트 노드를 흡수 (페이지 경계에서 분리)
        if brace_depth > 0 and text is not None:
            node_page = node.get("_page")
            if node_page is not None and json_page is not None and node_page != json_page:
                _flush()  # 페이지 바뀌면 강제 flush
                # 새 JSON 블록 시작
                json_page = node_page
            lines = _extract_lines(node)
            json_lines.extend(lines)
            if json_style is None and node.get("style"):
                json_style = node["style"]
            opens = text.count("{") + text.count("[")
            closes = text.count("}") + text.count("]")
            brace_depth += opens - closes
            if brace_depth <= 0:
                _flush()
            continue

        # JSON 시작 감지
        if text is not None:
            first_line = text.split("\n")[0].strip() if text else ""
            if first_line.startswith("{") or first_line.startswith("["):
                lines = _extract_lines(node)
                json_lines.extend(lines)
                json_page = node.get("_page")
                # 스타일: codeBlock이면 style, paragraph이면 첫 run에서 추출
                if node.get("style"):
                    json_style = node["style"]
                elif node.get("type") == "paragraph" and node.get("runs"):
                    r = node["runs"][0]
                    json_style = {"font": r.get("font",""), "size": r.get("size",0),
                                  "color": r.get("color","000000")}
                opens = text.count("{") + text.count("[")
                closes = text.count("}") + text.count("]")
                brace_depth = opens - closes
                if brace_depth <= 0:
                    _flush()
                continue

        # JSON과 무관한 노드
        if json_lines:
            _flush()
        result.append(node)

    if json_lines:
        _flush()

    return result


# ============================================================
# Phase C: 테이블 cross-page 병합
# ============================================================

def _tables_match(t1, t2):
    """두 테이블의 헤더 구조가 동일한지 (텍스트 또는 너비 비율)"""
    h1 = [c["header"] for c in t1["columns"]]
    h2 = [c["header"] for c in t2["columns"]]
    if len(h1) != len(h2):
        return False
    # 헤더 텍스트 동일
    if h1 == h2:
        return True
    # 너비 비율 비교 (±20%)
    w1 = [c["width"] for c in t1["columns"]]
    w2 = [c["width"] for c in t2["columns"]]
    total1 = sum(w1) or 1
    total2 = sum(w2) or 1
    for a, b in zip(w1, w2):
        r1 = a / total1
        r2 = b / total2
        if abs(r1 - r2) > 0.2:
            return False
    return True


def _row_matches_headers(row, columns):
    """행 텍스트가 헤더와 동일한지 (cross-page 중복 헤더 스킵용)"""
    if len(row) != len(columns):
        return False
    for i, cell in enumerate(row):
        cell_text = "".join(r["text"] for r in cell.get("runs", [])).strip()
        if cell_text != columns[i]["header"]:
            return False
    return True


def _headers_text_match(cols1, cols2):
    """두 테이블의 헤더 텍스트가 정확히 동일한지"""
    h1 = [c["header"] for c in cols1]
    h2 = [c["header"] for c in cols2]
    return h1 == h2


def _columns_to_row(columns):
    """columns의 header 텍스트를 IR 행(runs 배열)으로 변환"""
    return [{"runs": [{"text": c["header"]}]} for c in columns]


def merge_cross_page_tables(content):
    """연속 테이블의 헤더+너비 비교 → cross-page 분할 테이블 병합.

    병합 조건:
    1. 연속 table 노드 (사이에 다른 노드 없음)
    2. 헤더 구조 동일 (_tables_match) — 텍스트 or 너비 비율
    3. 같은 _page이거나 _page가 1 차이 (cross-page)
    4. _singleRow 테이블(0행): 헤더를 데이터 행으로 변환하여 병합
    5. N행 연속 테이블: 가짜 헤더(첫 행이 실제 데이터)를 행으로 복원
    """
    if not content:
        return content

    merged = []
    i = 0
    while i < len(content):
        node = content[i]
        if node.get("type") == "table":
            # 0행 + _singleRow가 아닌 빈 테이블 스킵
            if not node.get("rows") and not node.get("_singleRow"):
                i += 1
                continue
            # _singleRow이면서 첫 테이블(앞에 병합 대상 없음): merged에 넣지 않고 다음에서 처리
            # → 아래 while에서 선행 테이블과 합침
            # 다음 노드와 병합 시도
            while i + 1 < len(content):
                next_node = content[i + 1]
                if next_node.get("type") != "table":
                    break
                # 페이지 차이 체크 (같은 페이지 또는 1페이지 차이만)
                cur_page = node.get("_page")
                next_page = next_node.get("_page")
                if cur_page is not None and next_page is not None:
                    if abs(next_page - cur_page) > 1:
                        break
                # 0행 _singleRow: 헤더를 데이터 행으로 변환하여 병합
                if not next_node.get("rows") and next_node.get("_singleRow"):
                    if _tables_match(node, next_node):
                        node["rows"].append(_columns_to_row(next_node["columns"]))
                        # rowHeights 병합 (_singleRow는 1행 = rowHeights[0])
                        next_rh = next_node.get("rowHeights", [])
                        if next_rh and node.get("rowHeights") is not None:
                            node["rowHeights"].append(next_rh[0])
                        i += 1
                        continue
                    else:
                        break
                # 0행이고 _singleRow 아님: 스킵
                if not next_node.get("rows"):
                    i += 1
                    continue
                if not _tables_match(node, next_node):
                    break
                # 병합: 가짜 헤더 복구 + 중복 헤더 스킵
                next_rows = next_node["rows"]
                next_rh = list(next_node.get("rowHeights", []))
                if next_rows and _row_matches_headers(next_rows[0], node["columns"]):
                    next_rows = next_rows[1:]
                    if next_rh:
                        next_rh = next_rh[1:]  # 중복 헤더 높이도 스킵
                # 헤더 텍스트가 다르면 = 가짜 헤더(실제 데이터) → 행으로 선행 삽입
                if not _headers_text_match(node["columns"], next_node["columns"]):
                    node["rows"].append(_columns_to_row(next_node["columns"]))
                    # 가짜 헤더의 높이 = next_rh[0] (헤더 행 높이)
                    if next_rh and node.get("rowHeights") is not None:
                        node["rowHeights"].append(next_rh[0])
                node["rows"].extend(next_rows)
                # rowHeights 병합 (데이터 행 높이들)
                if node.get("rowHeights") is not None and next_rh:
                    # next_rh[0]은 헤더(이미 처리), [1:]은 데이터 행
                    data_rh = next_rh[1:] if _headers_text_match(node["columns"], next_node["columns"]) else next_rh[1:]
                    node["rowHeights"].extend(data_rh)
                i += 1
            merged.append(node)
        else:
            merged.append(node)
        i += 1

    return merged


# ============================================================
# Phase D: bold 라벨 → H4 승격
# ============================================================

def promote_bold_labels(content):
    """bold + 짧은 줄 + 다음이 테이블 → H4"""
    for i, node in enumerate(content):
        if node.get("type") != "paragraph":
            continue
        runs = node.get("runs", [])
        if not runs:
            continue
        text = "".join(r["text"] for r in runs).strip()
        all_bold = all(r.get("bold") for r in runs)
        if all_bold and len(text) < 60 and i + 1 < len(content):
            if content[i + 1].get("type") == "table":
                content[i] = {"type": "heading", "level": 4, "text": text,
                              "_page": node.get("_page")}
    return content


# ============================================================
# 페이지 경계 pageBreak 삽입
# ============================================================

def insert_page_breaks(content):
    """페이지 전환 시 H2 heading 앞에 pageBreak 삽입 (연속 방지)"""
    if not content:
        return content

    result = []
    prev_page = content[0].get("_page")

    for node in content:
        cur_page = node.get("_page")
        if cur_page is not None and prev_page is not None and cur_page != prev_page:
            # 페이지가 바뀌었고, H2 heading이면 pageBreak 삽입
            if node.get("type") == "heading" and node.get("level") == 2:
                # 직전이 이미 pageBreak이면 스킵
                if not result or result[-1].get("type") != "pageBreak":
                    result.append({"type": "pageBreak"})
        result.append(node)
        if cur_page is not None:
            prev_page = cur_page

    return result


# ============================================================
# _page 메타 정리
# ============================================================

def strip_internal_meta(content):
    """내부 전용 _mono_style 등 제거 (_page는 DOCX 페이지 경계용으로 유지)"""
    for node in content:
        node.pop("_mono_style", None)
    return content


# ============================================================
# 메인
# ============================================================

def extract_meta(pdf_path):
    """--meta-only: LLM 분류용 메타데이터만 추출"""
    doc = fitz.open(pdf_path)

    # 폰트 크기 분포 (전체 페이지)
    size_data = {}  # size → { count, bold_count, samples[] }
    for page in doc:
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                line_text = "".join(s["text"] for s in line.get("spans", [])).strip()
                if not line_text:
                    continue
                for span in line.get("spans", []):
                    size = round(span["size"], 1)
                    key = str(size)
                    if key not in size_data:
                        size_data[key] = {"count": 0, "bold_count": 0, "samples": []}
                    text = span["text"].strip()
                    size_data[key]["count"] += len(text)
                    if _is_bold(span):
                        size_data[key]["bold_count"] += len(text)
                    if text and len(size_data[key]["samples"]) < 3 and len(text) > 2:
                        size_data[key]["samples"].append(line_text[:80])

    # 첫 3페이지 텍스트
    first_pages = []
    for i in range(min(3, len(doc))):
        page = doc[i]
        text = page.get_text().strip()
        images = len(page.get_images(full=False))
        first_pages.append({
            "page": i,
            "text": text[:500],
            "text_length": len(text),
            "image_count": images,
        })

    page_count = len(doc)
    meta_title = doc.metadata.get("title", "") if doc.metadata else ""
    doc.close()

    return {
        "pageCount": page_count,
        "metaTitle": meta_title,
        "fontDistribution": size_data,
        "firstPages": first_pages,
    }


def extract_pdf_ir(pdf_path, image_dir=None, classify=None):
    """PDF → IR JSON 변환.

    classify가 주어지면 LLM 분류 결과를 사용:
      { "levelMap": {"12": 2, "10": 3}, "coverPages": [0], "tocPages": [1] }
    classify가 없으면 기존 휴리스틱으로 fallback.
    """
    doc = fitz.open(pdf_path)
    warnings = []

    # Phase A: 표지/목차 감지
    if classify:
        skip_pages = set(classify.get("coverPages", []) + classify.get("tocPages", []))
        is_cover = len(classify.get("coverPages", [])) > 0
        cover_title = extract_cover_title(doc) if is_cover else ""
    else:
        is_cover = detect_cover_page(doc)
        skip_pages = set()
        cover_title = ""
        if is_cover:
            skip_pages.add(0)
            cover_title = extract_cover_title(doc)
            toc_pages = detect_toc_pages(doc, start_idx=1)
            skip_pages.update(toc_pages)

    # PDF 내장 TOC 보너스 경로
    toc = doc.get_toc()
    toc_level_map = {}
    if toc:
        for level, title, _page_num in toc:
            toc_level_map[title.strip()] = level

    # heading level_map
    if classify and classify.get("levelMap"):
        # LLM이 결정한 크기→레벨 매핑
        level_map = {int(float(k)): v for k, v in classify["levelMap"].items()}
        body_size, _ = identify_headers(doc, skip_pages)
    else:
        body_size, level_map = identify_headers(doc, skip_pages)

    skip_lines = collect_skip_lines(doc)
    base_margin, right_margin, page_width_calc = _calculate_margins(doc, skip_pages, body_size)
    line_spacing = _calculate_line_spacing(doc, skip_pages, body_size)

    # 문서 제목
    meta_title = doc.metadata.get("title", "") if doc.metadata else ""
    if not meta_title and cover_title:
        meta_title = cover_title

    content = []
    headings = []

    for page_num, page in enumerate(doc):
        # 표지/목차 스킵
        if page_num in skip_pages:
            continue
        prev_bottom_y = None  # 페이지마다 리셋

        # 다단 감지
        num_cols = detect_columns(page)
        if num_cols > 2:
            warnings.append({
                "type": "approximation",
                "element": "layout",
                "message": f"페이지 {page_num + 1}: {num_cols}단 레이아웃 감지, 2단까지만 지원"
            })

        # pdfminer faux bold 맵 (페이지당 1회, 전 요소 공유)
        faux_bold_map = _build_faux_bold_map(pdf_path, page_num, page.rect.height)

        # 테이블 감지
        tables = page.find_tables()
        table_rects = [fitz.Rect(t.bbox) for t in tables]

        # 요소 수집
        page_elements = []

        page_dict = page.get_text("dict")
        text_blocks = [b for b in page_dict["blocks"] if b["type"] == 0]
        page_drawings = page.get_drawings()  # 페이지당 1회 캐싱

        for block in text_blocks:
            # 테이블 영역 내 텍스트 블록은 메인 루프에서 제외 (prev_bottom_y 오염 방지)
            block_rect = fitz.Rect(block["bbox"])
            if any(tr.intersects(block_rect) for tr in table_rects):
                continue
            page_elements.append({
                "kind": "text", "y0": block["bbox"][1], "x0": block["bbox"][0], "data": block
            })

        for table in tables:
            table_rect = fitz.Rect(table.bbox)
            table_draws = [d for d in page_drawings
                           if d.get("fill") and fitz.Rect(d["rect"]).intersects(table_rect)]
            page_elements.append({
                "kind": "table", "y0": table.bbox[1], "x0": table.bbox[0],
                "data": table, "drawings": table_draws
            })

        for img in page.get_images(full=False):
            xref = img[0]
            rects = page.get_image_rects(xref)
            if rects:
                rect = rects[0]
                page_elements.append({
                    "kind": "image", "y0": rect.y0, "x0": rect.x0, "data": (xref, rect)
                })

        # 다단 정렬
        page_elements = sort_by_column(page_elements, min(num_cols, 2), page.rect.width)

        # 노드 생성
        for elem in page_elements:
            if elem["kind"] == "text":
                block = elem["data"]
                spacing_before = None
                if prev_bottom_y is not None:
                    gap = round(block["bbox"][1] - prev_bottom_y)
                    if gap > 0:
                        spacing_before = min(gap, 100)
                nodes = process_text_block(
                    block, level_map, body_size, skip_lines, table_rects, page_num,
                    base_margin=base_margin, page_width=page_width_calc,
                    right_margin=right_margin, spacing_before=spacing_before,
                    faux_bold_map=faux_bold_map
                )
                # PDF TOC 보너스: TOC에 있는 제목은 레벨 보정
                for node in nodes:
                    if node.get("type") == "heading" and node["text"].strip() in toc_level_map:
                        toc_level = toc_level_map[node["text"].strip()]
                        # TOC 레벨이 더 정확 (H1은 H2로 매핑 — 표지 정책)
                        node["level"] = max(toc_level, 2) if is_cover else toc_level
                content.extend(nodes)
                prev_bottom_y = block["bbox"][3]
            elif elem["kind"] == "table":
                node = process_table(elem["data"], page_num, page,
                                     drawings=elem.get("drawings"),
                                     text_blocks=text_blocks,
                                     faux_bold_map=faux_bold_map)
                if node:
                    content.append(node)
                prev_bottom_y = elem["data"].bbox[3]
            elif elem["kind"] == "image":
                xref, rect = elem["data"]
                # spacingBefore
                if prev_bottom_y is not None:
                    gap = round(rect.y0 - prev_bottom_y)
                    if gap > 0:
                        img_spacing = min(gap, 100)
                    else:
                        img_spacing = None
                else:
                    img_spacing = None
                node = process_image(doc, xref, rect, image_dir, page_num)
                if img_spacing is not None:
                    node["spacingBefore"] = img_spacing
                content.append(node)
                prev_bottom_y = rect.y1

    # 후처리 파이프라인
    content = merge_mono_lines(content)          # 모노 줄 → codeBlock
    content = merge_list_items(content)           # listItem → list
    content = detect_json_blocks(content)         # JSON 패턴 → codeBlock
    # content = merge_cross_page_tables(content)  # 비활성화: 페이지별 section 방식에서는 불필요
    content = promote_bold_labels(content)        # bold 라벨 → H4
    # pageBreak는 IR transformer가 처리 (PDF 파서에서 중복 삽입 방지)
    content = strip_internal_meta(content)        # _page 제거

    # headings 추출
    for node in content:
        if node.get("type") == "heading":
            headings.append({"level": node["level"], "text": node["text"]})

    if not meta_title and headings:
        meta_title = headings[0]["text"]

    page_count = len(doc)
    # 페이지 치수 + 여백 (본문 페이지들에서 추정)
    first_content_page = 0
    for i in range(len(doc)):
        if i not in skip_pages:
            first_content_page = i
            break
    pg = doc[first_content_page]
    page_width = round(pg.rect.width, 1)
    page_height = round(pg.rect.height, 1)

    # 여백: 모든 본문 페이지에서 텍스트/테이블의 min/max 좌표로 추정
    min_x, max_x = page_width, 0
    min_y, max_y = page_height, 0
    for i in range(len(doc)):
        if i in skip_pages:
            continue
        p = doc[i]
        for b in p.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            bx0, by0, bx1, by1 = b["bbox"]
            if bx0 < min_x: min_x = bx0
            if bx1 > max_x: max_x = bx1
            if by0 < min_y: min_y = by0
            if by1 > max_y: max_y = by1
        for t in p.find_tables().tables:
            if t.bbox[0] < min_x: min_x = t.bbox[0]
            if t.bbox[2] > max_x: max_x = t.bbox[2]
            if t.bbox[1] < min_y: min_y = t.bbox[1]
            if t.bbox[3] > max_y: max_y = t.bbox[3]

    margins = {
        "left": round(min_x),
        "right": round(page_width - max_x),
        "top": round(min_y),
        "bottom": round(page_height - max_y),
    }

    doc.close()

    meta = {
        "title": meta_title,
        "pageCount": page_count,
        "pageWidth": page_width,
        "pageHeight": page_height,
        "margins": margins,
    }
    if line_spacing is not None:
        meta["lineSpacing"] = line_spacing

    return {
        "meta": meta,
        "content": content,
        "headings": headings,
        "warnings": warnings,
    }


if __name__ == "__main__":
    import io
    import contextlib

    if len(sys.argv) < 2:
        print("사용법: python -X utf8 tools/extract-pdf-ir.py <파일.pdf> --json [--meta-only] [--classify <json>] [--image-dir <dir>]")
        sys.exit(1)

    pdf_path = sys.argv[1]
    json_mode = "--json" in sys.argv
    meta_only = "--meta-only" in sys.argv

    image_dir = None
    if "--image-dir" in sys.argv:
        idx = sys.argv.index("--image-dir")
        if idx + 1 < len(sys.argv):
            image_dir = sys.argv[idx + 1]

    classify = None
    if "--classify" in sys.argv:
        idx = sys.argv.index("--classify")
        if idx + 1 < len(sys.argv):
            classify = json.loads(sys.argv[idx + 1])

    # pymupdf가 stdout에 "Consider using pymupdf_layout..." 을 출력하므로
    # 파싱 중 stdout을 차단하고, 결과만 깨끗하게 출력
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        if meta_only:
            result = extract_meta(pdf_path)
        else:
            result = extract_pdf_ir(pdf_path, image_dir, classify)

    # 깨끗한 stdout으로 결과 출력
    if meta_only or json_mode:
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(f"Pages: {result['meta']['pageCount']}\n")
        sys.stdout.write(f"Content nodes: {len(result['content'])}\n")
        sys.stdout.write(f"Headings: {len(result['headings'])}\n")
        sys.stdout.write(f"Warnings: {len(result['warnings'])}\n")
        for h in result["headings"]:
            sys.stdout.write(f"  H{h['level']}: {h['text']}\n")

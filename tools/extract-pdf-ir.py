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


def _is_bold(span):
    """flags bit4 (bold) 판정 — PDF 표준"""
    return bool(span.get("flags", 0) & 16) or "Bold" in span.get("font", "")


def _span_style(span):
    """span에서 스타일 속성 추출"""
    style = {
        "font": span.get("font", ""),
        "size": round(span["size"], 1),
        "color": f"{span.get('color', 0) & 0xFFFFFF:06X}",
    }
    if _is_bold(span):
        style["bold"] = True
    if span.get("flags", 0) & 2:
        style["italic"] = True
    if _is_mono_span(span):
        style["mono"] = True
    return style


def _line_style(spans):
    """줄의 대표 스타일 (첫 span 기준)"""
    if not spans:
        return {}
    return _span_style(spans[0])


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
                       spacing_before=None):
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
        primary_size = round(spans[0]["size"])

        style = _line_style(spans)

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
            nodes.append(h_node)
            continue

        # 3) 불릿/리스트 감지 (섹션 번호 heading이 아닌 것만)
        if BULLET_PATTERN.match(line_text) or NUMBERED_LIST_PATTERN.match(line_text):
            nodes.append({"type": "listItem", "runs": [{"text": line_text}],
                          "style": style, "_page": page_num})
            continue

        # 코드블록 감지 (flags bit3 모노스페이스)
        if all(_is_mono_span(s) for s in spans):
            nodes.append({"_mono_line": line_text, "_mono_style": _span_style(spans[0]),
                          "_page": page_num})
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
            run = {"text": text, "font": span.get("font", ""),
                   "size": round(span["size"], 1),
                   "color": f"{span.get('color', 0) & 0xFFFFFF:06X}"}
            if _is_bold(span):
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
            # spacingBefore (heading 제외 — heading은 자체 spacing)
            if not spacing_applied and spacing_before is not None and p_node.get("type") != "heading":
                p_node["spacingBefore"] = spacing_before
                spacing_applied = True
            nodes.append(p_node)

    return nodes


def process_table(table, page_num, page=None, drawings=None, text_blocks=None):
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

    # 컬럼/행 경계 추출: t.cols → drawings fallback → 균등 분배
    grid_cols = None
    grid_rows = None
    if hasattr(table, 'cols') and table.cols and isinstance(table.cols[0], (int, float)):
        grid_cols = list(table.cols)
    if hasattr(table, 'rows') and table.rows and isinstance(table.rows[0], (int, float)):
        grid_rows = list(table.rows)

    # drawings fallback (t.cols가 없거나 숫자가 아닐 때)
    if grid_cols is None and drawings:
        dc, dr = _extract_table_grid(table, drawings)
        if dc and len(dc) >= col_count + 1:
            grid_cols = dc
        elif dc and len(dc) >= 2:
            grid_cols = dc
        if dr and len(dr) >= 2:
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
            table_style["font"] = sorted(fonts)[0]
        if sizes:
            table_style["size"] = max(set(sizes), key=sizes.count)
        if header_total > 0:
            table_style["headerBold"] = header_bold_count > header_total * 0.5
        # headerColor
        header_colors = [f"{s['color'] & 0xFFFFFF:06X}" for s in header_spans_list if s["text"].strip()]
        if header_colors:
            most_common_color = max(set(header_colors), key=header_colors.count)
            if most_common_color != "000000":
                table_style["headerColor"] = most_common_color

    # cellPadding (첫 셀 bbox 기준, 헤더 행 — 오차 가능)
    if (blocks_to_scan and grid_cols and grid_rows
            and len(grid_cols) >= 2 and len(grid_rows) >= 2):
        cell0_rect = fitz.Rect(grid_cols[0], grid_rows[0], grid_cols[1], grid_rows[1])
        spans_in_cell0 = _find_spans_in_rect(blocks_to_scan, cell0_rect)
        if spans_in_cell0:
            s = spans_in_cell0[0]
            pl = round(s["bbox"][0] - grid_cols[0])
            pt_ = round(s["bbox"][1] - grid_rows[0])
            table_style["cellPadding"] = {
                "left": max(pl, 0), "top": max(pt_, 0),
                "right": max(pl, 0), "bottom": max(pt_, 0),
            }

    # 셀 align (grid_cols + grid_rows 있을 때만)
    if (blocks_to_scan and grid_cols and grid_rows
            and len(grid_cols) > 1 and len(grid_rows) > 1):
        n_rows_a = len(grid_rows) - 1
        n_cols_a = len(grid_cols) - 1
        for row_idx in range(min(n_rows_a, len(ir_rows))):
            for col_idx in range(min(n_cols_a, col_count)):
                cell_rect = fitz.Rect(
                    grid_cols[col_idx], grid_rows[row_idx],
                    grid_cols[col_idx + 1], grid_rows[row_idx + 1]
                )
                cell_width = cell_rect.width
                cell_center = (cell_rect.x0 + cell_rect.x1) / 2
                spans = _find_spans_in_rect(blocks_to_scan, cell_rect)
                if not spans:
                    continue
                s = spans[0]
                scx = (s["bbox"][0] + s["bbox"][2]) / 2
                if abs(scx - cell_center) < cell_width * 0.2:
                    ir_rows[row_idx][col_idx]["align"] = "center"
                elif s["bbox"][2] > cell_rect.x1 - 5 and s["bbox"][0] > cell_center:
                    ir_rows[row_idx][col_idx]["align"] = "right"

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
    """연속 모노스페이스 줄 → codeBlock 노드로 병합"""
    merged = []
    code_lines = []
    code_page = None
    code_style = None

    for node in nodes:
        if "_mono_line" in node:
            code_lines.append(node["_mono_line"])
            if code_page is None:
                code_page = node.get("_page")
            if code_style is None:
                code_style = node.get("_mono_style")
        else:
            if code_lines:
                cb = {"type": "codeBlock", "lines": code_lines,
                      "language": "", "_page": code_page}
                if code_style:
                    cb["style"] = code_style
                merged.append(cb)
                code_lines = []
                code_page = None
                code_style = None
            merged.append(node)

    if code_lines:
        cb = {"type": "codeBlock", "lines": code_lines,
              "language": "", "_page": code_page}
        if code_style:
            cb["style"] = code_style
        merged.append(cb)

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

        # JSON 진행 중 → 모든 텍스트 노드를 흡수
        if brace_depth > 0 and text is not None:
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


def merge_cross_page_tables(content):
    """연속 테이블의 헤더+너비 비교 → 동일 구조면 행 병합"""
    if not content:
        return content

    merged = []
    i = 0
    while i < len(content):
        node = content[i]
        if node.get("type") == "table":
            # 다음 노드도 테이블이고 동일 구조면 병합
            while i + 1 < len(content):
                next_node = content[i + 1]
                if next_node.get("type") != "table":
                    break
                if not _tables_match(node, next_node):
                    break
                # 병합: 중복 헤더 행 스킵
                next_rows = next_node["rows"]
                if next_rows and _row_matches_headers(next_rows[0], node["columns"]):
                    next_rows = next_rows[1:]
                node["rows"].extend(next_rows)
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
    """내부 전용 _page, _mono_style 등 제거"""
    for node in content:
        node.pop("_page", None)
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

        # 테이블 감지
        tables = page.find_tables()
        table_rects = [fitz.Rect(t.bbox) for t in tables]

        # 요소 수집
        page_elements = []

        page_dict = page.get_text("dict")
        text_blocks = [b for b in page_dict["blocks"] if b["type"] == 0]
        page_drawings = page.get_drawings()  # 페이지당 1회 캐싱

        for block in text_blocks:
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
                    if gap > body_size + 2:
                        spacing_before = min(gap, 100)
                nodes = process_text_block(
                    block, level_map, body_size, skip_lines, table_rects, page_num,
                    base_margin=base_margin, page_width=page_width_calc,
                    right_margin=right_margin, spacing_before=spacing_before
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
                                     text_blocks=text_blocks)
                if node:
                    content.append(node)
                prev_bottom_y = elem["data"].bbox[3]
            elif elem["kind"] == "image":
                xref, rect = elem["data"]
                node = process_image(doc, xref, rect, image_dir, page_num)
                content.append(node)

    # 후처리 파이프라인
    content = merge_mono_lines(content)          # 모노 줄 → codeBlock
    content = merge_list_items(content)           # listItem → list
    content = detect_json_blocks(content)         # JSON 패턴 → codeBlock
    content = merge_cross_page_tables(content)    # 테이블 cross-page 병합
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

    # 여백: 본문 페이지 텍스트 블록의 min/max 좌표에서 추정
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
        if i >= first_content_page + 4:
            break  # 5페이지면 충분

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

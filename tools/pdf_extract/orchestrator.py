"""pdf_extract/orchestrator.py — PDF → IR 추출 메인 오케스트레이터"""

import os
import json
import base64
import re
from collections import Counter

import fitz

from .constants import SECTION_NUM_PATTERN, FONT_MAP
from .document_metrics import calculate_margins, calculate_line_spacing
from .page_analysis import (
    detect_cover_page, detect_toc_pages, extract_cover_title,
    identify_headers, collect_skip_lines, detect_columns, sort_by_column,
)
from .text_styling import is_bold, map_font_name, span_style
from .font_detection import build_faux_bold_map
from .text_processor import process_text_block
from .table_processor import process_table
from .image_processor import process_image
from .ir_postprocessor import (
    merge_mono_lines, merge_list_items, detect_json_blocks,
    promote_bold_labels, strip_internal_meta,
    _absorb_zero_row_fragments as absorb_zero_row_fragments,
)


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

    skip_lines, hdr_ftr_info = collect_skip_lines(doc)
    base_margin, right_margin, page_width_calc = calculate_margins(doc, skip_pages, body_size)
    line_spacing = calculate_line_spacing(doc, skip_pages, body_size)

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
        faux_bold_map = build_faux_bold_map(pdf_path, page_num, page.rect.height)

        # 테이블 감지
        tables = page.find_tables()
        table_rects = [fitz.Rect(t.bbox) for t in tables]

        # 요소 수집
        page_elements = []

        page_dict = page.get_text("dict")
        text_blocks = [b for b in page_dict["blocks"] if b["type"] == 0]
        page_drawings = page.get_drawings()  # 페이지당 1회 캐싱

        # 같은 y좌표의 line을 합치기 (다른 block이지만 같은 줄인 경우)
        # 예: "This specification..." (block A) + "[RFC5234]" (block B) → 같은 y → 하나의 line
        # header/footer 영역(상단 60pt, 하단 60pt)은 합치지 않음 (skip_lines 매칭 보존)
        page_h = page.rect.height
        hdr_limit = 60  # header 영역 상한
        ftr_limit = page_h - 60  # footer 영역 하한
        all_lines = []  # (y, x, line_dict, block_bbox, is_hdrftr)
        for block in text_blocks:
            block_rect = fitz.Rect(block["bbox"])
            if any(tr.intersects(block_rect) for tr in table_rects):
                continue
            for line in block.get("lines", []):
                y = round(line["bbox"][1], 1)
                x = line["bbox"][0]
                is_hf = (y < hdr_limit or y > ftr_limit)
                all_lines.append((y, x, line, block["bbox"], is_hf))

        # y좌표 기준 그룹핑 (2pt 이내면 같은 줄)
        all_lines.sort(key=lambda t: (t[0], t[1]))
        merged_blocks = []
        current_y = None
        current_lines = []
        for y, x, line, bbx, is_hf in all_lines:
            if current_y is not None and abs(y - current_y) < 2 and not is_hf:
                # 같은 줄 — spans 합침 (header/footer는 합치지 않음)
                current_lines[-1]["spans"].extend(line.get("spans", []))
                # bbox 확장
                cur_bb = current_lines[-1]["bbox"]
                ln_bb = line["bbox"]
                current_lines[-1]["bbox"] = [
                    min(cur_bb[0], ln_bb[0]), min(cur_bb[1], ln_bb[1]),
                    max(cur_bb[2], ln_bb[2]), max(cur_bb[3], ln_bb[3])
                ]
            else:
                # 새 줄
                merged_line = {
                    "spans": list(line.get("spans", [])),
                    "bbox": list(line["bbox"]),
                }
                current_lines.append(merged_line)
                current_y = y

        # 합친 line들을 block으로 재구성 (연속 y → 같은 block)
        if current_lines:
            block_lines = []
            prev_y = None
            for ml in current_lines:
                y = ml["bbox"][1]
                # 줄 간격이 크면 (50pt+) 새 block
                if prev_y is not None and y - prev_y > 50:
                    if block_lines:
                        bb = [
                            min(l["bbox"][0] for l in block_lines),
                            min(l["bbox"][1] for l in block_lines),
                            max(l["bbox"][2] for l in block_lines),
                            max(l["bbox"][3] for l in block_lines),
                        ]
                        merged_blocks.append({"type": 0, "lines": block_lines, "bbox": bb})
                    block_lines = []
                block_lines.append(ml)
                prev_y = y
            if block_lines:
                bb = [
                    min(l["bbox"][0] for l in block_lines),
                    min(l["bbox"][1] for l in block_lines),
                    max(l["bbox"][2] for l in block_lines),
                    max(l["bbox"][3] for l in block_lines),
                ]
                merged_blocks.append({"type": 0, "lines": block_lines, "bbox": bb})

        for block in merged_blocks:
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
                    # 테이블 spacingBefore: 이전 요소와의 간격
                    if prev_bottom_y is not None:
                        tbl_gap = round(elem["data"].bbox[1] - prev_bottom_y)
                        if tbl_gap > 0:
                            node["spacingBefore"] = min(tbl_gap, 100)
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
                # 이미지 center 감지: 이미지 중심이 페이지 중심 근처이면 center
                img_cx = (rect.x0 + rect.x1) / 2
                page_cx = page.rect.width / 2
                if abs(img_cx - page_cx) < page.rect.width * 0.1:
                    node["align"] = "center"
                content.append(node)
                prev_bottom_y = rect.y1

    # 후처리 파이프라인
    content = merge_mono_lines(content)          # 모노 줄 → codeBlock
    content = merge_list_items(content)           # listItem → list
    content = detect_json_blocks(content)         # JSON 패턴 → codeBlock
    # content = merge_cross_page_tables(content)  # 비활성화: 페이지별 section 방식에서는 불필요
    content = absorb_zero_row_fragments(content)  # 0-row fragment → 이전 테이블에 행으로 병합
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
        "left": round(base_margin),
        "right": round(page_width - max_x),
        "top": round(min_y),
        "bottom": round(page_height - max_y),
    }

    # 페이지별 margin (section별 동적 margin용)
    page_margins = {}
    doc2 = fitz.open(pdf_path)
    for i in range(len(doc2)):
        if i in skip_pages:
            continue
        p = doc2[i]
        p_min_y = page_height
        p_max_y = 0
        for b in p.get_text("dict")["blocks"]:
            if b["bbox"][1] < p_min_y: p_min_y = b["bbox"][1]
            if b["bbox"][3] > p_max_y: p_max_y = b["bbox"][3]
        for t in p.find_tables().tables:
            if t.bbox[1] < p_min_y: p_min_y = t.bbox[1]
            if t.bbox[3] > p_max_y: p_max_y = t.bbox[3]
        if p_max_y > p_min_y:
            page_margins[i] = {
                "top": round(p_min_y, 1),
                "bottom": round(page_height - p_max_y, 1),
            }
    doc2.close()

    meta = {
        "title": meta_title,
        "pageCount": page_count,
        "pageWidth": page_width,
        "pageHeight": page_height,
        "margins": margins,
        "pageMargins": page_margins,
    }
    if hdr_ftr_info.get("header"):
        meta["header"] = hdr_ftr_info["header"]
    if hdr_ftr_info.get("footer"):
        meta["footer"] = hdr_ftr_info["footer"]


    # 페이지 border box 감지 (content 영역 테두리)
    # 여러 페이지에서 동일한 회색 border rect 있으면 pageBorder로 저장
    if page_count >= 3:
        border_rects = Counter()
        for pi in range(1, min(10, page_count)):  # p2~10 샘플
            pg = doc[pi]
            for d in pg.get_drawings():
                f = d.get("fill")
                if not f or f == (1.0, 1.0, 1.0): continue
                for item in d.get("items", []):
                    if item[0] == "re":
                        r = item[1]
                        if r.width > page_width * 0.5 and r.height > page_height * 0.5:
                            # 큰 rect = border box 후보
                            color_hex = "%02X%02X%02X" % (int(f[0]*255), int(f[1]*255), int(f[2]*255))
                            border_rects[color_hex] += 1
        if border_rects:
            dominant_color = border_rects.most_common(1)[0]
            if dominant_color[1] >= 3:  # 3+ 페이지에서 반복
                meta["pageBorder"] = {"color": dominant_color[0]}
    if line_spacing is not None:
        meta["lineSpacing"] = line_spacing

    return {
        "meta": meta,
        "content": content,
        "headings": headings,
        "warnings": warnings,
    }



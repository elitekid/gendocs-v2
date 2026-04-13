"""pdf_extract/text_processor.py — 텍스트 블록 → IR 노드 변환"""

import re
import fitz

from .constants import SECTION_NUM_PATTERN
from .text_styling import is_mono_span, safe_get_text, is_bold, map_font_name, span_style, line_style, is_heading_candidate


def process_text_block(block, level_map, body_size, skip_lines, table_rects, page_num,
                       base_margin=72, page_width=792, right_margin=72,
                       spacing_before=None, faux_bold_map=None):
    """텍스트 블록 → IR 노드들"""
    nodes = []
    spacing_applied = False
    prev_line_bottom = None

    valid_lines = [l for l in block.get("lines", [])
                   if any(s["text"].strip() for s in l.get("spans", []))]
    line_count = len(valid_lines)

    for line in block.get("lines", []):
        spans = line.get("spans", [])
        if not spans:
            continue

        line_text = "".join(s["text"] for s in spans).rstrip()
        line_text_stripped = line_text.strip()
        if not line_text_stripped:
            continue

        primary_size = round(spans[0]["size"])
        if line_text_stripped in skip_lines and primary_size <= body_size:
            continue

        if re.match(r'^\d+\s*/\s*\d+$', line_text_stripped) or re.match(r'^\d+$', line_text_stripped):
            continue

        line_rect = fitz.Rect(line["bbox"])
        if any(tr.intersects(line_rect) for tr in table_rects):
            continue

        first_bold = is_bold(spans[0])
        if not first_bold and faux_bold_map:
            span_y = round(spans[0]["bbox"][1])
            if span_y in faux_bold_map:
                first_bold = True
        primary_size = round(spans[0]["size"])

        style = line_style(spans, faux_bold_map)

        # 1) 섹션 번호 heading
        sec_match = SECTION_NUM_PATTERN.match(line_text_stripped)
        if sec_match and len(line_text_stripped) < 80 and (first_bold or primary_size > body_size):
            num_str = sec_match.group(1).rstrip('.')
            depth = num_str.count('.') + 1
            sec_level = min(depth + 1, 5)
            h_node = {"type": "heading", "level": sec_level, "text": line_text_stripped,
                      "style": style, "_page": page_num}
            h_indent = round(spans[0]["bbox"][0] - base_margin)
            if h_indent > 5:
                h_node["indent"] = h_indent
            if not spacing_applied and spacing_before is not None:
                h_node["spacingBefore"] = spacing_before
            elif spacing_applied and prev_line_bottom is not None:
                lg = round(line["bbox"][1] - prev_line_bottom, 1)
                if lg > 0: h_node["spacingBefore"] = lg
            spacing_applied = True
            prev_line_bottom = line["bbox"][3]
            nodes.append(h_node)
            continue

        # 2) 크기 기반 heading
        level = is_heading_candidate(line_text_stripped, spans[0]["size"], body_size, level_map)
        if level is not None and 1 <= len(line_text_stripped) <= 120:
            h_node = {"type": "heading", "level": level, "text": line_text_stripped,
                      "style": style, "_page": page_num}
            h_indent = round(spans[0]["bbox"][0] - base_margin)
            if h_indent > 5:
                h_node["indent"] = h_indent
            if line_count == 1:
                h_cx = (line["bbox"][0] + line["bbox"][2]) / 2
                page_cx = (base_margin + page_width - right_margin) / 2
                if abs(h_cx - page_cx) < 20:
                    h_node["align"] = "center"
            if not spacing_applied and spacing_before is not None:
                h_node["spacingBefore"] = spacing_before
            elif spacing_applied and prev_line_bottom is not None:
                lg = round(line["bbox"][1] - prev_line_bottom, 1)
                if lg > 0: h_node["spacingBefore"] = lg
            spacing_applied = True
            prev_line_bottom = line["bbox"][3]
            nodes.append(h_node)
            continue

        # 코드블록 감지
        if is_mono_span(spans[0]):
            span_x = spans[0]["bbox"][0]
            font_size = spans[0].get("size", 11)
            mono_char_w = font_size * 0.6
            leading_spaces = len(line_text) - len(line_text.lstrip(' '))
            visual_x = span_x + leading_spaces * mono_char_w
            mono_x = round(visual_x - base_margin, 1)
            mono_node = {"_mono_line": line_text, "_mono_style": span_style(spans[0], faux_bold_map),
                        "_page": page_num, "_y": spans[0]["bbox"][1],
                        "_indent": max(0, mono_x)}
            if not spacing_applied and spacing_before is not None:
                mono_node["spacingBefore"] = spacing_before
            elif spacing_applied and prev_line_bottom is not None:
                lg = round(line["bbox"][1] - prev_line_bottom, 1)
                if lg > 0: mono_node["spacingBefore"] = lg
            spacing_applied = True
            prev_line_bottom = line["bbox"][3]
            nodes.append(mono_node)
            continue

        # callout 감지
        if re.match(r'^(참고|주의|중요|경고)\s*[:：]', line_text_stripped):
            variant = "warning" if re.match(r'^(주의|경고)', line_text_stripped) else "info"
            nodes.append({"type": "callout", "variant": variant,
                          "runs": [{"text": line_text}], "style": style, "_page": page_num})
            continue

        # 일반 paragraph
        runs = []
        for span in spans:
            text, font_info = safe_get_text(span)
            if text is None:
                continue
            run = {"text": text, "font": map_font_name(span.get("font", "")),
                   "size": round(span["size"], 1),
                   "color": f"{span.get('color', 0) & 0xFFFFFF:06X}"}
            bold = is_bold(span)
            if not bold and faux_bold_map:
                span_y = round(span["bbox"][1])
                bold = span_y in faux_bold_map
            if bold:
                run["bold"] = True
            if span.get("flags", 0) & 2:
                run["italic"] = True
            runs.append(run)

        if runs:
            p_node = {"type": "paragraph", "runs": runs, "_page": page_num}
            p_indent = round(spans[0]["bbox"][0] - base_margin)
            if p_indent > 5:
                p_node["indent"] = p_indent
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
            full_text = "".join(r["text"] for r in runs)
            dot_match = re.search(r'\.{5,}\s*(\d*)\s*$', full_text)
            if dot_match:
                clean_text = re.sub(r'\s*\.{3,}\s*\d*\s*$', '', full_text).rstrip()
                page_num_text = dot_match.group(1)
                p_node["runs"] = [{"text": clean_text, **{k: runs[0][k] for k in runs[0] if k != "text"}}]
                p_node["_dotLeader"] = True
                p_node["_dotLeaderPageNum"] = page_num_text
                p_node["_dotLeaderEnd"] = round(line["bbox"][2], 1)
                p_node["_marginLeft"] = round(base_margin, 1)
            if not spacing_applied and spacing_before is not None:
                p_node["spacingBefore"] = spacing_before
            elif spacing_applied and prev_line_bottom is not None:
                line_gap = round(line["bbox"][1] - prev_line_bottom, 1)
                if line_gap >= body_size:
                    p_node["spacingBefore"] = line_gap
            spacing_applied = True
            prev_line_bottom = line["bbox"][3]
            nodes.append(p_node)

    return nodes

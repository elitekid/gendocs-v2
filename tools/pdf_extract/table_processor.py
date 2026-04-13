"""pdf_extract/table_processor.py — 테이블 추출 + 스타일 감지"""

import fitz

from .text_styling import is_bold, map_font_name
from .font_detection import measure_cell_padding_pdfminer


def extract_table_grid(table, page_drawings):
    """drawings 세로선/가로선에서 컬럼·행 경계 추출.
    Returns (col_xs, row_ys).
    """
    trect = fitz.Rect(table.bbox)
    vertical_xs = set()
    horizontal_ys = set()

    for d in page_drawings:
        drect = fitz.Rect(d.get("rect", (0, 0, 0, 0)))
        if not trect.intersects(drect):
            continue
        for item in d.get("items", []):
            if item[0] == "l":
                p1, p2 = item[1], item[2]
                if abs(p1.x - p2.x) < 2:
                    vertical_xs.add(round(p1.x))
                elif abs(p1.y - p2.y) < 2:
                    horizontal_ys.add(round(p1.y))
            elif item[0] == "re":
                r = item[1]
                w, h = r.width, r.height
                if w < 3 and h > 5:
                    vertical_xs.add(round(r.x0))
                elif h < 3 and w > 5:
                    horizontal_ys.add(round(r.y0))

    vertical_xs.add(round(trect.x0))
    vertical_xs.add(round(trect.x1))
    horizontal_ys.add(round(trect.y0))
    horizontal_ys.add(round(trect.y1))

    col_xs = sorted(vertical_xs) if len(vertical_xs) >= 2 else None
    row_ys = sorted(horizontal_ys) if len(horizontal_ys) >= 2 else None
    return col_xs, row_ys


def find_spans_in_rect(text_blocks, rect):
    """text_blocks에서 rect 내부 span 반환"""
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


def process_table(table, page_num, page=None, drawings=None, text_blocks=None,
                   faux_bold_map=None):
    """pymupdf Table → IR table 노드"""
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

    # 컬럼/행 경계 추출
    grid_cols = None
    grid_rows = None

    if hasattr(table, 'cells') and table.cells:
        xs = sorted(set(round(c[0], 1) for c in table.cells) |
                     set(round(c[2], 1) for c in table.cells))
        ys = sorted(set(round(c[1], 1) for c in table.cells) |
                     set(round(c[3], 1) for c in table.cells))
        if len(xs) >= col_count + 1:
            grid_cols = xs
        if len(ys) >= 2:
            grid_rows = ys

    if grid_cols is None and drawings:
        dc, dr = extract_table_grid(table, drawings)
        if dc and len(dc) >= col_count + 1:
            grid_cols = dc
        elif dc and len(dc) >= 2:
            grid_cols = dc
        if grid_rows is None and dr and len(dr) >= 2:
            grid_rows = dr

    col_widths = []
    if grid_cols and len(grid_cols) >= col_count + 1:
        for j in range(col_count):
            w = round(grid_cols[j + 1] - grid_cols[j], 1)
            col_widths.append(w)
    if len(col_widths) != col_count:
        table_width = table.bbox[2] - table.bbox[0]
        col_widths = [round(table_width / col_count, 1)] * col_count

    columns = [{"header": h, "width": col_widths[i]} for i, h in enumerate(valid_headers)]

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

    # 테이블 스타일 추출
    table_style = {}
    blocks_to_scan = text_blocks if text_blocks else (
        [b for b in page.get_text("dict")["blocks"] if b["type"] == 0] if page else []
    )
    if blocks_to_scan:
        table_rect = fitz.Rect(table.bbox)
        fonts = set()
        sizes = []
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
                    if span["bbox"][1] < header_bottom:
                        header_total += 1
                        header_spans_list.append(span)
                        if is_bold(span):
                            header_bold_count += 1
        if fonts:
            table_style["font"] = map_font_name(sorted(fonts)[0])
        if sizes:
            table_style["size"] = max(set(sizes), key=sizes.count)
        if header_total > 0:
            if header_bold_count > header_total * 0.5:
                table_style["headerBold"] = True
            else:
                if faux_bold_map and header_spans_list:
                    first_hdr_y = round(header_spans_list[0]["bbox"][1])
                    table_style["headerBold"] = first_hdr_y in faux_bold_map
                else:
                    table_style["headerBold"] = False

        header_colors = [f"{s['color'] & 0xFFFFFF:06X}" for s in header_spans_list if s["text"].strip()]
        if header_colors:
            most_common_color = max(set(header_colors), key=header_colors.count)
            if most_common_color != "000000":
                table_style["headerColor"] = most_common_color

    # cellPadding
    if page and grid_cols and grid_rows and len(grid_cols) >= 2 and len(grid_rows) >= 3:
        tbl_pad, col_pads = measure_cell_padding_pdfminer(
            page.parent.name, page.number, page.rect.height,
            grid_cols, grid_rows, col_count)
        if tbl_pad:
            table_style["cellPadding"] = tbl_pad
        if col_pads:
            for ci, cp in enumerate(col_pads):
                if ci < len(columns):
                    columns[ci]["padding"] = cp

    # headerCenter 감지
    if (blocks_to_scan and grid_cols and grid_rows
            and len(grid_cols) > 1 and len(grid_rows) > 1):
        header_center_count = 0
        header_checked = 0
        for col_idx in range(min(len(grid_cols) - 1, col_count)):
            cell_rect = fitz.Rect(
                grid_cols[col_idx], grid_rows[0],
                grid_cols[col_idx + 1], grid_rows[1]
            )
            cell_center = (cell_rect.x0 + cell_rect.x1) / 2
            cell_width = cell_rect.width
            spans = find_spans_in_rect(blocks_to_scan, cell_rect)
            if spans:
                text_left = spans[0]["bbox"][0]
                text_right = spans[0]["bbox"][2]
                text_width = text_right - text_left
                if text_width > cell_width * 0.8:
                    continue
                header_checked += 1
                text_center = (text_left + text_right) / 2
                dist_to_center = abs(text_center - cell_center)
                dist_to_left = text_left - cell_rect.x0
                if dist_to_center < dist_to_left:
                    header_center_count += 1
        if header_checked > 0 and header_center_count > header_checked * 0.5:
            table_style["headerCenter"] = True

    # borderColor + cellBg
    if (drawings and grid_cols and grid_rows):
        table_rect = fitz.Rect(grid_cols[0], grid_rows[0], grid_cols[-1], grid_rows[-1])

        border_colors = {}
        for d in drawings:
            fill = d.get("fill")
            if not fill:
                continue
            d_rect = fitz.Rect(d["rect"])
            if not d_rect.intersects(table_rect):
                continue
            if min(d_rect.width, d_rect.height) < 2:
                hex_c = "".join(f"{int(c*255):02X}" for c in fill[:3])
                border_colors[hex_c] = border_colors.get(hex_c, 0) + 1
        if border_colors:
            dominant = max(border_colors, key=border_colors.get)
            if dominant != "000000":
                table_style["borderColor"] = dominant

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
    if len(data) == 1:
        node["_singleRow"] = True
    if table_style:
        node["style"] = table_style
    return node

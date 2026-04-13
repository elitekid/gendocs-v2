"""pdf_extract/font_detection.py — pdfminer 기반 faux bold / cell padding 감지"""


def build_faux_bold_map(pdf_path, page_num, page_height):
    """pdfminer로 페이지 내 faux bold 영역을 한 번에 수집.

    Returns: set of rounded pymupdf y좌표 (top-down).
    """
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTChar
    except ImportError:
        return set()

    bold_ys = set()
    try:
        for page_layout in extract_pages(pdf_path, page_numbers=[page_num]):
            def walk(obj):
                if isinstance(obj, LTChar):
                    lw = getattr(obj.graphicstate, 'linewidth', 0)
                    if lw and lw > 0:
                        pymupdf_y = round(page_height - obj.y1)
                        bold_ys.add(pymupdf_y)
                if hasattr(obj, '__iter__'):
                    for child in obj:
                        walk(child)
            walk(page_layout)
    except Exception:
        pass
    return bold_ys


def detect_faux_bold_header(page, table_bbox, header_bottom_y):
    """pdfminer.six로 faux bold (stroke 기반) 감지.
    헤더 영역의 글자 중 linewidth > 0인 비율이 50% 이상이면 bold.
    """
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTTextBox, LTTextLine, LTChar
    except ImportError:
        return False

    pdf_path = page.parent.name
    page_num = page.number
    page_height = page.rect.height

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


def measure_cell_padding_pdfminer(pdf_path, page_num, page_height,
                                   grid_cols, grid_rows, col_count):
    """pdfminer LTChar로 컬럼별 셀 패딩을 정확히 측정.

    Returns: (table_padding, column_paddings)
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
            if 0 <= r < 200: col_right[ci].append(r)
            if 0 <= t < 20: col_top[ci].append(t)
            if 0 <= b < 20: col_bottom[ci].append(b)

    column_paddings = []
    all_left = []
    all_top = []
    all_bottom = []
    for ci in range(n_cols):
        lp = round(min(col_left[ci]), 1) if col_left[ci] else 2.0
        tp = round(sorted(col_top[ci])[len(col_top[ci])//2], 1) if col_top[ci] else 2.0
        bp = round(sorted(col_bottom[ci])[len(col_bottom[ci])//2], 1) if col_bottom[ci] else 2.0
        rp = lp
        column_paddings.append({"left": lp, "top": tp, "right": rp, "bottom": bp})
        all_left.append(lp)
        all_top.append(tp)
        all_bottom.append(bp)

    all_left.sort()
    all_top.sort()
    all_bottom.sort()
    tbl_l = all_left[len(all_left)//2] if all_left else 2.0
    tbl_t = all_top[len(all_top)//2] if all_top else 2.0
    tbl_b = all_bottom[len(all_bottom)//2] if all_bottom else 2.0
    table_padding = {"left": tbl_l, "top": tbl_t, "right": tbl_l, "bottom": tbl_b}

    return table_padding, column_paddings

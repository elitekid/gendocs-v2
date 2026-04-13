"""pdf_extract/document_metrics.py — 마진/줄간격 계산"""


def calculate_margins(doc, skip_pages, body_size):
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


def calculate_line_spacing(doc, skip_pages, body_size):
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
            # Word 기준 line spacing 배율 = pitch / (fontSize * 1.2)
            word_standard = body_size * 1.2
            for i in range(1, len(lines)):
                pitch = lines[i]["bbox"][1] - lines[i-1]["bbox"][1]
                if word_standard > 0 and 0 < pitch < body_size * 3:
                    ratios.append(pitch / word_standard)
    if not ratios:
        return None
    ratios.sort()
    multiple = round(ratios[len(ratios) // 2], 2)
    return multiple if 0.8 <= multiple <= 3.0 else None

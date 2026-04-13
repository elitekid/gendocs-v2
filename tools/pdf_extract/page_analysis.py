"""pdf_extract/page_analysis.py — 표지/목차/헤더/다단 감지"""

import re
from collections import Counter

from .constants import DOTTED_LINE_PATTERN


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
            break
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


def identify_headers(doc, skip_pages=None):
    """본문 기준 heading 레벨 맵 결정.
    skip_pages로 표지/목차를 제외하고, body_size보다 큰 모든 크기를
    H2부터 매핑.
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
    header_sizes = sorted([s for s in size_counts if s >= body_size + 2], reverse=True)

    level_map = {}
    for i, size in enumerate(header_sizes):
        level = i + 2
        if level > 5:
            break
        level_map[size] = level

    return body_size, level_map


def collect_skip_lines(doc):
    """50%+ 반복 줄 수집 + header/footer 레이아웃 추출.

    Returns: (skip_lines_set, header_footer_info)
    """
    page_count = len(doc)
    if page_count < 3:
        return set(), {"header": [], "footer": []}

    line_counts = Counter()
    hdr_items = Counter()
    ftr_items = Counter()
    page_width = doc[0].rect.width
    page_height = doc[0].rect.height

    for page in doc:
        seen_on_page = set()
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block.get("lines", []):
                text = "".join(s["text"] for s in line.get("spans", [])).strip()
                if not text:
                    continue
                if text not in seen_on_page:
                    seen_on_page.add(text)
                    line_counts[text] += 1

                y = line["bbox"][1]
                x0 = line["bbox"][0]
                x1 = line["bbox"][2]
                cx = (x0 + x1) / 2
                if abs(cx - page_width / 2) < page_width * 0.1:
                    align = "center"
                elif x1 > page_width * 0.8:
                    align = "right"
                else:
                    align = "left"

                fs = line["spans"][0].get("size", 10)
                if fs <= 9:
                    if y < page_height * 0.08:
                        hdr_items[(text, align)] += 1
                    elif y > page_height * 0.85:
                        ftr_items[(text, align)] += 1

    threshold = page_count * 0.5
    skip_set = {text for text, count in line_counts.items() if count >= threshold}

    header = []
    footer = []
    for (text, align), cnt in hdr_items.most_common():
        if cnt >= threshold:
            header.append({"text": text, "align": align})

    page_num_aligns = Counter()
    for (text, align), cnt in ftr_items.items():
        if re.match(r"^Page \d+$", text):
            page_num_aligns[align] += cnt
    for align, cnt in page_num_aligns.items():
        if cnt >= threshold:
            footer.append({"text": "__PAGE__", "align": align})
            for i in range(1, page_count + 1):
                skip_set.add("Page %d" % i)

    for (text, align), cnt in ftr_items.most_common():
        if cnt >= threshold and not re.match(r"^Page \d+$", text):
            footer.append({"text": text, "align": align})

    seen_aligns_h = set()
    header_dedup = []
    for h in header:
        if h["align"] not in seen_aligns_h:
            header_dedup.append(h)
            seen_aligns_h.add(h["align"])
    seen_aligns_f = set()
    footer_dedup = []
    for f in footer:
        if f["align"] not in seen_aligns_f:
            footer_dedup.append(f)
            seen_aligns_f.add(f["align"])

    return skip_set, {"header": header_dedup, "footer": footer_dedup}


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

"""pdf_extract/text_styling.py — 폰트/볼드/모노/heading 판정 유틸"""

from .constants import FONT_MAP


def is_mono_span(span):
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


def is_bold(span):
    """flags bit4 (bold) 판정 — PDF 표준"""
    return bool(span.get("flags", 0) & 16) or "Bold" in span.get("font", "")


def map_font_name(raw_name):
    """PDF 폰트명에서 서브셋 접두사 제거 + Word 폰트명 매핑"""
    name = raw_name.split("+")[-1] if "+" in raw_name else raw_name
    return FONT_MAP.get(name, name)


def span_style(span, faux_bold_map=None):
    """span에서 스타일 속성 추출 (faux bold 포함)"""
    style = {
        "font": map_font_name(span.get("font", "")),
        "size": round(span["size"], 1),
        "color": f"{span.get('color', 0) & 0xFFFFFF:06X}",
    }
    if is_bold(span):
        style["bold"] = True
    elif faux_bold_map:
        span_y = round(span["bbox"][1])
        if span_y in faux_bold_map:
            style["bold"] = True
    if span.get("flags", 0) & 2:
        style["italic"] = True
    if is_mono_span(span):
        style["mono"] = True
    return style


def line_style(spans, faux_bold_map=None):
    """줄의 대표 스타일 (첫 span 기준)"""
    if not spans:
        return {}
    return span_style(spans[0], faux_bold_map)


def is_heading_candidate(line_text, font_size, body_size, level_map):
    """heading 후보인지 판정"""
    size = round(font_size)
    if size in level_map:
        return level_map[size]
    if size >= body_size + 2:
        if size >= body_size + 6:
            return 2
        elif size >= body_size + 4:
            return 3
        else:
            return 4
    return None

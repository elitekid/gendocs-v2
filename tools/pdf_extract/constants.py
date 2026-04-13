"""pdf_extract/constants.py — 공유 상수 및 패턴"""

import re

BULLET_PATTERN = re.compile(r'^[\-·•▪▸►●○◆◇→☞✓✔★☐☑]\s')
NUMBERED_LIST_PATTERN = re.compile(r'^(\d+[\.\)]\s|[a-zA-Z][\.\)]\s)')
DOTTED_LINE_PATTERN = re.compile(r'\.{5,}|…{3,}|·{5,}')
SECTION_NUM_PATTERN = re.compile(r'^(\d+\.(?:\d+\.?)*)\s')

# PDF 내부 폰트명 → Word 인식 폰트명
FONT_MAP = {
    "MalgunGothic": "맑은 고딕",
    "MalgunGothicBold": "맑은 고딕",
    "Gulim": "Gulim",
    "GulimChe": "GulimChe",
    "Dotum": "Dotum",
    "DotumChe": "DotumChe",
    "Batang": "Batang",
}

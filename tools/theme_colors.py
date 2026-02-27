"""
테마 JSON에서 분류용 색상 세트를 동적으로 생성하는 공유 모듈.

사용법:
    from theme_colors import load_theme_color_sets
    colors = load_theme_color_sets()
    # colors['dark_codes'], colors['light_codes'], colors['info_boxes'],
    # colors['warning_boxes'], colors['header_bgs']
"""

import os
import json
import glob


def _tint(hex_color, factor):
    """hex 색상을 white 방향으로 혼합 (Word tint). # 없이 입출력."""
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)
    tr = round(r + (255 - r) * factor)
    tg = round(g + (255 - g) * factor)
    tb = round(b + (255 - b) * factor)
    return f'{tr:02X}{tg:02X}{tb:02X}'


def _shade(hex_color, factor):
    """hex 색상을 black 방향으로 혼합 (Word shade). # 없이 입출력."""
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)
    sr = round(r * (1 - factor))
    sg = round(g * (1 - factor))
    sb = round(b * (1 - factor))
    return f'{sr:02X}{sg:02X}{sb:02X}'


def _derive_colors_from_slots(slots, overrides=None):
    """12슬롯에서 30키 colors 파생 (theme-utils.js deriveColors의 Python 포팅)."""
    colors = {
        'primary': slots['dk2'],
        'secondary': slots['accent1'],
        'accent': slots['accent2'],
        'text': slots['dk1'],
        'white': slots['lt1'],
        'altRow': slots['lt2'],
        'textLight': _tint(slots['dk1'], 0.50),
        'textDark': _shade(slots['dk1'], 0.20),
        'border': _tint(slots['dk2'], 0.70),
        'codeBorder': _tint(slots['dk2'], 0.60),
        'codeBlock': _tint(slots['dk2'], 0.85),
        'infoBox': _tint(slots['dk2'], 0.85),
        'infoBoxBorder': slots['dk2'],
        'warningBox': _tint(slots['accent2'], 0.88),
        'warningBoxBorder': slots['accent2'],
        'warningBoxText': _shade(slots['accent2'], 0.45),
        'inlineCode': slots['dk2'],
        'headerFooter': _tint(slots['dk1'], 0.50),
        'codeDarkBg': '1E1E1E',
        'codeDarkBorder': '3C3C3C',
        'jsonBg': _tint(slots['dk1'], 0.93),
        'flowBoxBorder': _tint(slots['dk1'], 0.50),
        'flowBoxBg': _tint(slots['dk1'], 0.93),
        'flowBlockBorder': _tint(slots['dk2'], 0.75),
        'flowBlockBg': _tint(slots['dk2'], 0.95),
    }
    if overrides:
        for k, v in overrides.items():
            if v is not None:
                colors[k] = v
    return colors


def _get_colors_from_theme(theme):
    """테마 JSON에서 colors dict 추출 (v1 또는 v2)."""
    if theme.get('version') == 2 and 'slots' in theme:
        return _derive_colors_from_slots(theme['slots'], theme.get('overrides', {}))
    if 'colors' in theme:
        return theme['colors']
    return None


def load_theme_color_sets(themes_dir=None):
    """
    themes/*.json에서 분류용 색상 세트를 동적으로 생성한다.

    Returns:
        dict with keys: dark_codes, light_codes, info_boxes, warning_boxes, header_bgs
        각 값은 uppercase hex 문자열의 set.
    """
    if themes_dir is None:
        # tools/ 디렉토리 기준으로 프로젝트 루트 탐색
        tools_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(tools_dir)
        themes_dir = os.path.join(project_root, 'themes')

    dark_codes = set()
    light_codes = set()
    info_boxes = set()
    warning_boxes = set()
    header_bgs = set()

    try:
        theme_files = glob.glob(os.path.join(themes_dir, '*.json'))
        for tf in theme_files:
            try:
                with open(tf, 'r', encoding='utf-8') as f:
                    theme = json.load(f)
                colors = _get_colors_from_theme(theme)
                if not colors:
                    continue

                # 다크 코드 배경 (고정값)
                for key in ('codeDarkBg',):
                    if key in colors:
                        dark_codes.add(colors[key].upper())

                # 라이트 코드/JSON 배경
                for key in ('jsonBg', 'codeBlock', 'flowBoxBg', 'flowBlockBg'):
                    if key in colors:
                        light_codes.add(colors[key].upper())

                # 정보 박스
                for key in ('infoBox',):
                    if key in colors:
                        info_boxes.add(colors[key].upper())

                # 경고 박스
                for key in ('warningBox',):
                    if key in colors:
                        warning_boxes.add(colors[key].upper())

                # 테이블 헤더 배경 (primary, secondary)
                for key in ('primary', 'secondary'):
                    if key in colors:
                        header_bgs.add(colors[key].upper())
            except (json.JSONDecodeError, KeyError, OSError):
                continue
    except OSError:
        pass

    # 하드코딩 폴백 추가 (테마 파일 로드 실패 시에도 기본 감지 보장)
    dark_codes |= {'1E1E1E', '2D2D2D', '1A1A1A'}
    light_codes |= {'F5F5F5', 'EAEAEA', 'F0F0F0', 'FAFAFA'}
    info_boxes |= {'E8F0F7', 'E8F4FD', 'DEEAF6'}
    warning_boxes |= {'FEF6E6', 'FFF8E1'}

    return {
        'dark_codes': dark_codes,
        'light_codes': light_codes,
        'info_boxes': info_boxes,
        'warning_boxes': warning_boxes,
        'header_bgs': header_bgs,
    }

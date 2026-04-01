#!/usr/bin/env python3
"""
extract-style-profile.py — PDF/DOCX에서 스타일 프로파일을 자동 추출

사용법:
  python -X utf8 tools/extract-style-profile.py reference.pdf
  python -X utf8 tools/extract-style-profile.py reference.pdf --json
  python -X utf8 tools/extract-style-profile.py reference.pdf --json > profiles/my-style.json

출력: professional.js 확장 슬롯에 직접 사용 가능한 theme 객체 (sizes는 half-point)
"""

import sys
import json
import argparse
from collections import Counter, defaultdict

try:
    import fitz  # PyMuPDF
except ImportError:
    print("[ERROR] PyMuPDF 필요: pip install PyMuPDF", file=sys.stderr)
    sys.exit(1)


def extract_from_pdf(pdf_path):
    """PDF를 분석하여 스타일 프로파일을 추출한다."""
    doc = fitz.open(pdf_path)

    # === 1. 전 페이지 텍스트 span 수집 ===
    all_spans = []
    header_footer_spans = []  # 매 페이지 반복되는 span (머릿글/바닥글)
    body_spans = []

    page_count = len(doc)

    # 머릿글/바닥글 감지: 첫 3페이지에서 동일 위치+텍스트 반복
    page_texts_by_y = defaultdict(list)  # y좌표 → [(page_idx, text, span_info)]

    for pi, page in enumerate(doc):
        blocks = page.get_text('dict')['blocks']
        for block in blocks:
            if 'lines' not in block:
                continue
            for line in block['lines']:
                for span in line['spans']:
                    text = span['text'].strip()
                    if not text:
                        continue
                    y = round(span['origin'][1])
                    sz = round(span['size'], 1)
                    font = span['font']
                    color_int = span['color']
                    r = (color_int >> 16) & 0xFF
                    g = (color_int >> 8) & 0xFF
                    b = color_int & 0xFF
                    color_hex = f'{r:02X}{g:02X}{b:02X}'
                    bold = bool(span['flags'] & 16)

                    info = {
                        'text': text, 'size': sz, 'font': font,
                        'color': color_hex, 'bold': bold,
                        'y': y, 'page': pi,
                    }
                    all_spans.append(info)
                    page_texts_by_y[(y, text[:20])].append(info)

    # === 2. 머릿글/바닥글 분리 ===
    # 3페이지 이상에서 같은 y좌표+텍스트가 반복되면 머릿글/바닥글
    hf_y_positions = set()
    for (y, text_prefix), spans in page_texts_by_y.items():
        unique_pages = len(set(s['page'] for s in spans))
        if unique_pages >= min(3, page_count) and len(spans) >= 3:
            hf_y_positions.add(y)
            header_footer_spans.extend(spans)

    for s in all_spans:
        if s['y'] not in hf_y_positions:
            body_spans.append(s)

    # === 3. 본문 폰트/크기/색상 분석 ===
    size_counter = Counter()  # size → total_chars
    size_samples = defaultdict(list)
    font_counter = Counter()
    color_counter = Counter()

    for s in body_spans:
        char_count = len(s['text'])
        size_counter[s['size']] += char_count
        font_counter[s['font']] += char_count
        color_counter[s['color']] += char_count
        if len(size_samples[s['size']]) < 5:
            size_samples[s['size']].append(s)

    # === 4. 역할별 크기 매핑 ===
    # 가장 빈번한 크기 = body
    sizes_ranked = size_counter.most_common()
    body_size = sizes_ranked[0][0] if sizes_ranked else 11.0

    # body보다 큰 크기들 = 헤딩 (큰 순서로 h1, h2, h3)
    heading_sizes = sorted([sz for sz, _ in sizes_ranked if sz > body_size], reverse=True)

    # body보다 작은 크기들 = 코드/small
    smaller_sizes = sorted([sz for sz, _ in sizes_ranked if sz < body_size], reverse=True)

    # 역할 할당
    size_map = {}
    size_map['body'] = body_size

    if len(heading_sizes) >= 1:
        # 가장 큰 게 표지 제목일 수 있음 — 사용 빈도로 판단
        title_size = heading_sizes[0]
        title_chars = size_counter[title_size]
        if title_chars < 100:  # 적은 문자 = 표지 제목
            size_map['title'] = title_size
            heading_sizes = heading_sizes[1:]
        else:
            size_map['title'] = title_size

    if len(heading_sizes) >= 1:
        size_map['h2'] = heading_sizes[0]
    if len(heading_sizes) >= 2:
        size_map['h3'] = heading_sizes[1]
    if len(heading_sizes) >= 3:
        size_map['h1'] = size_map.get('title', heading_sizes[0])

    if smaller_sizes:
        size_map['code'] = smaller_sizes[-1]  # 가장 작은 것
        if len(smaller_sizes) >= 2:
            size_map['small'] = smaller_sizes[0]

    # === 5. 헤딩 색상 추출 ===
    heading_colors = {}
    for role, sz in [('h2', size_map.get('h2')), ('h3', size_map.get('h3'))]:
        if sz is None:
            continue
        samples = size_samples.get(sz, [])
        if samples:
            # 가장 빈번한 색상
            role_colors = Counter(s['color'] for s in samples)
            heading_colors[role] = role_colors.most_common(1)[0][0]

    # === 6. 머릿글/바닥글 스타일 ===
    header_info = {}
    footer_info = {}

    if header_footer_spans:
        # y좌표로 분류: 상단 = 머릿글, 하단 = 바닥글
        page_height = doc[0].rect.height
        mid_y = page_height / 2

        hdr_spans = [s for s in header_footer_spans if s['y'] < mid_y]
        ftr_spans = [s for s in header_footer_spans if s['y'] >= mid_y]

        if hdr_spans:
            # 가장 긴 반복 텍스트 = 머릿글 텍스트
            hdr_texts = Counter(s['text'] for s in hdr_spans)
            longest = max(hdr_texts.keys(), key=len, default='')
            header_info['text'] = longest
            header_info['font'] = Counter(s['font'] for s in hdr_spans).most_common(1)[0][0]
            header_info['color'] = Counter(s['color'] for s in hdr_spans).most_common(1)[0][0]
            header_info['size'] = round(Counter(s['size'] for s in hdr_spans).most_common(1)[0][0], 1)

        if ftr_spans:
            footer_info['font'] = Counter(s['font'] for s in ftr_spans).most_common(1)[0][0]
            footer_info['color'] = Counter(s['color'] for s in ftr_spans).most_common(1)[0][0]
            # 회사명 추출 (숫자/슬래시 제외)
            ftr_texts = [s['text'] for s in ftr_spans if not s['text'].replace(' ','').replace('/','').isdigit()]
            if ftr_texts:
                footer_info['company'] = Counter(ftr_texts).most_common(1)[0][0]

    # === 7. 테이블 스타일 ===
    table_header_bg = None
    table_alt_row = None

    for page in doc:
        for d in page.get_drawings():
            if not d.get('fill'):
                continue
            r, g, b = [int(c * 255) for c in d['fill'][:3]]
            hex_c = f'{r:02X}{g:02X}{b:02X}'
            if hex_c == 'FFFFFF' or hex_c == '000000':
                continue
            rect = d['rect']
            w = rect[2] - rect[0]
            h = rect[3] - rect[1]
            if w > 50 and 10 < h < 30:  # 테이블 행 크기
                brightness = (r + g + b) / 3
                if brightness < 230 and not table_header_bg:
                    table_header_bg = hex_c
                elif brightness >= 230 and not table_alt_row:
                    table_alt_row = hex_c

    # === 8. 코드블록 분석 ===
    code_info = {'mode': 'light', 'syntaxHighlight': False}

    if size_map.get('code'):
        code_spans = [s for s in body_spans if s['size'] == size_map['code']]
        if code_spans:
            code_colors = set(s['color'] for s in code_spans)
            # 색상이 1~2종류면 구문 강조 없음
            code_info['syntaxHighlight'] = len(code_colors) > 3
            # 배경색 분석은 drawing에서 해야 하지만 복잡 → 기본 light

    # === 9. 표지 분석 ===
    cover_info = {'style': 'default'}
    page0 = doc[0]
    images = page0.get_images()
    if images:
        xref = images[0][0]
        base = doc.extract_image(xref)
        cover_info['logoWidth'] = base['width']
        cover_info['logoHeight'] = base['height']

    # 표지 텍스트 분석 — 중앙 정렬 여부
    p0_blocks = page0.get_text('dict')['blocks']
    p0_texts = []
    for block in p0_blocks:
        if 'lines' not in block:
            continue
        for line in block['lines']:
            for span in line['spans']:
                t = span['text'].strip()
                if t and round(span['origin'][1]) not in hf_y_positions:
                    p0_texts.append(span)

    if p0_texts:
        # 표지 텍스트가 페이지 중앙에 집중되면 centered
        page_width = page0.rect.width
        center_x = page_width / 2
        # 대부분의 텍스트가 중앙 부근이면 centered
        cover_info['style'] = 'centered'

    # === 10. 페이지 설정 ===
    page_width = doc[0].rect.width
    page_height = doc[0].rect.height
    orientation = 'portrait' if page_height > page_width else 'landscape'

    # === 프로파일 조립 ===
    # 주 폰트
    main_font = font_counter.most_common(1)[0][0] if font_counter else 'Malgun Gothic'
    # PyMuPDF 폰트명 → Word 폰트명 매핑
    font_name_map = {
        'MalgunGothic': 'Malgun Gothic',
        'MalgunGothicBold': 'Malgun Gothic',
        'ArialMT': 'Arial',
        'Batang': 'Batang',
    }

    def normalize_font(f):
        return font_name_map.get(f, f)

    main_color = color_counter.most_common(1)[0][0] if color_counter else '000000'

    # sizes → half-point 변환 (pt × 2)
    def to_halfpt(pt):
        return round(pt * 2) if pt else None

    profile = {
        '_generator': 'extract-style-profile.py',
        '_source': pdf_path,
        '_unit': 'sizes are in half-point (docx convention, 1pt = 2)',
        '_pageCount': page_count,
        'colors': {
            'primary': main_color,
            'secondary': main_color,
            'text': main_color,
            'h1Color': main_color,
            'h2Color': heading_colors.get('h2', main_color),
            'h3Color': heading_colors.get('h3', main_color),
            'h4Color': main_color,
            'tableHeaderBg': table_header_bg or 'D9D9D9',
            'tableHeaderText': main_color,
            'altRow': table_alt_row or 'F2F2F2',
            'headerFont': header_info.get('color', 'D9D9D9'),
            'footerFont': footer_info.get('color', 'CCCCCC'),
        },
        'fonts': {
            'default': normalize_font(main_font),
            'code': normalize_font(main_font),  # 코드도 본문과 같은 폰트일 수 있음
            'header': normalize_font(header_info.get('font', main_font)),
            'footer': normalize_font(footer_info.get('font', main_font)),
        },
        'sizes': {
            'title': to_halfpt(size_map.get('title')),
            'h1': to_halfpt(size_map.get('h1')),
            'h2': to_halfpt(size_map.get('h2')),
            'h3': to_halfpt(size_map.get('h3')),
            'body': to_halfpt(size_map.get('body')),
            'small': to_halfpt(size_map.get('small', size_map.get('body'))),
            'code': to_halfpt(size_map.get('code')),
            'headerFooter': to_halfpt(header_info.get('size')),
            'tableBody': to_halfpt(size_map.get('body')),
            'tableHeader': to_halfpt(size_map.get('body')),
        },
        'code': {
            'mode': code_info['mode'],
            'lightBg': 'FFFFFF',
            'lightBorder': '000000',
            'borderWidth': 1,
        },
        'syntax': {},
        'header': {
            'text': header_info.get('text'),
            'border': True,  # 대부분의 공식 문서에 머릿글 밑줄 있음
        },
        'cover': cover_info,
        'orientation': orientation,
        '_analysis': {
            'fontSizes': {str(k): v for k, v in size_counter.most_common()},
            'fonts': {k: v for k, v in font_counter.most_common()},
            'colors': {k: v for k, v in color_counter.most_common()},
            'headingSizes': {k: v for k, v in size_map.items()},
            'headerFooter': {
                'header': header_info,
                'footer': footer_info,
            },
            'tableColors': {
                'headerBg': table_header_bg,
                'altRow': table_alt_row,
            },
        },
    }

    # syntax: 구문 강조 없으면 모노 컬러
    if not code_info['syntaxHighlight']:
        profile['syntax'] = {
            'keyword': main_color, 'annotation': main_color,
            'type': main_color, 'string': main_color,
            'number': main_color, 'comment': main_color,
            'default': main_color,
        }

    # None 값 제거
    for section in ['sizes']:
        profile[section] = {k: v for k, v in profile[section].items() if v is not None}

    return profile


def print_report(profile):
    """사람이 읽기 좋은 분석 리포트 출력."""
    analysis = profile.get('_analysis', {})

    print(f"=== 스타일 프로파일: {profile['_source']} ({profile['_pageCount']}p) ===\n")

    print("폰트 크기 분포 (문자 수 기준):")
    for sz, cnt in sorted(analysis.get('fontSizes', {}).items(), key=lambda x: -x[1]):
        role = ''
        for k, v in analysis.get('headingSizes', {}).items():
            if str(v) == sz:
                role = f'  ← {k}'
                break
        print(f"  {sz:>6s}pt  {cnt:5d}자{role}")

    print(f"\n폰트: {profile['fonts']}")
    print(f"색상: text={profile['colors']['text']}, h2={profile['colors']['h2Color']}, h3={profile['colors']['h3Color']}")
    print(f"테이블: header={profile['colors']['tableHeaderBg']}, altRow={profile['colors']['altRow']}")
    print(f"코드: mode={profile['code']['mode']}, syntaxHighlight={'yes' if profile.get('syntax',{}).get('keyword','') != profile['colors']['text'] else 'no (mono)'}")

    hf = analysis.get('headerFooter', {})
    if hf.get('header'):
        print(f"머릿글: \"{hf['header'].get('text','')}\" ({hf['header'].get('font','')}, #{hf['header'].get('color','')})")
    if hf.get('footer'):
        print(f"바닥글: {hf['footer'].get('company','')} (#{hf['footer'].get('color','')})")

    print(f"표지: {profile['cover']}")
    print(f"방향: {profile['orientation']}")

    print(f"\nsizes (half-point):")
    for k, v in sorted(profile['sizes'].items()):
        pt = v / 2 if v else '?'
        print(f"  {k:15s} = {v:4d}  ({pt}pt)")


def main():
    parser = argparse.ArgumentParser(description='PDF/DOCX에서 스타일 프로파일 추출')
    parser.add_argument('input', help='입력 파일 (PDF)')
    parser.add_argument('--json', action='store_true', help='JSON 출력')
    args = parser.parse_args()

    if args.input.lower().endswith('.pdf'):
        profile = extract_from_pdf(args.input)
    else:
        print(f"[ERROR] 지원하지 않는 형식: {args.input}", file=sys.stderr)
        print("  지원: .pdf (PyMuPDF)", file=sys.stderr)
        sys.exit(1)

    if args.json:
        # _analysis 제외하고 출력
        output = {k: v for k, v in profile.items() if not k.startswith('_analysis')}
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print_report(profile)


if __name__ == '__main__':
    main()

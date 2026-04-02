#!/usr/bin/env python3
"""
extract-style-profile.py — PDF에서 스타일 프로파일을 완전 자동 추출

원본 PDF의 모든 시각적 속성을 감지하여, professional.js가 그대로 재현할 수 있는
theme 객체를 생성한다. 사람이 수동 설정할 필요 없음.

사용법:
  python -X utf8 tools/extract-style-profile.py reference.pdf
  python -X utf8 tools/extract-style-profile.py reference.pdf --json
  python -X utf8 tools/extract-style-profile.py reference.pdf --json > profiles/my-style.json

감지 항목:
  - 폰트 크기/종류/색상 (H2, H3, body, code, 머릿글/바닥글)
  - 헤딩 bold 여부 (H2, H3 각각)
  - 불릿 문자 (•, -, ▸ 등) + 목록 렌더링 방식 (bullet vs paragraph)
  - 테이블: 헤더 배경/글자/bold/정렬, 교대행 유무
  - 표지: title bold, 항목 순서(날짜/버전), 항목별 크기, 로고 크기
  - 코드블록: 크기 (가장 빈번한 값), 구문 강조 유무
  - 목차: 유무, 제목 색상
  - 변경이력: 테이블 총 행 수 (빈 행 포함)

출력: sizes는 half-point (docx convention, 1pt = 2)
"""

import sys
import json
import re
import argparse
from collections import Counter, defaultdict

try:
    import fitz  # PyMuPDF
except ImportError:
    print("[ERROR] PyMuPDF 필요: pip install PyMuPDF", file=sys.stderr)
    sys.exit(1)


def extract_from_pdf(pdf_path):
    """PDF를 분석하여 완전한 스타일 프로파일을 추출한다."""
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    page_height = doc[0].rect.height
    page_width = doc[0].rect.width

    # ================================================================
    # 1. 전 페이지 span 수집
    # ================================================================
    all_spans = []
    for pi, page in enumerate(doc):
        for block in page.get_text('dict')['blocks']:
            if 'lines' not in block:
                continue
            for line in block['lines']:
                for span in line['spans']:
                    text = span['text'].strip()
                    if not text:
                        continue
                    c = span['color']
                    r, g, b = (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF
                    all_spans.append({
                        'text': text,
                        'size': round(span['size'], 1),
                        'font': span['font'],
                        'color': f'{r:02X}{g:02X}{b:02X}',
                        'bold': bool(span['flags'] & 16),
                        'y': round(span['origin'][1]),
                        'x': round(span['origin'][0]),
                        'page': pi,
                    })

    # ================================================================
    # 2. 머릿글/바닥글 분리
    # ================================================================
    y_text_counter = defaultdict(int)
    for s in all_spans:
        y_text_counter[(s['y'], s['text'][:20])] += 1

    hf_ys = set()
    for (y, _), cnt in y_text_counter.items():
        if cnt >= min(3, page_count):
            hf_ys.add(y)

    hf_spans = [s for s in all_spans if s['y'] in hf_ys]
    body_spans = [s for s in all_spans if s['y'] not in hf_ys]

    # ================================================================
    # 3. 본문 통계
    # ================================================================
    size_counter = Counter()
    size_samples = defaultdict(list)
    font_counter = Counter()
    color_counter = Counter()
    size_bold_counter = defaultdict(lambda: {'bold': 0, 'total': 0})

    for s in body_spans:
        n = len(s['text'])
        size_counter[s['size']] += n
        font_counter[s['font']] += n
        color_counter[s['color']] += n
        size_bold_counter[s['size']]['total'] += 1
        if s['bold']:
            size_bold_counter[s['size']]['bold'] += 1
        if len(size_samples[s['size']]) < 10:
            size_samples[s['size']].append(s)

    # ================================================================
    # 4. 역할별 크기 매핑
    # ================================================================
    sizes_ranked = size_counter.most_common()
    body_size = sizes_ranked[0][0] if sizes_ranked else 11.0

    heading_sizes = sorted([sz for sz, _ in sizes_ranked if sz > body_size], reverse=True)
    smaller_sizes = sorted([sz for sz, _ in sizes_ranked if sz < body_size], reverse=True)

    size_map = {'body': body_size}

    if heading_sizes:
        title_size = heading_sizes[0]
        if size_counter[title_size] < 100:
            size_map['title'] = title_size
            heading_sizes = heading_sizes[1:]
        else:
            size_map['title'] = title_size

    if len(heading_sizes) >= 1:
        size_map['h2'] = heading_sizes[0]
    if len(heading_sizes) >= 2:
        size_map['h3'] = heading_sizes[1]

    # 코드 크기: body보다 작은 것 중 가장 큰 것 (코드블록은 보통 body보다 약간 작은 크기)
    # 가장 작은 것은 축소된 코드(6.1처럼 긴 코드)일 수 있음
    if smaller_sizes:
        size_map['code'] = smaller_sizes[0]  # 가장 큰 것 (body에 가장 가까운 것)
        if len(smaller_sizes) >= 2:
            size_map['small'] = smaller_sizes[0]

    # ================================================================
    # 5. 헤딩 bold 감지
    # ================================================================
    def detect_bold_ratio(target_size):
        stats = size_bold_counter.get(target_size)
        if not stats or stats['total'] == 0:
            return True  # 기본 bold
        return (stats['bold'] / stats['total']) > 0.5

    h2_bold = detect_bold_ratio(size_map.get('h2', 0))
    h3_bold = detect_bold_ratio(size_map.get('h3', 0))

    # 헤딩 색상
    heading_colors = {}
    for role, sz in [('h2', size_map.get('h2')), ('h3', size_map.get('h3'))]:
        if sz is None:
            continue
        samples = size_samples.get(sz, [])
        if samples:
            heading_colors[role] = Counter(s['color'] for s in samples).most_common(1)[0][0]

    # ================================================================
    # 6. 불릿 문자 + 목록 렌더링 방식 감지
    # ================================================================
    bullet_chars = Counter()
    for s in body_spans:
        text = s['text'].strip()
        if len(text) == 1 and text in '•-▸■◆○●▪►▷∙·':
            bullet_chars[text] += 1
        elif text.startswith('- ') and s['size'] == body_size:
            bullet_chars['-'] += 1

    if bullet_chars:
        detected_bullet = bullet_chars.most_common(1)[0][0]
        list_rendering = 'bullet'
    else:
        detected_bullet = None
        list_rendering = 'paragraph'

    # ================================================================
    # 7. 머릿글/바닥글 스타일
    # ================================================================
    header_info = {}
    footer_info = {}
    mid_y = page_height / 2

    hdr_spans = [s for s in hf_spans if s['y'] < mid_y]
    ftr_spans = [s for s in hf_spans if s['y'] >= mid_y]

    if hdr_spans:
        hdr_texts = Counter(s['text'] for s in hdr_spans)
        header_info['text'] = max(hdr_texts.keys(), key=len, default='')
        header_info['font'] = Counter(s['font'] for s in hdr_spans).most_common(1)[0][0]
        header_info['color'] = Counter(s['color'] for s in hdr_spans).most_common(1)[0][0]
        header_info['size'] = Counter(s['size'] for s in hdr_spans).most_common(1)[0][0]

    if ftr_spans:
        footer_info['font'] = Counter(s['font'] for s in ftr_spans).most_common(1)[0][0]
        footer_info['color'] = Counter(s['color'] for s in ftr_spans).most_common(1)[0][0]
        ftr_texts = [s['text'] for s in ftr_spans
                     if not s['text'].replace(' ', '').replace('/', '').isdigit()]
        if ftr_texts:
            footer_info['company'] = Counter(ftr_texts).most_common(1)[0][0]

    # ================================================================
    # 8. 테이블 스타일 (도형 분석)
    # ================================================================
    table_fills = defaultdict(int)  # 색상 → 출현 횟수
    table_row_ys = defaultdict(list)  # 페이지 → [y좌표]

    for pi, page in enumerate(doc):
        for d in page.get_drawings():
            if not d.get('fill'):
                continue
            r, g, b = [int(c * 255) for c in d['fill'][:3]]
            hx = f'{r:02X}{g:02X}{b:02X}'
            if hx in ('FFFFFF', '000000'):
                continue
            rect = d['rect']
            w, h = rect[2] - rect[0], rect[3] - rect[1]
            if w > 50 and 10 < h < 35:
                table_fills[hx] += 1
                table_row_ys[pi].append(round(rect[1]))

    # 가장 진한 색 = 헤더, 가장 연한 색 = 교대행
    table_header_bg = None
    table_alt_row = None
    if table_fills:
        sorted_fills = sorted(table_fills.items(), key=lambda x: -x[1])
        for hx, _ in sorted_fills:
            r, g, b = int(hx[:2], 16), int(hx[2:4], 16), int(hx[4:], 16)
            brightness = (r + g + b) / 3
            if brightness < 230 and not table_header_bg:
                table_header_bg = hx
            elif brightness >= 230 and not table_alt_row:
                table_alt_row = hx

    # 교대행 유무: 교대행 색상이 헤더 색상보다 많으면 교대행 있음
    has_alt_row = False
    if table_alt_row and table_header_bg:
        has_alt_row = table_fills.get(table_alt_row, 0) > table_fills.get(table_header_bg, 0)

    # 테이블 헤더 bold 감지: 헤더 배경 y좌표 근처 span의 bold 여부
    table_header_bold = True  # 기본
    table_header_align = 'left'
    if table_header_bg:
        header_y_set = set()
        for pi, page in enumerate(doc):
            for d in page.get_drawings():
                if not d.get('fill'):
                    continue
                r, g, b = [int(c * 255) for c in d['fill'][:3]]
                hx = f'{r:02X}{g:02X}{b:02X}'
                if hx == table_header_bg:
                    header_y_set.add((pi, round(d['rect'][1])))

        # 해당 위치의 span bold 확인
        header_bold_count = 0
        header_total = 0
        header_x_positions = []
        for s in body_spans:
            for (pi, hy) in header_y_set:
                if s['page'] == pi and abs(s['y'] - hy) < 20:
                    header_total += 1
                    if s['bold']:
                        header_bold_count += 1
                    header_x_positions.append(s['x'])
                    break

        if header_total > 0:
            table_header_bold = (header_bold_count / header_total) > 0.5

        # 정렬: 헤더 x좌표가 페이지 좌측 마진(~35pt)에 가까우면 left, 아니면 center
        if header_x_positions:
            avg_x = sum(header_x_positions) / len(header_x_positions)
            if avg_x > 80:  # 중앙으로 밀려있으면
                table_header_align = 'center'

    # ================================================================
    # 9. 표지 분석
    # ================================================================
    cover_info = {'style': 'centered'}
    page0 = doc[0]

    # 로고
    images = page0.get_images()
    if images:
        xref = images[0][0]
        base = doc.extract_image(xref)
        logo_w = base['width']
        # PDF px → DOCX px 변환 (너비 300 이상이면 축소)
        if logo_w > 300:
            ratio = 250 / logo_w
            cover_info['logoWidth'] = round(logo_w * ratio)
            cover_info['logoHeight'] = round(base['height'] * ratio)
        else:
            cover_info['logoWidth'] = logo_w
            cover_info['logoHeight'] = base['height']

    # 표지 텍스트 (머릿글/바닥글 제외)
    cover_spans = [s for s in all_spans if s['page'] == 0 and s['y'] not in hf_ys]

    # title bold 감지
    if cover_spans:
        max_size = max(s['size'] for s in cover_spans)
        title_spans = [s for s in cover_spans if s['size'] == max_size]
        cover_info['titleBold'] = any(s['bold'] for s in title_spans)

    # 표지 하단 항목 순서 + 크기
    bottom_spans = sorted(
        [s for s in cover_spans if s['y'] > page_height * 0.55 and s['size'] <= body_size],
        key=lambda s: s['y']
    )
    if bottom_spans:
        order = []
        version_size = None
        for s in bottom_spans:
            text = s['text']
            if re.match(r'\d{4}[./\-]', text):
                if 'date' not in order:
                    order.append('date')
            elif 'version' in text.lower() or re.match(r'v\d', text.lower()):
                if 'version' not in order:
                    order.append('version')
                version_size = round(s['size'] * 2)  # half-point
        if order:
            cover_info['projectInfoOrder'] = order
        if version_size:
            cover_info['versionSize'] = version_size

    # ================================================================
    # 10. 코드블록 분석
    # ================================================================
    code_info = {'mode': 'light', 'lightBg': 'FFFFFF', 'lightBorder': '000000', 'borderWidth': 1}

    if size_map.get('code'):
        code_spans = [s for s in body_spans if s['size'] == size_map['code']]
        if code_spans:
            code_colors = set(s['color'] for s in code_spans)
            syntax_highlight = len(code_colors) > 3
            code_info['syntaxHighlight'] = syntax_highlight

    # ================================================================
    # 11. 목차 감지
    # ================================================================
    toc_info = None
    for pi in range(min(5, page_count)):
        page_spans_pi = [s for s in body_spans if s['page'] == pi]
        page_text = ' '.join(s['text'] for s in page_spans_pi)
        if '목차' in page_text and ('...' in page_text or '…' in page_text):
            toc_title_span = next(
                (s for s in page_spans_pi if '목차' in s['text'] and s['size'] > body_size), None
            )
            toc_info = {
                'enabled': True,
                'title': '목차',
                'titleColor': toc_title_span['color'] if toc_title_span else '000000',
                'hasPageNumbers': any(
                    re.search(r'\.\.\.*\s*\d+', s['text']) for s in page_spans_pi
                ),
            }
            break

    # ================================================================
    # 12. 변경이력 빈 행 감지
    # ================================================================
    change_history = {}
    # 변경이력 페이지 (보통 P2) 도형에서 행 수 카운트
    for pi in range(1, min(4, page_count)):
        page_spans_pi = [s for s in body_spans if s['page'] == pi]
        page_text = ' '.join(s['text'] for s in page_spans_pi[:5])
        if '개정' in page_text or '이력' in page_text or '변경' in page_text:
            # 이 페이지의 테이블 행 수 = 도형 y좌표 수
            ys = set()
            page = doc[pi]
            for d in page.get_drawings():
                if not d.get('fill'):
                    continue
                r, g, b = [int(c * 255) for c in d['fill'][:3]]
                hx = f'{r:02X}{g:02X}{b:02X}'
                if hx in ('FFFFFF', '000000'):
                    continue
                rect = d['rect']
                w, h = rect[2] - rect[0], rect[3] - rect[1]
                if w > 50 and 10 < h < 35:
                    ys.add(round(rect[1]))
            # 변경이력 테이블 행 수: 페이지 텍스트 행 수 + 빈 행 추정
            # 데이터 행 = 텍스트가 있는 행, 빈 행 = 페이지 나머지 공간으로 추정
            data_rows = 0
            for s in page_spans_pi:
                if re.match(r'\d{4}[./]', s['text']):
                    data_rows += 1
            # 원본 Word 표에 빈 행이 포함되는 패턴: 데이터 4행 → 총 15행 등
            # 빈 행 포함하여 페이지를 채우도록 추정 (헤더 영역 제외 가용 높이 / 행 높이)
            if data_rows > 0:
                row_height = 29  # 일반적인 변경이력 행 높이 (pt)
                usable_height = page_height - 200  # 헤더/바닥글/제목 제외
                estimated_total = max(data_rows + 1, round(usable_height / row_height))
                change_history['totalRows'] = min(estimated_total, 20)  # 최대 20행
            break

    # ================================================================
    # 프로파일 조립
    # ================================================================
    font_name_map = {
        'MalgunGothic': 'Malgun Gothic',
        'MalgunGothicBold': 'Malgun Gothic',
        'ArialMT': 'Arial',
        'Batang': 'Batang',
        'BatangChe': 'BatangChe',
    }

    def normalize_font(f):
        return font_name_map.get(f, f)

    main_font = font_counter.most_common(1)[0][0] if font_counter else 'Malgun Gothic'
    main_color = color_counter.most_common(1)[0][0] if color_counter else '000000'

    def to_halfpt(pt):
        return round(pt * 2) if pt else None

    profile = {
        '_generator': 'extract-style-profile.py v2',
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
            'h1Bold': True,
            'h2Bold': h2_bold,
            'h3Bold': h3_bold,
            'h4Bold': True,
            'tableHeaderBg': table_header_bg or 'D9D9D9',
            'tableHeaderText': main_color,
            'tableHeaderBold': table_header_bold,
            'tableHeaderAlign': table_header_align,
            'altRow': table_alt_row if has_alt_row else 'FFFFFF',
            'border': main_color,
            'headerFont': header_info.get('color', 'D9D9D9'),
            'footerFont': footer_info.get('color', 'CCCCCC'),
            'bulletChar': detected_bullet,
            'listRendering': list_rendering,
        },
        'fonts': {
            'default': normalize_font(main_font),
            'code': normalize_font(main_font),
            'header': normalize_font(header_info.get('font', main_font)),
            'footer': normalize_font(footer_info.get('font', main_font)),
        },
        'sizes': {},
        'code': code_info,
        'syntax': {},
        'header': {
            'text': header_info.get('text'),
            'border': True,
        },
        'cover': cover_info,
        'orientation': 'portrait' if page_height > page_width else 'landscape',
    }

    # sizes (None 제거)
    size_entries = {
        'title': to_halfpt(size_map.get('title')),
        'h2': to_halfpt(size_map.get('h2')),
        'h3': to_halfpt(size_map.get('h3')),
        'body': to_halfpt(body_size),
        'small': to_halfpt(size_map.get('small', body_size)),
        'code': to_halfpt(size_map.get('code')),
        'headerFooter': to_halfpt(header_info.get('size')),
        'tableBody': to_halfpt(body_size),
        'tableHeader': to_halfpt(body_size),
    }
    profile['sizes'] = {k: v for k, v in size_entries.items() if v is not None}

    # syntax
    if not code_info.get('syntaxHighlight'):
        profile['syntax'] = {k: main_color for k in
                             ['keyword', 'annotation', 'type', 'string', 'number', 'comment', 'default']}

    # toc
    if toc_info:
        profile['toc'] = toc_info

    # changeHistory
    if change_history:
        profile['changeHistory'] = change_history

    # _analysis (리포트용)
    profile['_analysis'] = {
        'fontSizes': {str(k): v for k, v in size_counter.most_common()},
        'fonts': {k: v for k, v in font_counter.most_common()},
        'headingSizes': size_map,
        'headingBold': {'h2': h2_bold, 'h3': h3_bold},
        'bulletChars': dict(bullet_chars),
        'tableHeaderBold': table_header_bold,
        'tableHeaderAlign': table_header_align,
        'hasAltRow': has_alt_row,
    }

    return profile


def print_report(profile):
    """사람이 읽기 좋은 분석 리포트."""
    a = profile.get('_analysis', {})
    c = profile['colors']

    print(f"=== 스타일 프로파일: {profile['_source']} ({profile['_pageCount']}p) ===\n")

    print("폰트 크기 분포:")
    for sz, cnt in sorted(a.get('fontSizes', {}).items(), key=lambda x: -x[1]):
        role = ''
        for k, v in a.get('headingSizes', {}).items():
            if str(v) == sz:
                role = f'  ← {k}'
        print(f"  {sz:>6s}pt  {cnt:5d}자{role}")

    print(f"\n폰트: {profile['fonts']}")
    print(f"색상: text=#{c['text']}, h2=#{c['h2Color']}, h3=#{c['h3Color']}")
    print(f"헤딩 bold: h2={c['h2Bold']}, h3={c['h3Bold']}")
    print(f"테이블: header=#{c['tableHeaderBg']}, altRow=#{c['altRow']}, headerBold={c['tableHeaderBold']}, align={c['tableHeaderAlign']}")
    print(f"불릿: char={c.get('bulletChar')}, listRendering={c.get('listRendering')}")
    print(f"코드: mode={profile['code']['mode']}, syntaxHighlight={profile['code'].get('syntaxHighlight', False)}")
    print(f"표지: {profile['cover']}")
    print(f"방향: {profile['orientation']}")

    if profile.get('toc'):
        print(f"목차: {profile['toc']}")
    if profile.get('changeHistory'):
        print(f"변경이력: {profile['changeHistory']}")

    print(f"\nsizes (half-point):")
    for k, v in sorted(profile['sizes'].items()):
        print(f"  {k:15s} = {v:4d}  ({v/2}pt)")


def main():
    parser = argparse.ArgumentParser(description='PDF에서 스타일 프로파일 완전 자동 추출')
    parser.add_argument('input', help='입력 PDF 파일')
    parser.add_argument('--json', action='store_true', help='JSON 출력 (profile만, _analysis 제외)')
    args = parser.parse_args()

    if not args.input.lower().endswith('.pdf'):
        print(f"[ERROR] PDF만 지원: {args.input}", file=sys.stderr)
        sys.exit(1)

    profile = extract_from_pdf(args.input)

    if args.json:
        output = {k: v for k, v in profile.items() if k != '_analysis'}
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print_report(profile)


if __name__ == '__main__':
    main()

"""pdf_extract/ir_postprocessor.py — IR 후처리 (merge/cleanup 파이프라인)"""

import re
import json


def merge_mono_lines(nodes):
    """연속 모노스페이스 줄 → codeBlock 노드로 병합 (줄 간격 측정 포함)"""
    merged = []
    code_lines = []
    code_ys = []
    code_indents = []
    code_page = None
    code_style = None
    code_spacing_before = None

    def _flush():
        cb = {"type": "codeBlock", "lines": code_lines,
              "language": "", "_page": code_page}
        if code_spacing_before is not None:
            cb["spacingBefore"] = code_spacing_before
        if code_style:
            cb["style"] = dict(code_style)
        # 줄 간격 계산 (y좌표 차이의 중앙값)
        if len(code_ys) >= 2:
            gaps = [round(code_ys[i+1] - code_ys[i], 1)
                    for i in range(len(code_ys) - 1) if code_ys[i+1] > code_ys[i]]
            if gaps:
                gaps.sort()
                median_gap = gaps[len(gaps) // 2]
                if "style" not in cb:
                    cb["style"] = {}
                cb["style"]["lineSpacing"] = median_gap

                # 후처리: median 기준 continuation 줄 병합 (블록 시작부 등 실시간 감지 누락분)
                # gap < median * 0.6이면 PDF 자동 줄바꿈 → 이전 줄에 합침
                if median_gap > 0 and len(code_lines) >= 2 and len(code_ys) == len(code_lines):
                    new_lines = [code_lines[0]]
                    new_indents = [code_indents[0]] if code_indents else [0]
                    for j in range(1, len(code_lines)):
                        g = round(code_ys[j] - code_ys[j - 1], 1)
                        if 0 < g < median_gap * 0.6:
                            new_lines[-1] += code_lines[j]
                        else:
                            new_lines.append(code_lines[j])
                            new_indents.append(code_indents[j] if code_indents and j < len(code_indents) else 0)
                    if len(new_lines) < len(code_lines):
                        cb["lines"] = new_lines
                        code_indents[:] = new_indents

        # 줄별 indent
        if code_indents:
            cb["lineIndents"] = code_indents
        merged.append(cb)

    for node in nodes:
        if "_mono_line" in node:
            # 페이지가 바뀌면 이전 코드블록 flush (페이지별 section 지원)
            node_page = node.get("_page")
            if code_lines and node_page is not None and code_page is not None and node_page != code_page:
                _flush()
                code_lines = []
                code_ys = []
                code_indents = []
                code_page = None
                code_style = None
                code_spacing_before = None
            # continuation 감지: 줄 간격이 정상의 60% 미만이면 이전 줄에 합침
            node_y = node.get("_y")
            if (code_lines and code_ys and node_y is not None
                    and len(code_ys) >= 2):
                last_gap = code_ys[-1] - code_ys[-2]
                cur_gap = node_y - code_ys[-1]
                if last_gap > 0 and cur_gap < last_gap * 0.6:
                    # continuation: 이전 줄에 합침 (줄바꿈 없이)
                    code_lines[-1] += node["_mono_line"]
                    # y는 업데이트 (마지막 줄 위치 추적용)
                    code_ys[-1] = node_y
                    continue
            code_lines.append(node["_mono_line"])
            code_indents.append(node.get("_indent", 0))
            if node_y is not None:
                code_ys.append(node_y)
            if code_page is None:
                code_page = node.get("_page")
            if code_spacing_before is None and node.get("spacingBefore") is not None:
                code_spacing_before = node["spacingBefore"]
            if code_style is None:
                code_style = node.get("_mono_style")
        else:
            if code_lines:
                _flush()
                code_lines = []
                code_ys = []
                code_indents = []
                code_page = None
                code_style = None
                code_spacing_before = None
            merged.append(node)

    if code_lines:
        _flush()

    return merged


# ============================================================
# 후처리: 연속 listItem → list 노드 병합
# ============================================================

def merge_list_items(nodes):
    """연속 listItem → IR list 노드 (layout-to-docx 호환)"""
    merged = []
    items = []
    list_page = None
    list_style = None

    for node in nodes:
        if node.get("type") == "listItem":
            text = "".join(r["text"] for r in node.get("runs", []))
            items.append(text)
            if list_page is None:
                list_page = node.get("_page")
            if list_style is None and node.get("style"):
                list_style = node["style"]
        else:
            if items:
                ln = {"type": "list", "ordered": False,
                      "items": items, "_page": list_page}
                if list_style:
                    ln["style"] = list_style
                merged.append(ln)
                items = []
                list_page = None
                list_style = None
            merged.append(node)

    if items:
        ln = {"type": "list", "ordered": False,
              "items": items, "_page": list_page}
        if list_style:
            ln["style"] = list_style
        merged.append(ln)

    return merged


# ============================================================
# 후처리: JSON 중괄호 깊이 추적 → codeBlock
# ============================================================

def detect_json_blocks(nodes):
    """JSON 패턴({/[ 시작 + 깊이 추적) → codeBlock 변환.

    brace_depth > 0이면 paragraph뿐 아니라 기존 codeBlock도 흡수하여
    하나의 JSON 블록으로 병합한다.
    """
    result = []
    json_lines = []
    json_indents = []
    brace_depth = 0
    json_page = None
    json_style = None

    def _extract_text(node):
        if node.get("type") == "paragraph":
            return "".join(r["text"] for r in node.get("runs", [])).strip()
        if node.get("type") == "codeBlock":
            return "\n".join(node.get("lines", []))
        return None

    def _extract_lines(node):
        if node.get("type") == "codeBlock":
            return node.get("lines", []), node.get("lineIndents", [0]*len(node.get("lines",[])))
        if node.get("type") == "paragraph":
            text = "".join(r["text"] for r in node.get("runs", [])).strip()
            indent = node.get("indent", 0)
            return ([text], [indent]) if text else ([], [])
        return [], []

    def _flush():
        nonlocal json_lines, json_indents, brace_depth, json_page, json_style
        if json_lines:
            # JSON key-value 줄 병합: `"key":` + value → `"key":value`
            # PDF에서 긴 value가 key와 별도 줄에 올 때 발생 (continuation과 유사)
            import re as _re
            merged_lines = [json_lines[0]]
            merged_indents = [json_indents[0]] if json_indents else [0]
            for j in range(1, len(json_lines)):
                prev = merged_lines[-1].rstrip()
                cur = json_lines[j].lstrip()
                # key: 뒤에 value가 다음 줄로 넘어간 경우 병합
                # value 시작: " (문자열), 숫자, true/false/null, {, [
                if prev.endswith(':') and _re.match(r'^["{\[\d\-tfn]', cur) and len(cur) < 60:
                    # value가 짧을 때만 병합 (긴 URL 등은 별도 줄 유지)
                    merged_lines[-1] = prev + " " + cur if not cur.startswith('"') else prev + cur
                else:
                    merged_lines.append(json_lines[j])
                    merged_indents.append(json_indents[j] if json_indents and j < len(json_indents) else 0)
            cb = {"type": "codeBlock", "lines": merged_lines,
                  "language": "json", "_page": json_page}
            if json_style:
                cb["style"] = json_style
            if merged_indents:
                cb["lineIndents"] = merged_indents
            result.append(cb)
        json_lines = []
        json_indents = []
        brace_depth = 0
        json_page = None
        json_style = None

    for node in nodes:
        text = _extract_text(node)

        # JSON 진행 중 → 모든 텍스트 노드를 흡수 (페이지 경계에서 분리)
        if brace_depth > 0 and text is not None:
            node_page = node.get("_page")
            if node_page is not None and json_page is not None and node_page != json_page:
                _flush()  # 페이지 바뀌면 강제 flush
                # 새 JSON 블록 시작
                json_page = node_page
            lines, indents = _extract_lines(node)
            json_lines.extend(lines)
            json_indents.extend(indents)
            if json_style is None and node.get("style"):
                json_style = node["style"]
            # lineSpacing 전파: 1줄 블록(lineSpacing 계산 불가)이 먼저 style을 점유한 경우,
            # 이후 흡수되는 codeBlock의 lineSpacing을 항상 반영
            elif (node.get("style", {}).get("lineSpacing") is not None
                  and (json_style is None or json_style.get("lineSpacing") is None)):
                if json_style is None:
                    json_style = {}
                json_style["lineSpacing"] = node["style"]["lineSpacing"]
            opens = text.count("{") + text.count("[")
            closes = text.count("}") + text.count("]")
            brace_depth += opens - closes
            if brace_depth <= 0:
                _flush()
            continue

        # JSON 시작 감지
        if text is not None:
            first_line = text.split("\n")[0].strip() if text else ""
            if first_line.startswith("{") or first_line.startswith("["):
                lines, indents = _extract_lines(node)
                json_lines.extend(lines)
                json_indents.extend(indents)
                json_page = node.get("_page")
                # 스타일: codeBlock이면 style, paragraph이면 첫 run에서 추출
                if node.get("style"):
                    json_style = node["style"]
                elif node.get("type") == "paragraph" and node.get("runs"):
                    r = node["runs"][0]
                    json_style = {"font": r.get("font",""), "size": r.get("size",0),
                                  "color": r.get("color","000000")}
                opens = text.count("{") + text.count("[")
                closes = text.count("}") + text.count("]")
                brace_depth = opens - closes
                if brace_depth <= 0:
                    _flush()
                continue

        # JSON과 무관한 노드
        if json_lines:
            _flush()
        result.append(node)

    if json_lines:
        _flush()

    return result


# ============================================================
# Phase C: 테이블 cross-page 병합
# ============================================================

def _tables_match(t1, t2):
    """두 테이블의 헤더 구조가 동일한지 (텍스트 또는 너비 비율)"""
    h1 = [c["header"] for c in t1["columns"]]
    h2 = [c["header"] for c in t2["columns"]]
    if len(h1) != len(h2):
        return False
    # 헤더 텍스트 동일
    if h1 == h2:
        return True
    # 너비 비율 비교 (±20%)
    w1 = [c["width"] for c in t1["columns"]]
    w2 = [c["width"] for c in t2["columns"]]
    total1 = sum(w1) or 1
    total2 = sum(w2) or 1
    for a, b in zip(w1, w2):
        r1 = a / total1
        r2 = b / total2
        if abs(r1 - r2) > 0.2:
            return False
    return True


def _row_matches_headers(row, columns):
    """행 텍스트가 헤더와 동일한지 (cross-page 중복 헤더 스킵용)"""
    if len(row) != len(columns):
        return False
    for i, cell in enumerate(row):
        cell_text = "".join(r["text"] for r in cell.get("runs", [])).strip()
        if cell_text != columns[i]["header"]:
            return False
    return True


def _headers_text_match(cols1, cols2):
    """두 테이블의 헤더 텍스트가 정확히 동일한지"""
    h1 = [c["header"] for c in cols1]
    h2 = [c["header"] for c in cols2]
    return h1 == h2


def _columns_to_row(columns):
    """columns의 header 텍스트를 IR 행(runs 배열)으로 변환"""
    return [{"runs": [{"text": c["header"]}]} for c in columns]


def merge_cross_page_tables(content):
    """연속 테이블의 헤더+너비 비교 → cross-page 분할 테이블 병합.

    병합 조건:
    1. 연속 table 노드 (사이에 다른 노드 없음)
    2. 헤더 구조 동일 (_tables_match) — 텍스트 or 너비 비율
    3. 같은 _page이거나 _page가 1 차이 (cross-page)
    4. _singleRow 테이블(0행): 헤더를 데이터 행으로 변환하여 병합
    5. N행 연속 테이블: 가짜 헤더(첫 행이 실제 데이터)를 행으로 복원
    """
    if not content:
        return content

    merged = []
    i = 0
    while i < len(content):
        node = content[i]
        if node.get("type") == "table":
            # 0행 + _singleRow가 아닌 빈 테이블 스킵
            if not node.get("rows") and not node.get("_singleRow"):
                i += 1
                continue
            # _singleRow이면서 첫 테이블(앞에 병합 대상 없음): merged에 넣지 않고 다음에서 처리
            # → 아래 while에서 선행 테이블과 합침
            # 다음 노드와 병합 시도
            while i + 1 < len(content):
                next_node = content[i + 1]
                if next_node.get("type") != "table":
                    break
                # 페이지 차이 체크 (같은 페이지 또는 1페이지 차이만)
                cur_page = node.get("_page")
                next_page = next_node.get("_page")
                if cur_page is not None and next_page is not None:
                    if abs(next_page - cur_page) > 1:
                        break
                # 0행 _singleRow: 헤더를 데이터 행으로 변환하여 병합
                if not next_node.get("rows") and next_node.get("_singleRow"):
                    if _tables_match(node, next_node):
                        node["rows"].append(_columns_to_row(next_node["columns"]))
                        # rowHeights 병합 (_singleRow는 1행 = rowHeights[0])
                        next_rh = next_node.get("rowHeights", [])
                        if next_rh and node.get("rowHeights") is not None:
                            node["rowHeights"].append(next_rh[0])
                        i += 1
                        continue
                    else:
                        break
                # 0행이고 _singleRow 아님: 스킵
                if not next_node.get("rows"):
                    i += 1
                    continue
                if not _tables_match(node, next_node):
                    break
                # 병합: 가짜 헤더 복구 + 중복 헤더 스킵
                next_rows = next_node["rows"]
                next_rh = list(next_node.get("rowHeights", []))
                if next_rows and _row_matches_headers(next_rows[0], node["columns"]):
                    next_rows = next_rows[1:]
                    if next_rh:
                        next_rh = next_rh[1:]  # 중복 헤더 높이도 스킵
                # 헤더 텍스트가 다르면 = 가짜 헤더(실제 데이터) → 행으로 선행 삽입
                if not _headers_text_match(node["columns"], next_node["columns"]):
                    node["rows"].append(_columns_to_row(next_node["columns"]))
                    # 가짜 헤더의 높이 = next_rh[0] (헤더 행 높이)
                    if next_rh and node.get("rowHeights") is not None:
                        node["rowHeights"].append(next_rh[0])
                node["rows"].extend(next_rows)
                # rowHeights 병합 (데이터 행 높이들)
                if node.get("rowHeights") is not None and next_rh:
                    # next_rh[0]은 헤더(이미 처리), [1:]은 데이터 행
                    data_rh = next_rh[1:] if _headers_text_match(node["columns"], next_node["columns"]) else next_rh[1:]
                    node["rowHeights"].extend(data_rh)
                i += 1
            merged.append(node)
        else:
            merged.append(node)
        i += 1

    return merged


# ============================================================
# Phase D: bold 라벨 → H4 승격
# ============================================================

def promote_bold_labels(content):
    """bold + 짧은 줄 + 다음이 테이블 → H4"""
    for i, node in enumerate(content):
        if node.get("type") != "paragraph":
            continue
        runs = node.get("runs", [])
        if not runs:
            continue
        text = "".join(r["text"] for r in runs).strip()
        all_bold = all(r.get("bold") for r in runs)
        if all_bold and len(text) < 60 and i + 1 < len(content):
            if content[i + 1].get("type") == "table":
                content[i] = {"type": "heading", "level": 4, "text": text,
                              "_page": node.get("_page")}
    return content


# ============================================================
# 0-row fragment 병합 (경량 cross-page 처리)
# ============================================================

def _absorb_zero_row_fragments(content):
    """0-row 테이블(cross-page fragment)을 독립 테이블로 변환.

    pymupdf가 cross-page 테이블의 일부를 별도 테이블로 감지 → extract()[0]이 데이터를
    헤더로 취급 → rows=0. 이 "헤더"를 데이터 행으로 변환하고, 직전 테이블의
    진짜 헤더를 복사하여 정상 테이블로 만듦.

    - 이전 테이블에 merge하지 않음 (페이지별 section 유지)
    - 컬럼 수가 일치해야 변환 (안전 조건)
    """
    result = []
    for node in content:
        if (node.get("type") == "table"
                and not node.get("rows")  # 0-row
                and node.get("columns")):
            # 직전 테이블 찾기
            prev_table = None
            for j in range(len(result) - 1, -1, -1):
                if result[j].get("type") == "table":
                    prev_table = result[j]
                    break
                if result[j].get("type") in ("heading",):
                    break

            cols = node["columns"]
            if (prev_table
                    and len(prev_table.get("columns", [])) == len(cols)):
                # 현재 "헤더" → 데이터 행으로 변환, 헤더는 빈 문자열로 (렌더 시 skip)
                fake_row = []
                for c in cols:
                    fake_row.append({"runs": [{"text": c.get("header", "")}]})
                # 컬럼 너비는 직전 테이블에서 복사, 헤더 텍스트는 비움
                new_cols = []
                for pc in prev_table["columns"]:
                    new_cols.append({
                        "header": "",  # 빈 헤더 → 렌더러에서 헤더 행 skip
                        "width": pc.get("width"),
                        "padding": pc.get("padding"),
                    })
                node["columns"] = new_cols
                node["rows"] = [fake_row]
                # 스타일 복사하되 headerBold/headerCenter/headerBg 제거 (데이터이므로)
                if prev_table.get("style"):
                    st = dict(prev_table["style"])
                    st.pop("headerBold", None)
                    st.pop("headerCenter", None)
                    st.pop("headerBg", None)
                    st.pop("headerColor", None)
                    node["style"] = st
                node["_noHeader"] = True  # 렌더러에 헤더 행 skip 신호
            result.append(node)
        else:
            result.append(node)
    return result


# ============================================================
# 페이지 경계 pageBreak 삽입
# ============================================================

def insert_page_breaks(content):
    """페이지 전환 시 H2 heading 앞에 pageBreak 삽입 (연속 방지)"""
    if not content:
        return content

    result = []
    prev_page = content[0].get("_page")

    for node in content:
        cur_page = node.get("_page")
        if cur_page is not None and prev_page is not None and cur_page != prev_page:
            # 페이지가 바뀌었고, H2 heading이면 pageBreak 삽입
            if node.get("type") == "heading" and node.get("level") == 2:
                # 직전이 이미 pageBreak이면 스킵
                if not result or result[-1].get("type") != "pageBreak":
                    result.append({"type": "pageBreak"})
        result.append(node)
        if cur_page is not None:
            prev_page = cur_page

    return result


# ============================================================
# _page 메타 정리
# ============================================================

def strip_internal_meta(content):
    """내부 전용 _mono_style 등 제거 (_page는 DOCX 페이지 경계용으로 유지)"""
    for node in content:
        node.pop("_mono_style", None)
    return content


# ============================================================
# 메인
# ============================================================


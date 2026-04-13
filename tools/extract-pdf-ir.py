#!/usr/bin/env python3
"""
tools/extract-pdf-ir.py — PDF → IR JSON 변환 (CLI 래퍼)

pymupdf로 PDF를 파싱하여 SemanticIR 호환 JSON을 stdout으로 출력한다.
lib/parsers/pdf-parser.js가 child_process로 호출.

사용법:
  python -X utf8 tools/extract-pdf-ir.py input.pdf --json
  python -X utf8 tools/extract-pdf-ir.py input.pdf --json --image-dir output/.images/
"""

import sys
import os
import json
import io
import contextlib

# pdf_extract 패키지 import (같은 디렉토리의 pdf_extract/)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_extract import extract_pdf_ir, extract_meta


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: python -X utf8 tools/extract-pdf-ir.py <파일.pdf> [--json] [--meta-only] [--image-dir DIR] [--classify JSON]")
        sys.exit(1)

    pdf_path = sys.argv[1]
    json_mode = "--json" in sys.argv
    meta_only = "--meta-only" in sys.argv

    image_dir = None
    if "--image-dir" in sys.argv:
        idx = sys.argv.index("--image-dir")
        if idx + 1 < len(sys.argv):
            image_dir = sys.argv[idx + 1]

    classify = None
    if "--classify" in sys.argv:
        idx = sys.argv.index("--classify")
        if idx + 1 < len(sys.argv):
            classify = json.loads(sys.argv[idx + 1])

    # pymupdf가 stdout에 "Consider using pymupdf_layout..." 을 출력���므로
    # 파싱 중 stdout을 차단하고, 결과만 깨끗하게 출력
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        if meta_only:
            result = extract_meta(pdf_path)
        else:
            result = extract_pdf_ir(pdf_path, image_dir, classify)

    # 깨끗한 stdout으로 결과 출력
    if meta_only or json_mode:
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(f"Pages: {result['meta']['pageCount']}\n")
        sys.stdout.write(f"Content nodes: {len(result['content'])}\n")
        sys.stdout.write(f"Headings: {len(result['headings'])}\n")
        sys.stdout.write(f"Warnings: {len(result['warnings'])}\n")
        for h in result["headings"]:
            sys.stdout.write(f"  H{h['level']}: {h['text']}\n")

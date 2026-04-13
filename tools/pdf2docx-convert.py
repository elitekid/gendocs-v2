#!/usr/bin/env python3
"""
tools/pdf2docx-convert.py — PDF → DOCX 변환 (pdf2docx 엔진)

lib/pdf2docx/ 로컬 소스 사용. pip 의존성 불필요.

사용법:
  python -X utf8 tools/pdf2docx-convert.py input.pdf output.docx
  python -X utf8 tools/pdf2docx-convert.py input.pdf output.docx --start 0 --end 5
"""

import sys
import os

# 로컬 lib/pdf2docx 우선 사용
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))

from pdf2docx import Converter


def main():
    if len(sys.argv) < 3:
        print("사용법: python -X utf8 tools/pdf2docx-convert.py <input.pdf> <output.docx> [--start N] [--end N]")
        sys.exit(1)

    pdf_path = sys.argv[1]
    docx_path = sys.argv[2]

    start = 0
    end = None
    if "--start" in sys.argv:
        idx = sys.argv.index("--start")
        start = int(sys.argv[idx + 1])
    if "--end" in sys.argv:
        idx = sys.argv.index("--end")
        end = int(sys.argv[idx + 1])

    cv = Converter(pdf_path)
    cv.convert(docx_path, start=start, end=end)
    cv.close()

    print(f"Document saved: {os.path.abspath(docx_path)}")


if __name__ == "__main__":
    main()

"""pdf_extract/image_processor.py — 이미지 추출"""

import os
import base64
import fitz


def process_image(doc, xref, rect, image_dir, page_num):
    """이미지 → IR image 노드"""
    width_pt = rect.width
    height_pt = rect.height

    node = {
        "type": "image",
        "width": round(width_pt),
        "height": round(height_pt),
        "_page": page_num,
    }

    try:
        page_obj = doc[page_num]
        mat = fitz.Matrix(2, 2)
        pix = page_obj.get_pixmap(matrix=mat, clip=rect, alpha=False)

        if image_dir:
            os.makedirs(image_dir, exist_ok=True)
            img_path = os.path.join(image_dir, f"img_{xref}.png")
            pix.save(img_path)
            node["path"] = img_path
        else:
            img_bytes = pix.tobytes("png")
            node["data"] = base64.b64encode(img_bytes).decode("ascii")
    except Exception:
        node["path"] = None

    return node

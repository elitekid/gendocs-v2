"""baseline.json과 현재 DOCX 렌더링 비교."""
import win32com.client, os, json, sys, fitz

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
docx_path = os.path.join(ROOT, "output", "하나은행_기업QR결제_flow_v1.2.docx")
baseline_path = os.path.join(os.path.dirname(__file__), "baseline.json")
pdf_tmp = docx_path.replace(".docx", "_regtest.pdf")

baseline = json.load(open(baseline_path, encoding="utf-8"))

word = win32com.client.Dispatch("Word.Application")
word.Visible = False
try:
    doc = word.Documents.Open(os.path.abspath(docx_path))
    doc.SaveAs2(os.path.abspath(pdf_tmp), FileFormat=17)
    pages = doc.ComputeStatistics(2)
    doc.Close(False)
finally:
    word.Quit()

rend = fitz.open(pdf_tmp)
fails = []

if pages != baseline["pages"]:
    fails.append("PAGES: %d != baseline %d" % (pages, baseline["pages"]))

for pn in range(min(len(rend), len(baseline["page_data"]))):
    bl = baseline["page_data"][pn]
    lines = []
    for b in rend[pn].get_text("dict", flags=11)["blocks"]:
        if b["type"] == 0:
            for l in b["lines"]:
                t = "".join(s["text"] for s in l["spans"]).strip()
                if t:
                    lines.append(t[:60])
        elif b["type"] == 1:
            lines.append("[IMG]")
    first = lines[0][:20] if lines else ""
    last = lines[-1][:20] if lines else ""
    if first != bl["first"]:
        fails.append("p%d START: [%s] != baseline [%s]" % (pn + 1, first, bl["first"]))
    if last != bl["last"]:
        fails.append("p%d END: [%s] != baseline [%s]" % (pn + 1, last, bl["last"]))

rend.close()
os.remove(pdf_tmp)

if fails:
    print("FAIL: %d regression(s)" % len(fails))
    for f in fails:
        print("  " + f)
    sys.exit(1)
else:
    print("PASS: %dp, all pages match baseline" % pages)

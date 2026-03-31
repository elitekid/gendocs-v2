"""연구노트 원본 vs 생성물 상세 비교"""
import zipfile, xml.etree.ElementTree as ET, sys

ns_w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
ns_wp = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
ns_a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
ns_r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def g(el, attr):
    return el.get(f'{{{ns_w}}}{attr}', '') if el is not None else ''

def deep_analyze(path, label):
    print(f'\n{"="*60}')
    print(f' {label}')
    print(f'{"="*60}')
    with zipfile.ZipFile(path) as z:
        tree = ET.parse(z.open('word/document.xml'))
        root = tree.getroot()
        body = root.find(f'.//{{{ns_w}}}body')

        # 1. Page
        sectPr = body.find(f'.//{{{ns_w}}}sectPr')
        pgSz = sectPr.find(f'{{{ns_w}}}pgSz')
        pgMar = sectPr.find(f'{{{ns_w}}}pgMar')
        mar = {k.split('}')[1]:v for k,v in pgMar.attrib.items()}
        print(f'[Page] {g(pgSz,"w")}x{g(pgSz,"h")} {g(pgSz,"orient") or "portrait"} margins T={mar.get("top")} B={mar.get("bottom")} L={mar.get("left")} R={mar.get("right")}')
        hdrRefs = sectPr.findall(f'{{{ns_w}}}headerReference')
        print(f'[SectPr] headerRefs={len(hdrRefs)}')

        # 2. Title
        children = list(body)
        title_p = children[0]
        title_pPr = title_p.find(f'{{{ns_w}}}pPr')
        title_run = title_p.find(f'.//{{{ns_w}}}r')
        title_rPr = title_run.find(f'{{{ns_w}}}rPr') if title_run is not None else None
        title_text = ''.join(t.text or '' for t in title_p.findall(f'.//{{{ns_w}}}t'))
        title_sz = g(title_rPr.find(f'{{{ns_w}}}sz'), 'val') if title_rPr is not None and title_rPr.find(f'{{{ns_w}}}sz') is not None else ''
        title_bold = title_rPr.find(f'{{{ns_w}}}b') is not None if title_rPr is not None else False
        title_font = ''
        if title_rPr is not None:
            rf = title_rPr.find(f'{{{ns_w}}}rFonts')
            if rf is not None:
                title_font = rf.get(f'{{{ns_w}}}eastAsia','') or rf.get(f'{{{ns_w}}}ascii','')
        sp = title_pPr.find(f'{{{ns_w}}}spacing') if title_pPr is not None else None
        title_spacing = f'before={g(sp,"before")} after={g(sp,"after")} line={g(sp,"line")}' if sp is not None else 'none'
        print(f'[Title] "{title_text}" sz={title_sz} bold={title_bold} font="{title_font}" spacing=({title_spacing})')

        # 3. Header table
        tables = body.findall(f'.//{{{ns_w}}}tbl')
        hdr_tbl = tables[0]
        print(f'\n[HeaderTable]')
        hdr_tblPr = hdr_tbl.find(f'{{{ns_w}}}tblPr')
        tblW = hdr_tblPr.find(f'{{{ns_w}}}tblW') if hdr_tblPr is not None else None
        if tblW is not None:
            print(f'  tblW={g(tblW,"w")} type={g(tblW,"type")}')
        # table borders
        tblBorders = hdr_tblPr.find(f'{{{ns_w}}}tblBorders') if hdr_tblPr is not None else None
        if tblBorders is not None:
            for side in ['top','bottom','left','right','insideH','insideV']:
                b = tblBorders.find(f'{{{ns_w}}}{side}')
                if b is not None:
                    print(f'  border.{side}: sz={g(b,"sz")} color={g(b,"color")} val={g(b,"val")}')
        else:
            print(f'  (no tblBorders — cell-level borders)')
        rows = hdr_tbl.findall(f'{{{ns_w}}}tr')
        for ri, row in enumerate(rows):
            cells = row.findall(f'{{{ns_w}}}tc')
            for ci, cell in enumerate(cells):
                tcPr = cell.find(f'{{{ns_w}}}tcPr')
                cw = g(tcPr.find(f'{{{ns_w}}}tcW'),'w') if tcPr is not None and tcPr.find(f'{{{ns_w}}}tcW') is not None else ''
                span_el = tcPr.find(f'{{{ns_w}}}gridSpan') if tcPr is not None else None
                span = g(span_el,'val') if span_el is not None else '1'
                shd = tcPr.find(f'{{{ns_w}}}shd') if tcPr is not None else None
                bg = g(shd,'fill') if shd is not None else ''
                va_el = tcPr.find(f'{{{ns_w}}}vAlign') if tcPr is not None else None
                va = g(va_el,'val') if va_el is not None else ''
                # cell borders
                tcBorders = tcPr.find(f'{{{ns_w}}}tcBorders') if tcPr is not None else None
                cb_info = ''
                if tcBorders is not None:
                    parts = []
                    for side in ['top','bottom','left','right']:
                        b = tcBorders.find(f'{{{ns_w}}}{side}')
                        if b is not None:
                            parts.append(f'{side}:{g(b,"val")}/{g(b,"sz")}/{g(b,"color")}')
                    cb_info = ' '.join(parts)
                # text
                runs = cell.findall(f'.//{{{ns_w}}}t')
                txt = ''.join(r.text or '' for r in runs)[:30]
                # paragraph alignment
                cp = cell.find(f'{{{ns_w}}}p')
                cpPr = cp.find(f'{{{ns_w}}}pPr') if cp is not None else None
                jc = cpPr.find(f'{{{ns_w}}}jc') if cpPr is not None else None
                cpAlign = g(jc,'val') if jc is not None else ''
                print(f'  [{ri},{ci}] w={cw} span={span} bg={bg} vAlign={va} pAlign={cpAlign} "{txt}"')
                if cb_info:
                    print(f'         borders: {cb_info}')

        # 4. Content table
        content_tbl = tables[1]
        print(f'\n[ContentTable]')
        ct_tblPr = content_tbl.find(f'{{{ns_w}}}tblPr')
        ctW = ct_tblPr.find(f'{{{ns_w}}}tblW') if ct_tblPr is not None else None
        if ctW is not None:
            print(f'  tblW={g(ctW,"w")} type={g(ctW,"type")}')
        ct_cell = content_tbl.findall(f'{{{ns_w}}}tr')[0].findall(f'{{{ns_w}}}tc')[0]
        ct_tcPr = ct_cell.find(f'{{{ns_w}}}tcPr')
        # cell margins
        ct_mar = ct_tcPr.find(f'{{{ns_w}}}tcMar') if ct_tcPr is not None else None
        if ct_mar is not None:
            for side in ['top','bottom','start','end','left','right']:
                m = ct_mar.find(f'{{{ns_w}}}{side}')
                if m is not None:
                    print(f'  cellMargin.{side}: {g(m,"w")} type={g(m,"type")}')
        else:
            print(f'  (no explicit cellMargins)')
        paras = ct_cell.findall(f'{{{ns_w}}}p')
        print(f'  paragraphs: {len(paras)}')
        # First 8 paragraphs detail
        for pi in range(min(8, len(paras))):
            p = paras[pi]
            pPr = p.find(f'{{{ns_w}}}pPr')
            sp = pPr.find(f'{{{ns_w}}}spacing') if pPr is not None else None
            pSpacing = f'before={g(sp,"before")} after={g(sp,"after")} line={g(sp,"line")}' if sp is not None else 'default'
            runs = p.findall(f'.//{{{ns_w}}}r')
            rinfo = []
            for r in runs[:1]:
                rPr = r.find(f'{{{ns_w}}}rPr')
                sz = ''
                bold = False
                font = ''
                if rPr is not None:
                    s = rPr.find(f'{{{ns_w}}}sz')
                    if s is not None: sz = g(s,'val')
                    b = rPr.find(f'{{{ns_w}}}b')
                    if b is not None: bold = True
                    rf = rPr.find(f'{{{ns_w}}}rFonts')
                    if rf is not None: font = rf.get(f'{{{ns_w}}}eastAsia','') or rf.get(f'{{{ns_w}}}ascii','')
                t = r.find(f'{{{ns_w}}}t')
                txt = (t.text or '')[:50] if t is not None else ''
                rinfo.append(f'sz={sz} b={bold} f="{font}" "{txt}"')
            print(f'  p[{pi}] spacing=({pSpacing}) runs={len(runs)}: {" | ".join(rinfo) if rinfo else "(empty)"}')

        # 5. Signature table
        sig_tbl = tables[2]
        print(f'\n[SignatureTable]')
        sig_tblPr = sig_tbl.find(f'{{{ns_w}}}tblPr')
        sigJc = sig_tblPr.find(f'{{{ns_w}}}jc') if sig_tblPr is not None else None
        sigW_el = sig_tblPr.find(f'{{{ns_w}}}tblW') if sig_tblPr is not None else None
        print(f'  align={g(sigJc,"val") if sigJc is not None else ""} tblW={g(sigW_el,"w") if sigW_el is not None else ""} type={g(sigW_el,"type") if sigW_el is not None else ""}')
        sig_rows = sig_tbl.findall(f'{{{ns_w}}}tr')
        for ri, row in enumerate(sig_rows):
            cells = row.findall(f'{{{ns_w}}}tc')
            for ci, cell in enumerate(cells):
                tcPr = cell.find(f'{{{ns_w}}}tcPr')
                cw = g(tcPr.find(f'{{{ns_w}}}tcW'),'w') if tcPr is not None and tcPr.find(f'{{{ns_w}}}tcW') is not None else ''
                shd = tcPr.find(f'{{{ns_w}}}shd') if tcPr is not None else None
                bg = g(shd,'fill') if shd is not None else ''
                runs = cell.findall(f'.//{{{ns_w}}}t')
                txt = ''.join(r.text or '' for r in runs)
                imgs = len(cell.findall(f'.//{{{ns_a}}}blip'))
                anchors = len(cell.findall(f'.//{{{ns_wp}}}anchor'))
                inlines = len(cell.findall(f'.//{{{ns_wp}}}inline'))
                cell_paras = cell.findall(f'{{{ns_w}}}p')
                print(f'  [{ri},{ci}] w={cw} bg={bg} paras={len(cell_paras)} text="{txt}" anchors={anchors} inlines={inlines}')

        # 6. Watermark
        print(f'\n[Watermark]')
        import re
        for hname in ['word/header1.xml']:
            try:
                hc = z.read(hname).decode('utf-8')
                has_wm = 'WordPictureWatermark' in hc
                gain_m = re.search(r'gain="([^"]+)"', hc)
                bl_m = re.search(r'blacklevel="([^"]+)"', hc)
                style_m = re.search(r'style="([^"]+)"', hc)
                print(f'  {hname}: hasWatermark={has_wm}')
                if gain_m: print(f'    gain={gain_m.group(1)}')
                if bl_m: print(f'    blacklevel={bl_m.group(1)}')
                if style_m: print(f'    style={style_m.group(1)[:120]}')
            except:
                print(f'  {hname}: NOT FOUND')


orig = sys.argv[1]
gen = sys.argv[2]
deep_analyze(orig, 'ORIGINAL')
deep_analyze(gen, 'GENERATED')

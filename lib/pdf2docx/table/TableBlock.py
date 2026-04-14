# -*- coding: utf-8 -*-

'''Table block object parsed from raw image and text blocks.

Data Structure::

    {
        'type': int
        'bbox': (x0, y0, x1, y1),
        'rows': [
            {
                "bbox": (x0, y0, x1, y1),
                "height": float,
                "cells": [
                    {
                        'bbox': (x0, y0, x1, y1),
                        'border_color': (sRGB,,,), # top, right, bottom, left
                        'bg_color': sRGB,
                        'border_width': (,,,),
                        'merged_cells': (x,y), # this is the bottom-right cell of merged region: x rows, y cols
                        'blocks': [ {text blocks} ]
                    }, # end of cell
                    {},
                    None, # merged cell
                    ...
                ]
            }, # end of row
            {...} # more rows
        ] # end of row
    }
'''


from .Row import Row
from .Rows import Rows
from ..common.Block import Block
from ..common import docx


class TableBlock(Block):
    '''Table block.'''
    def __init__(self, raw:dict=None):
        if raw is None: raw = {}
        super().__init__(raw)

        # collect rows
        self._rows = Rows(parent=self).restore(raw.get('rows', []))

        # lattice table by default
        self.set_lattice_table_block()

    def __getitem__(self, idx):
        try:
            row = self._rows[idx]
        except IndexError:
            msg = f'Row index {idx} out of range'
            raise IndexError(msg)
        else:
            return row

    def __iter__(self):
        return (row for row in self._rows)

    def __len__(self):
        return len(self._rows)

    @property
    def num_rows(self):
        '''Count of rows.'''
        return len(self._rows)

    @property
    def num_cols(self):
        '''Count of columns.'''
        return len(self._rows[0]) if self.num_rows else 0

    @property
    def text(self):
        '''Get text contained in each cell.

        Returns:
            list: 2D-list with each element representing text in cell.
        '''
        return [ [cell.text for cell in row] for row in self._rows ]

    @property
    def outer_bbox(self):
        '''Outer bbox with border considered.'''
        x0, y0, x1, y1 = self.bbox
        w0_top, w0_right, w0_bottom, w0_left = self[0][0].border_width
        w1_top, w1_right, w1_bottom, w1_left = self[-1][-1].border_width
        return (x0-w0_left/2.0, y0-w0_top/2.0, x1+w1_right/2.0, y1+w1_bottom/2.0)


    def append(self, row:Row):
        '''Append row to table and update bbox accordingly.

        Args:
            row (Row): Target row to add.
        '''
        self._rows.append(row)


    def store(self):
        res = super().store()
        res.update({
            'rows': self._rows.store()
        })
        return res


    def assign_blocks(self, blocks:list):
        '''Assign ``blocks`` to associated cell.

        Args:
            blocks (list): A list of text/table blocks.
        '''
        for row in self._rows:
            for cell in row:
                if not cell: continue
                cell.assign_blocks(blocks)


    def assign_shapes(self, shapes:list):
        '''Assign ``shapes`` to associated cell.

        Args:
            shapes (list): A list of Shape.
        '''
        for row in self._rows:
            for cell in row:
                if not cell: continue
                cell.assign_shapes(shapes)


    def parse(self, **settings):
        '''Parse layout under cell level.

        Args:
            settings (dict): Layout parsing parameters.
        '''
        for row in self._rows:
            for cell in row:
                if not cell: continue
                cell.parse(**settings)


    def plot(self, page):
        '''Plot table block, i.e. cell/line/span, for debug purpose.
        
        Args:
            page (fitz.Page): pdf page.
            content (bool): Plot text blocks contained in cells if True.
            style (bool): Plot cell style if True, e.g. border width, shading.
            color (bool): Plot border stroke color if ``style=False``.
        '''
        for row in self._rows:
            for cell in row:                
                if not cell: continue  # ignore merged cells   
                cell.plot(page)


    def make_docx(self, table):
        '''Create docx table.

        Args:
            table (Table): ``python-docx`` table instance.
        '''
        # Fix missing cell borders by propagating from adjacent rows.
        self._fix_missing_borders()

        # Detect faux-bold in header row by comparing average character widths.
        # PDF may render header text with stroke+fill (rendering mode 2) which
        # pymupdf reports as flags=0 (not bold), but characters are wider.
        self._detect_faux_bold_header()

        # set left indent
        docx.indent_table(table, self.left_space)

        # set format and contents row by row
        for idx_row in range(len(table.rows)):
            self._rows[idx_row].make_docx(table, idx_row)

    def _detect_faux_bold_header(self):
        '''Detect faux-bold text in the first row (header) of a table.

        PDF may use text rendering mode 2 (stroke + fill) for bold appearance
        without changing the font to a Bold variant. pymupdf reports this as
        flags=0 (not bold). We detect it by comparing per-column average ASCII
        character widths of the header vs content: if a majority of columns show
        the header >10% wider, mark the entire header row as bold.
        '''
        if len(self._rows) < 2:
            return

        from ..text.TextSpan import TextSpan

        def _cell_acw(cell):
            '''Get average ASCII char width from spans in a cell.
            Only considers spans with 3+ ASCII chars for reliability.'''
            if cell is None:
                return 0
            ws = []
            for block in cell.blocks:
                if not hasattr(block, 'lines'):
                    continue
                for line in block.lines:
                    for span in line.spans:
                        if isinstance(span, TextSpan):
                            w = getattr(span, '_avg_char_width', 0.0)
                            # Only use spans with enough ASCII chars for a reliable measurement
                            text = span.text.strip() if hasattr(span, 'text') else ''
                            n_ascii = sum(1 for c in text if ord(c) < 128 and c.strip())
                            if w > 0 and n_ascii >= 3:
                                ws.append(w)
            return sum(ws) / len(ws) if ws else 0

        header_row = self._rows[0]
        num_cols = len(header_row)
        wider_count = 0
        compared = 0

        for ci in range(num_cols):
            h_acw = _cell_acw(header_row[ci])
            if h_acw == 0:
                continue

            # Compare with same column in content rows
            c_acws = []
            for ri in range(1, min(4, len(self._rows))):
                if ci < len(self._rows[ri]):
                    cw = _cell_acw(self._rows[ri][ci])
                    if cw > 0:
                        c_acws.append(cw)

            if not c_acws:
                continue

            c_acw = sum(c_acws) / len(c_acws)
            compared += 1
            if h_acw / c_acw > 1.10:
                wider_count += 1

        # Fallback: compare entire row averages (all spans with 3+ ASCII chars)
        if compared == 0 or wider_count == 0:
            def _row_acw(row):
                ws = []
                for cell in row:
                    if cell is None:
                        continue
                    for b_inner in cell.blocks:
                        if not hasattr(b_inner, 'lines'):
                            continue
                        for l_inner in b_inner.lines:
                            for s_inner in l_inner.spans:
                                if isinstance(s_inner, TextSpan):
                                    w = getattr(s_inner, '_avg_char_width', 0.0)
                                    txt = s_inner.text.strip() if hasattr(s_inner, 'text') else ''
                                    n = sum(1 for c in txt if ord(c) < 128 and c.strip())
                                    if w > 0 and n >= 3:
                                        ws.append(w)
                return sum(ws) / len(ws) if ws else 0

            h_row_acw = _row_acw(header_row)
            c_row_acws = [_row_acw(self._rows[ri]) for ri in range(1, min(4, len(self._rows)))]
            c_row_acws = [v for v in c_row_acws if v > 0]
            if h_row_acw > 0 and c_row_acws:
                c_avg = sum(c_row_acws) / len(c_row_acws)
                if c_avg > 0 and h_row_acw / c_avg > 1.10:
                    wider_count = 1
                    compared = 1

        # Mark as bold if any column shows header significantly wider (>20%)
        # or majority of columns show >10% wider.
        if compared > 0 and (wider_count >= 1):
            for cell in header_row:
                if cell is None:
                    continue
                for block in cell.blocks:
                    if not hasattr(block, 'lines'):
                        continue
                    for line in block.lines:
                        for span in line.spans:
                            if isinstance(span, TextSpan) and hasattr(span, 'flags'):
                                span.flags |= 2**4  # set bold bit

    def _fix_missing_borders(self):
        '''Fill in missing cell borders from adjacent rows in the same column.'''
        num_rows = len(self._rows)
        for ri in range(num_rows):
            row = self._rows[ri]
            for ci in range(len(row)):
                cell = row[ci]
                if cell is None:
                    continue
                bw = list(cell.border_width)  # (top, right, bottom, left)
                changed = False

                # Check left (index 3) and right (index 1) borders
                for border_idx in (1, 3):  # right, left
                    if bw[border_idx] == 0:
                        # Look at adjacent rows for the same column's border
                        for delta in (-1, 1):
                            adj_ri = ri + delta
                            if 0 <= adj_ri < num_rows:
                                adj_row = self._rows[adj_ri]
                                if ci < len(adj_row) and adj_row[ci] is not None:
                                    adj_bw = adj_row[ci].border_width
                                    if adj_bw[border_idx] > 0:
                                        bw[border_idx] = adj_bw[border_idx]
                                        changed = True
                                        break

                if changed:
                    cell.border_width = tuple(bw)
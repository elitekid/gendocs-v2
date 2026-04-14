# -*- coding: utf-8 -*-

'''A group of TextSpan and ImageSpan objects.
'''

from ..common.Collection import ElementCollection
from .TextSpan import TextSpan
from ..image.ImageSpan import ImageSpan

class Spans(ElementCollection):
    '''Collection of TextSpan and ImageSpan instances.'''

    def restore(self, raws:list):
        '''Recreate TextSpan or ImageSpan from source dict list.'''
        for raw_span in raws:
            if 'image' in raw_span:
                span = ImageSpan(raw_span)
            else:
                span = TextSpan(raw_span)
                # Drop whitespace-only spans, but preserve the space by prepending
                # it to the next span's text to avoid losing inter-word gaps
                # (e.g., "- 1000" becoming "-1000")
                if not span.text.strip() and not span.style:
                    # store the whitespace to prepend to next span
                    self._pending_whitespace = getattr(self, '_pending_whitespace', '') + span.text
                    continue

            # prepend any pending whitespace from dropped spans
            pending = getattr(self, '_pending_whitespace', '')
            if pending and span and isinstance(span, TextSpan):
                span._text = pending + span._text
                if span.chars:
                    from .Char import Char
                    # insert space char(s) at the beginning
                    for ch in reversed(pending):
                        space_char = Char({'c': ch, 'bbox': list(span.bbox)})
                        span.chars.insert(0, space_char)
                self._pending_whitespace = ''
            elif pending and span:
                self._pending_whitespace = ''

            self.append(span)

        # clear any trailing pending whitespace
        if getattr(self, '_pending_whitespace', ''):
            # append to last span if possible
            if self._instances and isinstance(self._instances[-1], TextSpan):
                last = self._instances[-1]
                last._text = last._text + self._pending_whitespace
            self._pending_whitespace = ''

        return self

    @property
    def text_spans(self):
        '''Get TextSpan instances.'''
        spans = list(filter(
            lambda span: isinstance(span, TextSpan), self._instances
        ))
        return Spans(spans)

    @property
    def image_spans(self):
        '''Get ImageSpan instances.'''
        spans = list(filter(
            lambda span: isinstance(span, ImageSpan), self._instances
        ))
        return Spans(spans)


    def strip(self):
        '''Remove redundant blanks at the begin/end span.'''
        stripped = False
        if not self._instances: return stripped
        
        # left strip the first span
        left_span = self._instances[0]
        if isinstance(left_span, TextSpan): stripped = stripped or left_span.lstrip() 

        # right strip the last span
        right_span = self._instances[-1]
        if isinstance(right_span, TextSpan): stripped = stripped or right_span.rstrip()

        # update bbox
        if stripped: self._parent.update_bbox(self.bbox)

        return stripped
"""Stand-in for c4d.bitmaps (see the package docstring): not Cinema 4D."""
import c4d


class BaseBitmap(object):
    def __init__(self):
        self.size = None
        self._rendered = None

    def Init(self, x, y, depth=24, flags=0):
        self.size = (x, y, depth)
        return c4d.IMAGERESULT_OK

    def Save(self, name, format, data=None, savebits=0):
        if format != c4d.FILTER_PNG or self._rendered is None:
            return 0
        with open(name, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n stand-in %r" % (self._rendered,))
        return c4d.IMAGERESULT_OK

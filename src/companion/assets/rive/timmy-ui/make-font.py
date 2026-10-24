#!/usr/bin/env python3
"""
Outfit.ttf for the native artboards (RIVE CONTRACT v2 / DESIGN.md B11 D2: one UI face across HTML and the native faces).

The font this product already serves (@fontsource-variable/outfit, the latin subset at /web/fonts/) is a WOFF2; the Rive
CLI embeds TTF/OTF. This script decodes that same file into Outfit.ttf beside the source with fontTools — no download,
no other font: the glyphs, the wght axis (100–900) and the name table are the served font's. Brotli (WOFF2's compression)
is decoded by Node's built-in zlib through a one-function stand-in when the `brotli` module is not installed.

Run from the repo root:  python3 src/companion/assets/rive/timmy-ui/make-font.py
Needs: fontTools (python3 -m fontTools), node. Writes Outfit.ttf and prints its sha256. The licence is Outfit-OFL.txt
(the package's LICENSE: Copyright 2021 The Outfit Project Authors, SIL OFL 1.1; no Reserved Font Name is declared).
"""
import hashlib
import shutil
import subprocess
import sys
import types
from pathlib import Path

here = Path(__file__).parent
repo = here.parents[4]
source = repo / 'node_modules' / '@fontsource-variable' / 'outfit' / 'files' / 'outfit-latin-wght-normal.woff2'
licence = repo / 'node_modules' / '@fontsource-variable' / 'outfit' / 'LICENSE'
if not source.exists():
    sys.exit(f'the served font is not installed: {source}')

try:
    import brotli  # noqa: F401
except ImportError:
    node = shutil.which('node')
    if not node:
        sys.exit('neither the brotli module nor node is here to decode the WOFF2')
    shim = types.ModuleType('brotli')
    shim.MODE_FONT, shim.MODE_TEXT = 2, 1
    js = 'const z=require("zlib");const c=[];process.stdin.on("data",d=>c.push(d)).on("end",()=>process.stdout.write(z.brotliDecompressSync(Buffer.concat(c))))'
    shim.decompress = lambda data: subprocess.run([node, '-e', js], input=data, stdout=subprocess.PIPE, check=True).stdout
    sys.modules['brotli'] = shim

from fontTools.ttLib import TTFont  # noqa: E402

font = TTFont(str(source))
font.flavor = None  # a plain TTF container; the tables are untouched
out = here / 'Outfit.ttf'
font.save(str(out))
shutil.copyfile(licence, here / 'Outfit-OFL.txt')
digest = hashlib.sha256(out.read_bytes()).hexdigest()
axes = [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in font['fvar'].axes] if 'fvar' in font else []
print(f'wrote {out.name} ({out.stat().st_size} bytes) sha256 {digest}; axes {axes}; from {source.relative_to(repo)}')

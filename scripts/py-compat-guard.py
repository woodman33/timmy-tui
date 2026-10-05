#!/usr/bin/env python3
"""Python compatibility guard: every Python file must parse on the oldest interpreter it can meet.

The floor is 3.9: macOS still ships /usr/bin/python3 3.9, the geo lanes are spawned as plain `python3`, and the one
pyproject here declares requires-python >= 3.9. Two checks, run on whatever python3 executes this script:

  1. ast.parse(src, feature_version=FLOOR) — the parser itself refuses grammar newer than the floor (match, except*,
     type parameters …) and every file that does not parse at all.
  2. On Python 3.12+ only, a tokenizer pass for PEP 701 f-strings, which feature_version does NOT catch: a quote reused
     inside a field (f"{d["k"]}"), a backslash or a comment inside a field, a nested f-string with an enclosing quote,
     a line break inside a single-quoted f-string's field. All parse on 3.12 and are a SyntaxError on 3.11 and older.

Run under an older python3 the first check alone is exact for that interpreter, which is why CI (3.12) needs the second.

  python3 scripts/py-compat-guard.py                 every tracked *.py (git ls-files)
  python3 scripts/py-compat-guard.py a.py b.py       just these
  --floor 3.10                                       a different floor

Prints one JSON object; exit 0 clean · 1 offenders · 64 bad usage.
"""
from __future__ import annotations

import ast
import io
import json
import re
import subprocess
import sys
import tokenize

PREFIX = "rRfFbBuU"


def _clash(inner: str, outer: str) -> bool:
    """True when a string opened with `inner` would end the enclosing f-string opened with `outer` before 3.12."""
    return inner.startswith(outer) or (len(outer) == 1 and inner[0] == outer)


def pep701_offenders(src: str) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    stack: list[list] = []                     # one [delimiter, open-field depth] per f-string we are inside, innermost last

    def in_expr() -> bool:                     # inside some f-string's replacement field (a nested f-string only lives in one)
        return bool(stack) and (stack[-1][1] > 0 or len(stack) > 1)

    def clash_any(q: str) -> bool:
        return any(_clash(q, outer) for outer, _ in stack)

    for t in tokenize.generate_tokens(io.StringIO(src).readline):
        line = t.start[0]
        if t.type == tokenize.FSTRING_START:
            delim = t.string.lstrip(PREFIX)
            if in_expr() and clash_any(delim):
                out.append((line, f"nested f-string opens with {delim}, which closes an enclosing f-string before Python 3.12"))
            stack.append([delim, 0])
            continue
        if not stack:
            continue
        if t.type == tokenize.FSTRING_END:
            stack.pop()
            continue
        if t.type == tokenize.OP and t.string == "{":
            stack[-1][1] += 1
            continue
        if t.type == tokenize.OP and t.string == "}":
            stack[-1][1] = max(0, stack[-1][1] - 1)
            continue
        if not in_expr():
            continue
        if t.type == tokenize.FSTRING_MIDDLE and stack[-1][1] > 0:
            continue                           # a format spec's literal text (f"{x:>10}"), not expression source
        if "\\" in t.string:
            out.append((line, "backslash inside an f-string field (Python 3.12+ only)"))
        if t.type == tokenize.COMMENT:
            out.append((line, "comment inside an f-string field (Python 3.12+ only)"))
        if t.type in (tokenize.NL, tokenize.NEWLINE) and any(len(d) == 1 for d, _ in stack):
            out.append((line, "line break inside a single-quoted f-string's field (Python 3.12+ only)"))
        if t.type == tokenize.STRING and clash_any(t.string.lstrip(PREFIX)):
            out.append((line, f"string quote {t.string.lstrip(PREFIX)[0]} inside a field closes an enclosing f-string before Python 3.12"))
    return out


def check(path: str, floor: tuple[int, int], tokens: bool) -> list[dict]:
    try:
        with tokenize.open(path) as f:         # honours a coding cookie, like the interpreter does
            src = f.read()
    except (OSError, SyntaxError, UnicodeDecodeError) as e:
        return [{"file": path, "line": 0, "why": f"unreadable: {e}"}]
    try:
        ast.parse(src, filename=path)
    except SyntaxError as e:
        here = "%d.%d" % sys.version_info[:2]
        return [{"file": path, "line": e.lineno or 0, "why": f"does not parse on Python {here}: {e.msg}"}]
    try:
        ast.parse(src, filename=path, feature_version=floor)
    except SyntaxError as e:
        return [{"file": path, "line": e.lineno or 0, "why": f"grammar newer than Python {floor[0]}.{floor[1]}: {e.msg}"}]
    if not tokens:
        return []
    try:
        return [{"file": path, "line": ln, "why": why} for ln, why in pep701_offenders(src)]
    except (tokenize.TokenError, SyntaxError) as e:
        return [{"file": path, "line": 0, "why": f"does not tokenize: {e}"}]


def main(argv: list[str]) -> int:
    args = list(argv)
    floor_s = "3.9"
    if "--floor" in args:
        i = args.index("--floor")
        if i + 1 >= len(args):
            print(json.dumps({"ok": False, "status": "usage", "note": "--floor needs a version like 3.9"})); return 64
        floor_s = args[i + 1]; del args[i:i + 2]
    if any(a.startswith("-") for a in args):
        print(__doc__); return 64
    m = re.fullmatch(r"3\.(\d{1,2})", floor_s)
    if not m or not (7 <= int(m.group(1)) <= sys.version_info[1]):
        print(json.dumps({"ok": False, "status": "usage", "note": f"--floor must be 3.7 … {sys.version_info[0]}.{sys.version_info[1]} (this interpreter)"})); return 64
    floor = (3, int(m.group(1)))
    files = args
    if not files:
        r = subprocess.run(["git", "ls-files", "-z", "*.py"], capture_output=True)
        if r.returncode != 0:
            print(json.dumps({"ok": False, "status": "usage", "note": "no files given and git ls-files failed; pass the files"})); return 64
        files = [p for p in r.stdout.decode().split("\0") if p]
    tokens = sys.version_info >= (3, 12) and floor < (3, 12)
    offenders = [o for p in files for o in check(p, floor, tokens)]
    print(json.dumps({"ok": not offenders, "floor": floor_s, "python": sys.version.split()[0], "pep701_check": tokens,
                      "files": len(files), "offenders": offenders}, indent=1))
    return 1 if offenders else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

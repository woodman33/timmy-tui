#!/usr/bin/env python3
"""Drive apisnip (an interactive ratatui picker) unattended through a pty.

apisnip 1.4.60 has no headless flag: Space toggles the endpoint under the cursor,
j/k move, '/' searches, 'w' writes the selection and quits. This driver opens a
pty, waits for the list, selects the first N endpoints (Space, j) and presses w.

  snip-pty.py <spec url|file> <out.yaml> [--first N] [--settle 4]

It writes a JSON line to stdout: {ok, out, bytes, selected, seconds, tail}.
"""
import json
import os
import pty
import select
import sys
import time

args = [a for a in sys.argv[1:] if not a.startswith("--")]
opts = {sys.argv[i].lstrip("-"): sys.argv[i + 1] for i in range(1, len(sys.argv) - 1) if sys.argv[i].startswith("--")}
if len(args) < 2:
    print("usage: snip-pty.py <spec> <out.yaml> [--first N] [--settle S]", file=sys.stderr)
    sys.exit(2)
spec, out = args[0], args[1]
first = int(opts.get("first", "12"))
settle = float(opts.get("settle", "4"))
if os.path.exists(out):
    os.remove(out)

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLUMNS"] = "160"
    os.environ["LINES"] = "50"
    os.execvp("apisnip", ["apisnip", spec, out])

t0 = time.time()
buf = b""


def drain(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            buf += chunk
    return True


drain(settle)
# the picker is up once it has painted; select the first N rows
for _ in range(first):
    os.write(fd, b" ")
    drain(0.08)
    os.write(fd, b"j")
    drain(0.08)
os.write(fd, b"w")
alive = drain(3.0)
for _ in range(20):
    if os.path.exists(out) and os.path.getsize(out) > 0:
        break
    time.sleep(0.5)
try:
    os.kill(pid, 15)
except Exception:
    pass
try:
    os.waitpid(pid, 0)
except Exception:
    pass
text = buf.decode("utf-8", "replace")
import re
plain = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
tail = " ".join(plain.split())[-400:]
ok = os.path.exists(out) and os.path.getsize(out) > 0
print(json.dumps({"ok": ok, "out": out, "bytes": os.path.getsize(out) if ok else 0, "selected": first, "seconds": round(time.time() - t0, 1), "tail": tail}))
sys.exit(0 if ok else 1)

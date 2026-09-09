#!/usr/bin/env python3
# Drive apisnip's ratatui TUI headlessly over a pty (ORDER captain-y9g4).
# apisnip has no headless flag: it opens a full-screen picker (j/k move, Space
# toggles a path, / searches, w writes + quits). We drive it by SEARCHING for
# each wanted path fragment and toggling the highlighted row, then writing.
#
#   snip-pty.py <input-spec> <outfile> <term1> <term2> ...
#
# Each term is typed after '/', which jumps the cursor to the first match; then
# Space toggles it into the kept set. Not a curated review — a scripted, honest
# positional selection of the endpoints Timmy's Docker lane needs. The receipt
# records the terms and the before/after path counts.
import sys, os, pty, time, select, subprocess

def main():
    if len(sys.argv) < 4:
        print("usage: snip-pty.py <input> <outfile> <term> [term...]", file=sys.stderr); sys.exit(2)
    inp, out, terms = sys.argv[1], sys.argv[2], sys.argv[3:]
    apisnip = os.path.expanduser("~/.cargo/bin/apisnip")
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execv(apisnip, [apisnip, inp, out])
        os._exit(127)
    def send(s, wait=0.35):
        os.write(fd, s.encode())
        time.sleep(wait)
    def drain(t=0.6):
        end = time.time() + t
        buf = b""
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try: buf += os.read(fd, 65536)
                except OSError: break
        return buf
    time.sleep(2.0)   # let the TUI paint (large spec)
    drain(1.5)
    for term in terms:
        send("/", 0.3)             # enter search
        send(term, 0.4)            # type the fragment
        send("\r", 0.4)            # jump to first match (Enter closes search on most builds)
        send(" ", 0.4)             # toggle the highlighted row
        drain(0.3)
    send("w", 0.8)                 # write + quit
    drain(1.0)
    try: os.close(fd)
    except OSError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    print("wrote", out, "selected", len(terms), "terms")

if __name__ == "__main__":
    main()

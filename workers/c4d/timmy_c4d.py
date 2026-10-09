"""timmy_c4d: the result file a Cinema 4D script writes when Timmy runs it with c4dpy.

NOT YET EXERCISED on a real Cinema 4D: written against the documented `c4d` Python API and checked here
only with Python 3 against a stand-in `c4d` module (tests/native-python.test.ts). The first real run is
the operator's, on the Mac.

Timmy's c4dpy job (src/native: c4dpyJob) sets, in the script's environment:
  TIMMY_RESULT         where to write the result file: the run's own, <root>/.timmy/native/<run>/result.json
                       (without it, <root>/out/timmy-result.json, as a run by hand writes)
  TIMMY_RUN            this run's token, written back so a result from an earlier run is never taken for this one
  TIMMY_SCRIPT_SHA256  the script's sha256 when the job was submitted, written back as script_sha256 so the
                       result is bound to the input submitted
  TIMMY_SCRIPT         the script itself: its sha256 as this run reads it goes in as script_sha256_read, so
                       a script changed after submission is seen
  TIMMY_ROOT           the project folder; file names in the result are relative to it
  TIMMY_OUT            the folder for outputs (default <root>/out)

The result file is what Timmy judges a run by, not c4dpy's exit status (a retained run wrote ok: true while
c4dpy exited 1):
  {
    "ok": true | false,
    "run": "<TIMMY_RUN>",
    "script_sha256": "<TIMMY_SCRIPT_SHA256>",
    "script_sha256_read": "<sha256 of TIMMY_SCRIPT as read>",   (when TIMMY_SCRIPT names a file)
    "error": "<type: message>"            (when ok is false; the project folder written as ".", home as "~")
    "files": {"out/scene.c4d": "<sha256>", ...},
    "c4d_version": 2026000,                (c4d.GetC4DVersion(), or null outside Cinema 4D)
    "timing": {"started": "...Z", "ended": "...Z", "seconds": 1.23},
    ...                                    (whatever the script's main returns, as extra fields)
  }

Use:
    import timmy_c4d
    def main(run):
        path = run.out_path("scene.c4d")   # makes the out folder
        ...save or render to path...
        run.add_file(path)                 # its sha256 goes into the result
        return {"frames": 1}               # extra fields for the result
    timmy_c4d.run_script(main)
"""
import datetime
import hashlib
import json
import os
import traceback

__all__ = ["Run", "run_script", "c4d_version"]


def _iso(t):
    return datetime.datetime.fromtimestamp(t, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def c4d_version():
    """c4d.GetC4DVersion() inside Cinema 4D (an int, e.g. 2026000); None anywhere else."""
    try:
        import c4d  # noqa: F401 (only present inside Cinema 4D)
        return int(c4d.GetC4DVersion())
    except Exception:
        return None


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Run(object):
    """One script run: where to write, the files it made, and its result file."""

    def __init__(self, root=None, result=None, out=None):
        import time
        self.started = time.time()
        self.root = os.path.abspath(root or os.environ.get("TIMMY_ROOT") or os.getcwd())
        self.out = os.path.abspath(out or os.environ.get("TIMMY_OUT") or os.path.join(self.root, "out"))
        self.result_path = os.path.abspath(result or os.environ.get("TIMMY_RESULT") or os.path.join(self.out, "timmy-result.json"))
        self.run = os.environ.get("TIMMY_RUN")
        self.script_sha256 = os.environ.get("TIMMY_SCRIPT_SHA256")
        script = os.environ.get("TIMMY_SCRIPT")
        self.script_sha256_read = _sha256(script) if script and os.path.isfile(script) else None
        self.files = {}
        self.notes = []

    def out_path(self, *parts):
        """A path in the out folder, its folder made."""
        path = os.path.join(self.out, *parts)
        folder = os.path.dirname(path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        return path

    def name(self, path):
        """The path as the result names it: relative to the project folder when inside it."""
        path = os.path.abspath(path)
        rel = os.path.relpath(path, self.root)
        if rel == os.pardir or rel.startswith(os.pardir + os.sep):
            return path
        return rel.replace(os.sep, "/")

    def add_file(self, path):
        """Record a file this run made, by its sha256. A missing file raises: the run did not make it."""
        if not os.path.isfile(path):
            raise IOError("%s was not written" % self.name(path))
        self.files[self.name(path)] = _sha256(path)
        return path

    def note(self, text):
        """A sentence for the result's notes (what was not established, a fallback taken)."""
        self.notes.append(self.scrub(str(text)))

    def scrub(self, text):
        """Free text with the project folder written as "." and the home folder as "~"."""
        out = text
        for folder in sorted({self.root, os.path.realpath(self.root)}, key=len, reverse=True):
            if len(folder) > 1:
                out = out.replace(folder, ".")
        home = os.path.expanduser("~")
        if len(home) > 1:
            out = out.replace(home, "~")
        return out

    def write(self, ok, error=None, extra=None):
        """Write the result file: to a temporary name, then renamed over the result, so it is never half there."""
        import time
        ended = time.time()
        body = {}
        if isinstance(extra, dict):
            body.update(extra)
        body.update({
            "ok": bool(ok),
            "run": self.run,
            "script_sha256": self.script_sha256,
            "files": dict(self.files),
            "c4d_version": c4d_version(),
            "timing": {"started": _iso(self.started), "ended": _iso(ended), "seconds": round(ended - self.started, 3)},
        })
        if self.script_sha256_read is not None:
            body["script_sha256_read"] = self.script_sha256_read
        if self.notes:
            body["notes"] = list(self.notes)
        if error is not None:
            body["error"] = self.scrub(str(error))
        folder = os.path.dirname(self.result_path)
        if not os.path.isdir(folder):
            os.makedirs(folder)
        temp = "%s.%d.tmp" % (self.result_path, os.getpid())
        with open(temp, "w") as f:
            json.dump(body, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(temp, self.result_path)
        return body


def run_script(main, root=None, result=None):
    """Run main(run) and write the result file: ok when main returns, ok: false with the error when it raises.

    Returns the result written. It does not exit the process: the result file, not c4dpy's exit status, is
    the run's outcome.
    """
    run = Run(root=root, result=result)
    try:
        extra = main(run)
    except Exception as e:  # noqa: BLE001 (every failure is written down, never lost)
        tb = traceback.format_exc()
        return run.write(False, error="%s: %s" % (type(e).__name__, e), extra={"traceback": run.scrub(tb)[-4000:]})
    return run.write(True, extra=extra if isinstance(extra, dict) else None)

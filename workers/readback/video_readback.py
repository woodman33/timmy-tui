#!/usr/bin/env python3
"""timmy-video-readback: a rendered video read outside the application that rendered it, as one line of JSON on stdout.

Usage: video_readback.py <video> --plan <plan.json> [--frames-dir <dir>] [--as <name to report>]

Round R4 (/iterate ae, helper H41): after aerender has rendered a comp and Timmy has judged that run, this worker reads
the rendered file with FFmpeg's own tools, outside After Effects:
  - ffprobe: the first video stream's codec, pixel format, width, height, frame rate (r_frame_rate), duration and frame
    count (the container's nb_frames, else the packets ffprobe counts with -count_packets);
  - ffmpeg: for each time the plan names, the one frame shown then, as raw RGB (-f rawvideo -pix_fmt rgb24), scaled down
    by an integer factor k (stated in the output; area averaging); then, for each layer the plan names at that time, the
    centroid of the pixels within a colour tolerance of the layer's colour, in the video's pixels and in the comp's.
It measures the rendered file: ffprobe's and ffmpeg's reading of it, and Timmy's own pixel arithmetic here. It knows
nothing of After Effects and checks nothing of how After Effects renders: Timmy compares what this reports with After
Effects' own report of the project it rendered.

The plan (JSON, written by Timmy):
  {"schema": "timmy.video-readback-plan/1", "comp": {"width": W, "height": H, "start": S},
   "targets": [{"layer": "<name>", "colour": [r, g, b], "times": [t, ...]}]}
colours in 0..1 (After Effects' own), times in comp seconds; frame n of the video shows comp time S + n / fps. Frame n is
read by seeking to the time half a frame before it (ffmpeg -ss as an input option decodes from the keyframe before and
gives the first frame at or after that time: frame n), or from the start for frame 0.

ffprobe and ffmpeg are TIMMY_FFPROBE and TIMMY_FFMPEG when set (a setting that names nothing runnable is an error, never
replaced by another copy), else ffprobe and ffmpeg on PATH. Nothing is written but the frames' pictures, as PNG files in
--frames-dir (each new; one already there is left as it is and said so).

Exit 0 with {"ok": true, ...}; 2 when the video or the plan cannot be read, or ffprobe fails on it; 3 when ffprobe or
ffmpeg is missing; 64 on a usage error; each failure with {"ok": false, "error": {...}} on stdout. A frame ffmpeg cannot
give is said in its samples, not a failure of the whole read. Python 3.8 or later, standard library only.
"""
import hashlib
import json
import math
import os
import platform
import shutil
import struct
import subprocess
import sys
import zlib
from fractions import Fraction

WORKER = {"name": "timmy-video-readback", "version": "0.1.0"}
SCOPE = ("measured from the rendered file by ffprobe, ffmpeg and Timmy's pixel reading, outside After Effects; "
         "it checks the render against After Effects' own report, not After Effects' renderer itself")
PLAN_SCHEMA = "timmy.video-readback-plan/1"
# The scaled frame is at most this wide: k = ceil(width / 480), so a 1920x1080 render is read at 480x270 (k = 4).
MAX_SCALED_WIDTH = 480
# A pixel matches a colour when its Euclidean distance from it in 8-bit RGB is at most this (an H.264 encode and a
# decode read with another colour matrix were seen to move a green by about 22).
COLOUR_TOLERANCE = 48.0
COLOUR_METRIC = "Euclidean distance in 8-bit RGB"
MAX_TARGETS = 32
MAX_SAMPLES = 120
MAX_FRAMES = 60
MAX_LINE = 60000
TOOL_TIMEOUT_S = 120
SCALE_FILTER = "scale=%d:%d:flags=area"


def emit(obj, code=0):
    line = json.dumps(obj, separators=(",", ":"), sort_keys=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, kind, message, extra=None):
    out = {"ok": False, "worker": WORKER, "python": platform.python_version(), "error": {"code": kind, "message": message}}
    if extra:
        out.update(extra)
    emit(out, code)


USAGE = "usage: video_readback.py <video> --plan <plan.json> [--frames-dir <dir>] [--as <name>]"


def parse_args(argv):
    video, plan, frames, name = None, None, None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--plan", "--frames-dir", "--as"):
            if i + 1 >= len(argv):
                fail(64, "usage", USAGE)
            if a == "--plan":
                plan = argv[i + 1]
            elif a == "--frames-dir":
                frames = argv[i + 1]
            else:
                name = argv[i + 1]
            i += 2
            continue
        if a.startswith("-"):
            fail(64, "usage", USAGE)
        if video is not None:
            fail(64, "usage", "video_readback.py reads one video file")
        video = a
        i += 1
    if video is None or plan is None:
        fail(64, "usage", USAGE)
    return video, plan, frames, name or os.path.basename(video)


def find_tool(name, env_var):
    """The tool's path: the environment variable's, which must be runnable, else the one on PATH; None when there is none."""
    given = (os.environ.get(env_var) or "").strip()
    if given:
        if os.path.isfile(given) and os.access(given, os.X_OK):
            return given, "env"
        fail(3, "no-" + name, "%s is set, but nothing runnable is there" % env_var)
    found = shutil.which(name)
    return (found, "path") if found else (None, None)


def tool_version(path):
    try:
        p = subprocess.run([path, "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        first = p.stdout.decode("utf-8", "replace").splitlines()[0] if p.stdout else ""
        cut = first.find(" Copyright")
        return (first[:cut] if cut > 0 else first)[:120] or None
    except Exception:
        return None


def sha256_of(path):
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def last_line(b, video, name):
    """The last line a tool wrote, with the video's path written as its reported name."""
    text = b.decode("utf-8", "replace").strip() if b else ""
    line = text.splitlines()[-1] if text else ""
    return line.replace(video, name)[:300]


def rational(s):
    try:
        if isinstance(s, str) and "/" in s:
            num, den = s.split("/", 1)
            num, den = int(num), int(den)
            if num > 0 and den > 0:
                return num, den
    except Exception:
        pass
    return None


def number(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except Exception:
        return None


def whole(v):
    try:
        if isinstance(v, str) and v.isdigit():
            return int(v)
        if isinstance(v, int) and not isinstance(v, bool):
            return v
    except Exception:
        pass
    return None


def probe(ffprobe, video, name):
    entries = ("stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_packets,duration,start_time"
               ":format=duration,format_name,start_time")
    args = [ffprobe, "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", entries, "-of", "json", video]
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=TOOL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        fail(2, "ffprobe-timeout", "ffprobe did not answer within %d s" % TOOL_TIMEOUT_S)
    except Exception as e:
        fail(3, "no-ffprobe", "ffprobe did not start (%s)" % type(e).__name__)
    if p.returncode != 0:
        fail(2, "ffprobe-failed", "ffprobe exited %d: %s" % (p.returncode, last_line(p.stderr, video, name) or "no message"))
    try:
        data = json.loads(p.stdout.decode("utf-8", "replace"))
    except Exception:
        fail(2, "ffprobe-output", "ffprobe's output is not JSON: %s" % last_line(p.stdout, video, name))
    streams = data.get("streams") if isinstance(data, dict) else None
    if not isinstance(streams, list) or not streams or not isinstance(streams[0], dict):
        fail(2, "no-video", "ffprobe found no video stream in the file")
    s = streams[0]
    f = data.get("format") if isinstance(data.get("format"), dict) else {}
    width, height = whole(s.get("width")), whole(s.get("height"))
    if not width or not height:
        fail(2, "no-size", "ffprobe gave no width and height for the video stream")
    fps = rational(s.get("r_frame_rate")) or rational(s.get("avg_frame_rate"))
    if not fps:
        fail(2, "no-frame-rate", "ffprobe gave no frame rate for the video stream (r_frame_rate %s, avg_frame_rate %s)" % (s.get("r_frame_rate"), s.get("avg_frame_rate")))
    frames, frames_from = whole(s.get("nb_frames")), "nb_frames (the container's count)"
    if not frames:
        frames, frames_from = whole(s.get("nb_read_packets")), "packets counted by ffprobe -count_packets"
    if not frames:
        frames, frames_from = None, None
    duration, duration_from = number(f.get("duration")), "the container (format duration)"
    if duration is None:
        duration, duration_from = number(s.get("duration")), "the video stream"
    if duration is None and frames:
        duration, duration_from = frames * fps[1] / fps[0], "frames / frame rate"
    return {
        "codec": s.get("codec_name"), "pix_fmt": s.get("pix_fmt"), "format": f.get("format_name"),
        "width": width, "height": height, "fps": [fps[0], fps[1]], "fps_value": round(fps[0] / fps[1], 6),
        "duration": duration, "duration_from": duration_from, "frames": frames, "frames_from": frames_from,
        "start_time": number(f.get("start_time")) if number(f.get("start_time")) is not None else number(s.get("start_time")),
    }


def read_plan(path):
    try:
        with open(path, "rb") as fh:
            raw = fh.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            fail(2, "plan", "the plan is larger than 4 MB")
        plan = json.loads(raw.decode("utf-8"))
    except SystemExit:
        raise
    except Exception as e:
        fail(2, "plan", "the plan cannot be read as JSON (%s)" % type(e).__name__)
    if not isinstance(plan, dict) or plan.get("schema") != PLAN_SCHEMA:
        fail(2, "plan", "the plan is not a %s plan" % PLAN_SCHEMA)
    comp = plan.get("comp") if isinstance(plan.get("comp"), dict) else {}
    cw, ch = number(comp.get("width")), number(comp.get("height"))
    if not cw or not ch or cw <= 0 or ch <= 0:
        fail(2, "plan", "the plan gives no comp width and height")
    start = number(comp.get("start")) or 0.0
    targets = []
    raw_targets = plan.get("targets") if isinstance(plan.get("targets"), list) else []
    for t in raw_targets[:MAX_TARGETS]:
        if not isinstance(t, dict) or not isinstance(t.get("layer"), str):
            fail(2, "plan", "a target in the plan names no layer")
        colour = t.get("colour")
        if not isinstance(colour, list) or len(colour) != 3 or any(number(c) is None or not (0 <= number(c) <= 1) for c in colour):
            fail(2, "plan", "the target %s has no colour as [r, g, b] in 0..1" % json.dumps(t.get("layer")[:80]))
        times = [number(x) for x in (t.get("times") if isinstance(t.get("times"), list) else [])]
        if any(x is None for x in times):
            fail(2, "plan", "the target %s has a time that is not a number" % json.dumps(t.get("layer")[:80]))
        targets.append({"layer": t["layer"][:200], "colour": [float(c) for c in colour], "times": times})
    return {"width": cw, "height": ch, "start": start}, targets, max(0, len(raw_targets) - MAX_TARGETS)


def frame_bytes(ffmpeg, video, n, fps, w, h):
    """Frame n of the video, scaled to w x h, as raw RGB; (bytes, the last line ffmpeg wrote on stderr)."""
    args = [ffmpeg, "-v", "error", "-nostdin"]
    if n > 0:
        args += ["-ss", "%.6f" % ((n - 0.5) * fps[1] / fps[0])]
    args += ["-i", video, "-map", "0:v:0", "-frames:v", "1", "-vf", SCALE_FILTER % (w, h), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=TOOL_TIMEOUT_S)
    return p.stdout, p.stderr, p.returncode


def centroid(buf, w, h, rgb, tolerance):
    """The pixels within `tolerance` of the colour: how many, their centroid in scaled pixels (centres at +0.5), their box."""
    r0, g0, b0 = rgb
    t2 = tolerance * tolerance
    sx = sy = n = 0
    x0, y0, x1, y1 = w, h, -1, -1
    i = 0
    for y in range(h):
        for x in range(w):
            dr = buf[i] - r0
            dg = buf[i + 1] - g0
            db = buf[i + 2] - b0
            if dr * dr + dg * dg + db * db <= t2:
                sx += x
                sy += y
                n += 1
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
            i += 3
    if not n:
        return 0, None, None
    return n, (sx / n + 0.5, sy / n + 0.5), (x0, y0, x1 + 1, y1 + 1)


def png_bytes(w, h, rgb):
    """A PNG (8-bit RGB, no filter) of the frame, written with zlib alone."""
    stride = w * 3
    raw = b"".join(b"\x00" + bytes(rgb[y * stride:(y + 1) * stride]) for y in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def write_png(folder, n, w, h, rgb):
    name = "frame-%06d.png" % n
    data = png_bytes(w, h, rgb)
    try:
        with open(os.path.join(folder, name), "xb") as out:
            out.write(data)
    except FileExistsError:
        return {"png": name, "written": False, "why": "a file of that name was already there; it was left as it is"}
    except Exception as e:
        return {"png": name, "written": False, "why": "it could not be written (%s)" % type(e).__name__}
    return {"png": name, "written": True, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def r6(x):
    return None if x is None else round(x, 6)


def main():
    video, plan_path, frames_dir, name = parse_args(sys.argv[1:])
    if not os.path.isfile(video):
        fail(2, "unreadable", "there is no video file at %s" % name)
    comp, targets, targets_left_out = read_plan(plan_path)
    ffprobe, ffprobe_how = find_tool("ffprobe", "TIMMY_FFPROBE")
    ffmpeg, ffmpeg_how = find_tool("ffmpeg", "TIMMY_FFMPEG")
    if not ffprobe or not ffmpeg:
        if not ffprobe and not ffmpeg:
            words = "ffprobe and ffmpeg were not found: TIMMY_FFPROBE and TIMMY_FFMPEG are not set, and neither is on PATH"
        else:
            missing = "ffprobe" if not ffprobe else "ffmpeg"
            words = "%s was not found: TIMMY_%s is not set, and it is not on PATH" % (missing, missing.upper())
        fail(3, "no-ffmpeg", "%s. Setup: brew install ffmpeg (it brings both)" % words)
    try:
        sha_before, size = sha256_of(video)
    except Exception as e:
        fail(2, "unreadable", "the video cannot be read (%s)" % type(e).__name__)
    source = {"name": name, "sha256": sha_before, "bytes": size}
    tools = {
        "ffprobe": {"found": ffprobe_how, "version": tool_version(ffprobe)},
        "ffmpeg": {"found": ffmpeg_how, "version": tool_version(ffmpeg)},
    }
    info = probe(ffprobe, video, name)
    vw, vh, fps = info["width"], info["height"], info["fps"]
    k = max(1, int(math.ceil(vw / float(MAX_SCALED_WIDTH))))
    w, h = max(1, vw // k), max(1, vh // k)
    sx, sy = vw / float(w), vh / float(h)
    to_comp = (comp["width"] / float(vw), comp["height"] / float(vh))
    if frames_dir:
        try:
            os.makedirs(frames_dir, exist_ok=True)
        except Exception as e:
            fail(2, "frames-dir", "the frames folder cannot be made (%s)" % type(e).__name__)

    # Each time asked, as the frame that shows it: frame n shows comp time start + n / fps.
    samples, by_frame, left_out = [], {}, 0
    for t in targets:
        rgb8 = [int(round(c * 255)) for c in t["colour"]]
        for when in t["times"]:
            if len(samples) >= MAX_SAMPLES:
                left_out += 1
                continue
            n = int(math.floor((Fraction(when) - Fraction(comp["start"])) * Fraction(fps[0], fps[1]) + Fraction(1, 2)))
            s = {"layer": t["layer"], "time": r6(when), "frame": n, "frame_time": r6(comp["start"] + n * fps[1] / float(fps[0])), "colour_rgb8": rgb8}
            if n < 0:
                s["why"] = "before the render's first frame"
            elif info["frames"] is not None and n >= info["frames"]:
                s["why"] = "past the render's last frame (frame %d)" % (info["frames"] - 1)
            elif n not in by_frame and len(by_frame) >= MAX_FRAMES:
                s["why"] = "past the %d frames one read takes" % MAX_FRAMES
            else:
                by_frame.setdefault(n, []).append(s)
            samples.append(s)

    frames = []
    for n in sorted(by_frame):
        try:
            buf, err, code = frame_bytes(ffmpeg, video, n, fps, w, h)
        except subprocess.TimeoutExpired:
            buf, err, code = b"", b"ffmpeg did not answer in time", None
        except Exception as e:
            fail(3, "no-ffmpeg", "ffmpeg did not start (%s)" % type(e).__name__)
        entry = {"frame": n, "time": r6(comp["start"] + n * fps[1] / float(fps[0]))}
        why = None
        if len(buf) != w * h * 3:
            got = "no frame" if not buf else "%d bytes, not %d x %d x 3 = %d" % (len(buf), w, h, w * h * 3)
            why = "ffmpeg gave %s for frame %d%s%s" % (got, n, "" if code in (0, None) else " (it exited %d)" % code, (": " + last_line(err, video, name)) if err else "")
            entry["why"] = why
        else:
            if frames_dir:
                entry.update(write_png(frames_dir, n, w, h, buf))
            for s in by_frame[n]:
                count, c, box = centroid(buf, w, h, s["colour_rgb8"], COLOUR_TOLERANCE)
                s["pixels"] = count
                if c is None:
                    s["found"] = False
                    continue
                s["found"] = True
                cv = (c[0] * sx, c[1] * sy)
                s["centroid_video"] = [r6(cv[0]), r6(cv[1])]
                s["centroid_comp"] = [r6(cv[0] * to_comp[0]), r6(cv[1] * to_comp[1])]
                s["box_video"] = [r6(box[0] * sx), r6(box[1] * sy), r6(box[2] * sx), r6(box[3] * sy)]
        if why:
            for s in by_frame[n]:
                s["why"] = why
        frames.append(entry)

    try:
        sha_after, _ = sha256_of(video)
    except Exception:
        sha_after = None
    out = {
        "ok": True, "worker": WORKER, "python": platform.python_version(), "tools": tools, "source": source,
        "unchanged_during_read": sha_after == sha_before,
        "probe": info, "scale": k, "scaled": [w, h], "scale_factors": [r6(sx), r6(sy)], "scale_filter": SCALE_FILTER % (w, h),
        "comp": comp, "colour_tolerance": COLOUR_TOLERANCE, "colour_metric": COLOUR_METRIC,
        "samples": samples, "frames": frames, "scope": SCOPE,
    }
    if left_out:
        out["samples_left_out"] = left_out
    if targets_left_out:
        out["targets_left_out"] = targets_left_out
    line = json.dumps(out, separators=(",", ":"))
    while len(line) > MAX_LINE and out["samples"]:
        # bounded: the boxes go first, then the last samples (counted)
        for s in out["samples"]:
            s.pop("box_video", None)
        line = json.dumps(out, separators=(",", ":"))
        if len(line) > MAX_LINE:
            keep = max(1, len(out["samples"]) // 2)
            out["samples_left_out"] = out.get("samples_left_out", 0) + len(out["samples"]) - keep
            out["samples"] = out["samples"][:keep]
            line = json.dumps(out, separators=(",", ":"))
    emit(out)


if __name__ == "__main__":
    main()

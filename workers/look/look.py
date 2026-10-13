#!/usr/bin/env python3
"""timmy-look: deterministic OpenCV measurements of one image, as one line of JSON on stdout.

Usage: look.py <image> [--as <name to report>]
       look.py <image> [--as <name>] --vox detect [--out <png>] [--color r,g,b] [--tolerance t] [--no-qr] [--no-aruco]
       look.py <image> [--as <name>] --vox diff --other <image> [--other-as <name>] [--out <png>]

Every measurement is a deterministic computation on the file's pixels (tier "deterministic computation"):
it says what the numbers are, never what the image shows. The image is read once; the bytes hashed are the
bytes measured. The source is reported by the name given with --as (else the file's base name), never by
its folder. Exit 0 with {"ok": true, ...}; exit 2 when the image cannot be read, 3 when OpenCV or NumPy is
missing, 64 on a usage error, each with {"ok": false, "error": {...}} on stdout.

Round R4 (VoxVision, helper H49): two more modes, behind --vox. Without --vox the output is what it always was.
  --vox detect   the same observation, plus (with --color) the pixels within a colour tolerance of r,g,b: how
                 many, their centroid and their box, by the video readback's metric (Euclidean distance in 8-bit
                 RGB, tolerance 48 unless --tolerance says otherwise). With --out, a new PNG (never written over
                 a file) is drawn from exactly those measurements: the decoded QR codes' outlines, the ArUco
                 markers' outlines and ids, and the colour region's box and centroid. Nothing is drawn that was
                 not measured in this run; with nothing to draw, no file is written and the answer says so.
  --vox diff     both images observed as above, then the pixel difference of their 8-bit colour channels when
                 they are the same size (never resized): at each pixel the largest channel difference, the share
                 of pixels that differ, and with --out a heatmap PNG of that difference on a fixed scale (0 to
                 255, OpenCV's INFERNO colour map, not normalised). Images of different sizes are not compared.
The highlight files are named in the answer by their base name only, with the sha256 of the bytes written.

Python 3.9 or later; OpenCV (cv2) and NumPy.
"""
import hashlib
import json
import os
import platform
import sys

WORKER = {"name": "timmy-look", "version": "0.1.0"}
TIER = "deterministic computation"
MAX_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 50_000_000
KMEANS_SAMPLE = 40_000
MAX_CODES = 20
MAX_MARKERS = 50
MAX_TEXT = 2048
# R4 (VoxVision): the --vox modes' own version, and the colour region's metric (workers/readback/video_readback.py's).
VOX = "vox/1"
COLOR_TOLERANCE = 48.0
COLOR_METRIC = "Euclidean distance in 8-bit RGB"
DIFF_OVER = 16
VOX_USAGE = ("usage: look.py <image> [--as <name>] --vox detect [--out <png>] [--color r,g,b] [--tolerance t] [--no-qr] [--no-aruco]"
             " | --vox diff --other <image> [--other-as <name>] [--out <png>]")
# Drawing colours (BGR): Homebrew green for QR codes, amber for ArUco markers, blue for the colour region.
QR_BGR = (20, 254, 40)
ARUCO_BGR = (80, 181, 229)
REGION_BGR = (255, 168, 108)


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), sort_keys=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, kind, message):
    emit({"ok": False, "worker": WORKER, "python": platform.python_version(), "error": {"code": kind, "message": message}}, code)


class Refusal(Exception):
    """A failure with its exit status, kind and message: fail() as an exception, so one run can read two images."""

    def __init__(self, code, kind, message):
        Exception.__init__(self, message)
        self.code = code
        self.kind = kind
        self.message = message


def parse_args(argv):
    image, name = None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--as" and i + 1 < len(argv):
            name = argv[i + 1]
            i += 2
            continue
        if a.startswith("-"):
            fail(64, "usage", "usage: look.py <image> [--as <name>]")
        if image is not None:
            fail(64, "usage", "look.py measures one image")
        image = a
        i += 1
    if image is None:
        fail(64, "usage", "usage: look.py <image> [--as <name>]")
    return image, name or os.path.basename(image)


def hex_of(rgb):
    return "#" + "".join("%02x" % int(max(0, min(255, round(c)))) for c in rgb)


def imports():
    try:
        import numpy as np
    except Exception:
        fail(3, "no-numpy", "NumPy is not importable in this Python: python3 -m pip install numpy")
    try:
        import cv2
    except Exception:
        fail(3, "no-opencv", "OpenCV (cv2) is not importable in this Python: python3 -m pip install opencv-python-headless")
    return np, cv2


def read_bytes(image_path):
    """The file's bytes, read once (at most MAX_BYTES)."""
    try:
        size = os.path.getsize(image_path)
        if size > MAX_BYTES:
            raise Refusal(2, "too-large", "the image is larger than %d MB" % (MAX_BYTES // (1024 * 1024)))
        with open(image_path, "rb") as f:
            return f.read()
    except OSError as e:
        raise Refusal(2, "unreadable", "could not read the file (%s)" % (e.strerror or "error"))


def decode(data, np, cv2):
    """The image as Look measures it: 8-bit, as BGR and grayscale, with its alpha, its size and what was done to it."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None or img.size == 0:
        raise Refusal(2, "unreadable", "OpenCV could not decode the image (a format it does not read, such as HEIC, or a damaged file)")
    if img.ndim == 3 and img.shape[0] * img.shape[1] > MAX_PIXELS:
        raise Refusal(2, "too-large", "the image has more than %d pixels" % MAX_PIXELS)

    height, width = int(img.shape[0]), int(img.shape[1])
    channels = 1 if img.ndim == 2 else int(img.shape[2])
    notes = []
    if img.dtype != np.uint8:
        # 16-bit (or float) images are scaled to 8 bits for every measurement below.
        if img.dtype == np.uint16:
            img = (img / 257.0).round().astype(np.uint8)
        else:
            img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        notes.append("The image is not 8-bit; it was scaled to 8 bits before measuring.")

    alpha = None
    if channels == 1:
        bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    elif channels == 4:
        alpha = img[:, :, 3]
        bgr = img[:, :, :3]
    else:
        bgr = img[:, :, :3]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return {"bgr": bgr, "gray": gray, "alpha": alpha, "width": width, "height": height, "channels": channels, "notes": notes}


def observe(data, name, np, cv2):
    """The observation of one image's bytes: exactly what look.py prints without --vox, and the decoded image."""
    sha256 = hashlib.sha256(data).hexdigest()
    d = decode(data, np, cv2)
    width, height, channels, notes = d["width"], d["height"], d["channels"], list(d["notes"])
    bgr, gray, alpha = d["bgr"], d["gray"], d["alpha"]

    # Pixels that count for color: the visible ones when there is an alpha channel.
    pixels = bgr.reshape(-1, 3)
    if alpha is not None:
        visible = alpha.reshape(-1) > 0
        if visible.any():
            pixels = pixels[visible]
        notes.append("Colors count only pixels with alpha above 0.")

    measurements = []
    mean_bgr = pixels.mean(axis=0) if len(pixels) else np.zeros(3)
    rgb = [float(mean_bgr[2]), float(mean_bgr[1]), float(mean_bgr[0])]
    measurements.append({
        "name": "mean_color",
        "value": {"r": round(rgb[0], 2), "g": round(rgb[1], 2), "b": round(rgb[2], 2), "hex": hex_of(rgb)},
        "unit": "sRGB 8-bit, uncalibrated",
        "tier": TIER,
        "note": "The average of the stored pixel values, read as sRGB; not the color of a real surface.",
    })

    # Dominant colors: k-means on a deterministic, evenly spaced sample, with a fixed seed.
    step = max(1, len(pixels) // KMEANS_SAMPLE)
    sample = np.ascontiguousarray(pixels[::step]).astype(np.float32)
    unique = len(np.unique(sample, axis=0)) if len(sample) else 0
    k = int(min(5, unique))
    dominant = []
    if k > 0:
        cv2.setRNGSeed(0)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.5)
        _, labels, centers = cv2.kmeans(sample, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
        counts = np.bincount(labels.reshape(-1), minlength=k)
        order = sorted(range(k), key=lambda i: (-int(counts[i]), hex_of(centers[i][::-1])))
        total = float(counts.sum())
        for i in order:
            c = centers[i]
            dominant.append({"hex": hex_of([c[2], c[1], c[0]]), "rgb": [int(round(c[2])), int(round(c[1])), int(round(c[0]))], "share": round(float(counts[i]) / total, 4)})
    measurements.append({
        "name": "dominant_colors",
        "value": dominant,
        "unit": "sRGB 8-bit, uncalibrated; share of pixels (0 to 1)",
        "tier": TIER,
        "note": "k-means, k = %d, seed 0, on %d of %d pixels taken at an even step." % (k, len(sample), len(pixels)),
    })

    lap = cv2.Laplacian(gray, cv2.CV_64F)
    measurements.append({
        "name": "sharpness",
        "value": round(float(lap.var()), 3),
        "unit": "variance of the Laplacian (relative)",
        "tier": TIER,
        "note": "Higher is sharper only between images of the same size and kind; there is no absolute scale.",
    })

    edges = cv2.Canny(gray, 100, 200)
    measurements.append({
        "name": "edge_density",
        "value": round(float(np.count_nonzero(edges)) / float(edges.size), 5),
        "unit": "fraction of pixels",
        "tier": TIER,
        "note": "Canny edges with thresholds 100 and 200 on the grayscale image.",
    })

    codes = []
    try:
        detector = cv2.QRCodeDetector()
        ok, texts, points, _ = detector.detectAndDecodeMulti(bgr)
        if ok and texts is not None:
            for t, p in zip(texts, points if points is not None else []):
                if t:
                    codes.append({"text": t[:MAX_TEXT], "corners": [[round(float(x), 1), round(float(y), 1)] for x, y in p]})
        if not codes:
            t, p, _ = detector.detectAndDecode(bgr)
            if t:
                corners = [[round(float(x), 1), round(float(y), 1)] for x, y in p.reshape(-1, 2)] if p is not None else []
                codes.append({"text": t[:MAX_TEXT], "corners": corners})
        qr = {"name": "qr_codes_decoded", "value": codes[:MAX_CODES], "unit": "decoded text and corner pixels", "tier": TIER,
              "note": "Codes OpenCV decoded. None decoded does not show there is none: a small, blurred or steep code can be missed."}
    except Exception as e:  # an OpenCV build without the QR detector
        qr = {"name": "qr_codes_decoded", "value": None, "unit": "decoded text and corner pixels", "tier": TIER,
              "note": "Not measured: the QR detector failed here (%s)." % type(e).__name__}
    measurements.append(qr)

    if hasattr(cv2, "aruco"):
        try:
            aruco = cv2.aruco
            dictionary = aruco.getPredefinedDictionary(aruco.DICT_4X4_50)
            detector = aruco.ArucoDetector(dictionary, aruco.DetectorParameters())
            corners, ids, _ = detector.detectMarkers(gray)
            found = []
            if ids is not None:
                for c, i in sorted(zip(corners, ids.reshape(-1)), key=lambda x: int(x[1])):
                    found.append({"id": int(i), "corners": [[round(float(x), 1), round(float(y), 1)] for x, y in c.reshape(-1, 2)]})
            markers = {"name": "aruco_markers", "value": found[:MAX_MARKERS], "unit": "marker id (DICT_4X4_50) and corner pixels", "tier": TIER,
                       "note": "Markers of the 4x4_50 dictionary only. None found does not show there is none."}
        except Exception as e:
            markers = {"name": "aruco_markers", "value": None, "unit": "marker id and corner pixels", "tier": TIER,
                       "note": "Not measured: the ArUco detector failed here (%s)." % type(e).__name__}
    else:
        markers = {"name": "aruco_markers", "value": None, "unit": "marker id and corner pixels", "tier": TIER,
                   "note": "Not measured: this OpenCV build has no cv2.aruco."}
    measurements.append(markers)

    uncertainty = [
        "Colors are the file's stored values read as sRGB, uncalibrated: a camera or screen changes them, so they are not the color of a real surface.",
        "Sharpness (variance of the Laplacian) compares images of the same size and kind only; it has no absolute scale.",
        "Edge density depends on the fixed Canny thresholds and on the image's size.",
        "A QR code or marker that was not decoded may still be in the image.",
        "These are computations on the pixels: they say nothing about what the image shows.",
    ] + notes

    return {
        "ok": True,
        "worker": WORKER,
        "opencv": cv2.__version__,
        "python": platform.python_version(),
        "source": {"path": name, "sha256": sha256, "bytes": len(data)},
        "image": {"width": width, "height": height, "channels": channels},
        "measurements": measurements,
        "uncertainty": uncertainty,
    }, d


# ── R4 (VoxVision): --vox detect and --vox diff ───────────────────────────────


def vox_requested(argv):
    """Whether --vox is given as a flag (not as the name after --as)."""
    i = 0
    while i < len(argv):
        if argv[i] == "--as" and i + 1 < len(argv):
            i += 2
            continue
        if argv[i] == "--vox":
            return True
        i += 1
    return False


def vox_args(argv):
    o = {"image": None, "as": None, "vox": None, "out": None, "color": None, "tolerance": COLOR_TOLERANCE,
         "other": None, "other_as": None, "qr": True, "aruco": True}
    valued = {"--as": "as", "--vox": "vox", "--out": "out", "--color": "color", "--tolerance": "tolerance", "--other": "other", "--other-as": "other_as"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in valued:
            if i + 1 >= len(argv):
                fail(64, "usage", VOX_USAGE)
            o[valued[a]] = argv[i + 1]
            i += 2
            continue
        if a == "--no-qr":
            o["qr"] = False
        elif a == "--no-aruco":
            o["aruco"] = False
        elif a.startswith("-") or o["image"] is not None:
            fail(64, "usage", VOX_USAGE)
        else:
            o["image"] = a
        i += 1
    if o["image"] is None or o["vox"] not in ("detect", "diff") or (o["vox"] == "diff") != (o["other"] is not None):
        fail(64, "usage", VOX_USAGE)
    if o["color"] is not None:
        parts = o["color"].split(",")
        if len(parts) != 3 or not all(p.strip().isdigit() and 0 <= int(p) <= 255 for p in parts):
            fail(64, "usage", "--color is r,g,b: three whole numbers from 0 to 255")
        o["color"] = [int(p) for p in parts]
    try:
        o["tolerance"] = float(o["tolerance"])
    except (TypeError, ValueError):
        fail(64, "usage", "--tolerance is a number from 0 to 442")
    if not (0 <= o["tolerance"] <= 442):
        fail(64, "usage", "--tolerance is a number from 0 to 442")
    o["as"] = o["as"] or os.path.basename(o["image"])
    if o["other"] is not None:
        o["other_as"] = o["other_as"] or os.path.basename(o["other"])
    return o


def color_region(d, rgb, tolerance, np):
    """The pixels within `tolerance` of the colour (visible ones only): how many, their centroid and their box."""
    bgr = d["bgr"]
    r, g, b = rgb
    dist2 = np.square(bgr[:, :, 2].astype(np.int32) - r)
    dist2 += np.square(bgr[:, :, 1].astype(np.int32) - g)
    dist2 += np.square(bgr[:, :, 0].astype(np.int32) - b)
    mask = dist2 <= tolerance * tolerance
    alpha = d["alpha"]
    if alpha is not None:
        mask &= alpha > 0
        counted = int(np.count_nonzero(alpha > 0))
    else:
        counted = d["width"] * d["height"]
    n = int(np.count_nonzero(mask))
    value = {"rgb": [r, g, b], "tolerance": tolerance, "pixels": n, "share": round(n / float(counted), 6) if counted else 0.0, "centroid": None, "box": None}
    if n:
        ys, xs = np.nonzero(mask)
        value["centroid"] = [round(float(xs.mean()) + 0.5, 3), round(float(ys.mean()) + 0.5, 3)]
        value["box"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    return {
        "name": "color_region",
        "value": value,
        "unit": "pixels: x to the right and y down from the image's top-left corner; share of %s pixels (0 to 1)" % ("visible" if alpha is not None else "all"),
        "tier": TIER,
        "method": "pixels whose %s from rgb(%d, %d, %d) is at most %g; centroid: their mean position, at pixel centres (+0.5); box: x0, y0, x1, y1 with x1 and y1 exclusive" % (COLOR_METRIC, r, g, b, tolerance),
        "note": "Stored pixel values read as sRGB, uncalibrated: a colour in a file is not the colour of a real surface. None found does not show the colour is not there under other light." if n else "No pixel is within the tolerance of this colour.",
    }


def write_new(path, data):
    """Writes a new file (never over one, never through a link); its sha256 and size, or why it was not written."""
    try:
        with open(path, "xb") as f:
            f.write(data)
    except FileExistsError:
        return None, "a file of that name was already there; it was left as it is"
    except OSError as e:
        return None, "it could not be written (%s)" % (e.strerror or type(e).__name__)
    return {"file": os.path.basename(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}, None


def annotate(d, qr, aruco, region, np, cv2):
    """A copy of the 8-bit image with the measured outlines drawn on it."""
    canvas = np.ascontiguousarray(d["bgr"]).copy()
    w, h = d["width"], d["height"]
    t = max(1, int(round(min(w, h) / 250.0)))
    scale = max(0.4, min(w, h) / 600.0)

    def poly(points, colour):
        pts = np.array([[int(round(x)), int(round(y))] for x, y in points], np.int32).reshape(-1, 1, 2)
        cv2.polylines(canvas, [pts], True, (0, 0, 0), t + 2, cv2.LINE_AA)
        cv2.polylines(canvas, [pts], True, colour, t, cv2.LINE_AA)

    def label(text, at, colour):
        x, y = int(round(at[0])), int(round(at[1])) - 4
        y = max(int(14 * scale), y)
        cv2.putText(canvas, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), t + 2, cv2.LINE_AA)
        cv2.putText(canvas, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, colour, t, cv2.LINE_AA)

    for i, c in enumerate(qr):
        if len(c.get("corners") or []) >= 3:
            poly(c["corners"], QR_BGR)
            label("QR %d" % (i + 1), min(c["corners"], key=lambda p: (p[1], p[0])), QR_BGR)
    for m in aruco:
        if len(m.get("corners") or []) >= 3:
            poly(m["corners"], ARUCO_BGR)
            label("id %d" % m["id"], min(m["corners"], key=lambda p: (p[1], p[0])), ARUCO_BGR)
    if region is not None and region["value"]["box"]:
        x0, y0, x1, y1 = region["value"]["box"]
        cv2.rectangle(canvas, (x0, y0), (max(x0, x1 - 1), max(y0, y1 - 1)), (0, 0, 0), t + 2, cv2.LINE_AA)
        cv2.rectangle(canvas, (x0, y0), (max(x0, x1 - 1), max(y0, y1 - 1)), REGION_BGR, t, cv2.LINE_AA)
        cx, cy = region["value"]["centroid"]
        size = max(8, int(round(min(w, h) / 30.0)))
        at = (int(round(cx - 0.5)), int(round(cy - 0.5)))
        cv2.drawMarker(canvas, at, (0, 0, 0), cv2.MARKER_CROSS, size, t + 2, cv2.LINE_AA)
        cv2.drawMarker(canvas, at, REGION_BGR, cv2.MARKER_CROSS, size, t, cv2.LINE_AA)
    return canvas


def png_of(image, cv2):
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise Refusal(2, "encode-failed", "OpenCV could not encode the highlight as PNG")
    return buf.tobytes()


def found_list(observation, name):
    """A measurement's value as a list (None when it was not measured)."""
    for m in observation["measurements"]:
        if m["name"] == name:
            return m["value"] if isinstance(m["value"], list) else []
    return []


def vox_detect(o, np, cv2):
    data = read_bytes(o["image"])
    obs, d = observe(data, o["as"], np, cv2)
    region = color_region(d, o["color"], o["tolerance"], np) if o["color"] is not None else None
    qr = found_list(obs, "qr_codes_decoded") if o["qr"] else []
    aruco = found_list(obs, "aruco_markers") if o["aruco"] else []
    drawn_from = (["qr_codes_decoded"] if qr else []) + (["aruco_markers"] if aruco else []) + (["color_region"] if region and region["value"]["box"] else [])
    highlight, why = None, None
    if not o["out"]:
        why = "no highlight was asked for"
    elif not drawn_from:
        why = "nothing was detected to outline, so no annotated copy was written"
    else:
        highlight, why = write_new(o["out"], png_of(annotate(d, qr, aruco, region, np, cv2), cv2))
        if highlight:
            highlight.update({"width": d["width"], "height": d["height"], "drawn_from": drawn_from,
                              "drawn": {"qr_codes": len(qr), "aruco_markers": len(aruco), "color_region": "color_region" in drawn_from},
                              "method": "a copy of the image as measured (8-bit colour); outlines drawn at the measured corner pixels, the colour region's box and a cross at its centroid"})
    out = {"ok": True, "worker": WORKER, "mode": "vox detect", "vox": VOX, "opencv": cv2.__version__, "python": platform.python_version(),
           "observation": obs, "asked": {"qr": o["qr"], "aruco": o["aruco"], "color": o["color"]}, "highlight": highlight}
    if region is not None:
        out["color_region"] = region
    if why:
        out["highlight_note"] = why
    return out


def difference(da, db, np, cv2):
    """The pixel difference of two decoded images of the same size: a measurement, and the per-pixel map."""
    if (da["width"], da["height"]) != (db["width"], db["height"]):
        return {"name": "pixel_difference", "value": None, "unit": "pixels", "tier": TIER,
                "method": "not measured", "note": "Not measured: the images differ in size (%dx%d and %dx%d); a pixel difference needs the same size, and neither image was resized." % (da["width"], da["height"], db["width"], db["height"])}, None
    per = cv2.absdiff(np.ascontiguousarray(da["bgr"]), np.ascontiguousarray(db["bgr"])).max(axis=2)
    n = int(per.size)
    changed = int(np.count_nonzero(per))
    over = int(np.count_nonzero(per > DIFF_OVER))
    alpha = da["alpha"] is not None or db["alpha"] is not None
    return {
        "name": "pixel_difference",
        "value": {"pixels": n, "changed": changed, "changed_share": round(changed / float(n), 6), "changed_over_16": over,
                  "changed_over_16_share": round(over / float(n), 6), "max": int(per.max()), "mean": round(float(per.mean()), 4)},
        "unit": "8-bit levels; shares of all pixels (0 to 1)",
        "tier": TIER,
        "method": "at each pixel, the largest of the three 8-bit colour channel differences |a - b| (both images as measured: 8-bit, grey as three equal channels); changed means above 0, and above 16 is counted apart",
        "note": "A re-encoded or resized copy changes values by a few levels: changed_over_16 counts larger differences apart." + (" Alpha is not compared." if alpha else ""),
    }, per


def vox_diff(o, np, cv2):
    data_a = read_bytes(o["image"])
    obs_a, da = observe(data_a, o["as"], np, cv2)
    try:
        data_b = read_bytes(o["other"])
        obs_b, db = observe(data_b, o["other_as"], np, cv2)
    except Refusal as r:
        raise Refusal(r.code, r.kind, "the second image (%s): %s" % (o["other_as"], r.message))
    diff, per = difference(da, db, np, cv2)
    highlight, why = None, None
    if per is None:
        why = "the images were not compared pixel by pixel, so no heatmap was drawn"
    elif not o["out"]:
        why = "no highlight was asked for"
    else:
        highlight, why = write_new(o["out"], png_of(cv2.applyColorMap(per, cv2.COLORMAP_INFERNO), cv2))
        if highlight:
            highlight.update({"width": da["width"], "height": da["height"], "drawn_from": ["pixel_difference"],
                              "method": "the per-pixel difference on a fixed scale, 0 (black) to 255 (pale yellow), OpenCV's INFERNO colour map; not normalised"})
    out = {"ok": True, "worker": WORKER, "mode": "vox diff", "vox": VOX, "opencv": cv2.__version__, "python": platform.python_version(),
           "a": obs_a, "b": obs_b, "difference": diff, "highlight": highlight}
    if why:
        out["highlight_note"] = why
    return out


def vox_main(argv):
    o = vox_args(argv)
    np, cv2 = imports()
    try:
        out = vox_detect(o, np, cv2) if o["vox"] == "detect" else vox_diff(o, np, cv2)
    except Refusal as r:
        fail(r.code, r.kind, r.message)
    emit(out)


def main():
    argv = sys.argv[1:]
    if vox_requested(argv):
        vox_main(argv)
        return
    image_path, name = parse_args(argv)
    np, cv2 = imports()
    try:
        observation = observe(read_bytes(image_path), name, np, cv2)[0]
    except Refusal as r:
        fail(r.code, r.kind, r.message)
    emit(observation)


if __name__ == "__main__":
    main()

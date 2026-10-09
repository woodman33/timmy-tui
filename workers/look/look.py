#!/usr/bin/env python3
"""timmy-look: deterministic OpenCV measurements of one image, as one line of JSON on stdout.

Usage: look.py <image> [--as <name to report>]

Every measurement is a deterministic computation on the file's pixels (tier "deterministic computation"):
it says what the numbers are, never what the image shows. The image is read once; the bytes hashed are the
bytes measured. The source is reported by the name given with --as (else the file's base name), never by
its folder. Exit 0 with {"ok": true, ...}; exit 2 when the image cannot be read, 3 when OpenCV or NumPy is
missing, 64 on a usage error, each with {"ok": false, "error": {...}} on stdout.

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


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), sort_keys=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def fail(code, kind, message):
    emit({"ok": False, "worker": WORKER, "python": platform.python_version(), "error": {"code": kind, "message": message}}, code)


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


def main():
    image_path, name = parse_args(sys.argv[1:])
    try:
        import numpy as np
    except Exception:
        fail(3, "no-numpy", "NumPy is not importable in this Python: python3 -m pip install numpy")
    try:
        import cv2
    except Exception:
        fail(3, "no-opencv", "OpenCV (cv2) is not importable in this Python: python3 -m pip install opencv-python-headless")

    try:
        size = os.path.getsize(image_path)
        if size > MAX_BYTES:
            fail(2, "too-large", "the image is larger than %d MB" % (MAX_BYTES // (1024 * 1024)))
        with open(image_path, "rb") as f:
            data = f.read()
    except OSError as e:
        fail(2, "unreadable", "could not read the file (%s)" % (e.strerror or "error"))

    sha256 = hashlib.sha256(data).hexdigest()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None or img.size == 0:
        fail(2, "unreadable", "OpenCV could not decode the image (a format it does not read, such as HEIC, or a damaged file)")
    if img.ndim == 3 and img.shape[0] * img.shape[1] > MAX_PIXELS:
        fail(2, "too-large", "the image has more than %d pixels" % MAX_PIXELS)

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

    emit({
        "ok": True,
        "worker": WORKER,
        "opencv": cv2.__version__,
        "python": platform.python_version(),
        "source": {"path": name, "sha256": sha256, "bytes": len(data)},
        "image": {"width": width, "height": height, "channels": channels},
        "measurements": measurements,
        "uncertainty": uncertainty,
    })


if __name__ == "__main__":
    main()

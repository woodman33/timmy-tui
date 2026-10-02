#!/usr/bin/env python3
"""Deterministic draft calibration target; run only in the explicitly pinned runtime.
No capture, printer access, benchmark qualification, or measured claim is performed.
"""
import argparse
import hashlib
import json
import platform
from pathlib import Path

PINS = {"python": "3.12.14", "opencv-python-headless": "4.12.0.88", "numpy": "2.2.6", "reportlab": "4.4.9", "pillow": "12.3.0"}
MM = 72 / 25.4
PAGE = (215.9, 279.4)
ORIGIN = (37.95, 65.0)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output-dir", type=Path, required=True)
    args = p.parse_args()
    from importlib.metadata import version
    actual = {k: platform.python_version() if k == "python" else version(k) for k in PINS}
    if actual != PINS:
        raise SystemExit(f"Pinned runtime required: expected {PINS}; observed {actual}")
    import cv2
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    args.output_dir.mkdir(parents=True, exist_ok=True)
    pdf = args.output_dir / "timmy-fiducial-letter-draft.pdf"
    if pdf.exists() or (args.output_dir / "manifest.json").exists():
        raise SystemExit("Refusing to overwrite existing artifacts; choose a new output directory")
    c = canvas.Canvas(str(pdf), pagesize=(612, 792), invariant=1, pageCompression=0)
    c.setTitle("Timmy draft fiducial board — actual size")
    c.setAuthor("Timmy")
    c.setCreator("Timmy board_generator/1; ReportLab 4.4.9")
    bounds = []

    def rect(x, y, w, h):
        bounds.append([x, y, x + w, y + h])
        c.rect(x * MM, (PAGE[1] - y - h) * MM, w * MM, h * MM, stroke=0, fill=1)

    def text(x, baseline, label, size=8):
        c.setFont("Helvetica", size)
        ascent, descent = pdfmetrics.getAscentDescent("Helvetica", size)
        bounds.append([x, baseline - ascent / MM, x + pdfmetrics.stringWidth(label, "Helvetica", size) / MM, baseline - descent / MM])
        c.drawString(x * MM, (PAGE[1] - baseline) * MM, label)

    a = cv2.aruco
    dictionary = a.getPredefinedDictionary(a.DICT_5X5_100)
    board = a.CharucoBoard((7, 8), 20.0, 14.0, dictionary)
    board.setLegacyPattern(False)
    tags = a.getPredefinedDictionary(a.DICT_APRILTAG_36h11)

    def marker(dic, marker_id, x, y, side, modules):
        bits = a.generateImageMarker(dic, marker_id, modules, borderBits=1)
        for row in range(modules):
            for col in range(modules):
                if bits[row, col] == 0:
                    rect(x + col * side / modules, y + row * side / modules, side / modules, side / modules)

    text(20, 15, "TIMMY  /  DRAFT FIDUCIAL BOARD", 11)
    text(20, 21, "US Letter 215.9 x 279.4 mm | Print 100% / Actual size | Disable fit-to-page", 8)
    april = []
    for marker_id, x in [(0, 37.95), (1, 153.95)]:
        marker(tags, marker_id, x, 28, 24, 8)
        text(x, 59, f"tag36h11 / ID {marker_id}", 7)
        april.append({"id": marker_id, "detected_border_xywh_mm": [x, 28, 24, 24], "quiet_zone_mm": 4})
    for row in range(8):
        for col in range(7):
            if (row + col) % 2 == 0:
                rect(ORIGIN[0] + col * 20, ORIGIN[1] + row * 20, 20, 20)
    marker_layout = []
    for marker_id, points in zip(board.getIds(), board.getObjPoints()):
        x, y = points[0, :2].tolist()
        marker(dictionary, int(marker_id), ORIGIN[0] + x, ORIGIN[1] + y, 14, 7)
        marker_layout.append({"id": int(marker_id), "board_corners_mm": points.tolist(), "page_xywh_mm": [ORIGIN[0] + x, ORIGIN[1] + y, 14, 14]})
    text(37.95, 231, "ChArUco 7 x 8 | DICT_5X5_100 | square 20 mm | marker 14 mm", 7)
    rect(57.95, 242.75, 100, 0.5)
    rect(57.95, 240, 0.25, 6)
    rect(157.70, 240, 0.25, 6)
    text(76, 251, "100 mm  /  outer edge to outer edge", 8)
    text(20, 261, "Check print scale in both axes; mount flat. Benchmark not approved; measured:false.", 8)
    text(20, 267, "Generated geometry only. Do not cover calibration corners. No physical accuracy claimed.", 8)
    bbox = [min(b[0] for b in bounds), min(b[1] for b in bounds), max(b[2] for b in bounds), max(b[3] for b in bounds)]
    if not (bbox[0] >= 10 and bbox[1] >= 10 and bbox[2] <= PAGE[0] - 10 and bbox[3] <= PAGE[1] - 10):
        raise SystemExit(f"Content outside 10 mm margins: {bbox}")
    c.showPage()
    c.save()
    manifest = {
        "schema": "timmy.fiducial-board/1", "status": "DRAFT / NOT APPROVED", "measured": False,
        "measured_reason": "benchmark not approved; physical print not checked",
        "provenance": "generated", "evidence_state": "constructed", "evidence_handles": [],
        "run_evidence": "unknown: no observed cite(handle_id) handles available",
        "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "pdf": {"filename": pdf.name, "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(), "page_mm": list(PAGE), "media_box_pt": [0, 0, 612, 792], "pages": 1, "content_bbox_mm": bbox, "minimum_margin_mm": min(bbox[0], bbox[1], PAGE[0]-bbox[2], PAGE[1]-bbox[3])},
        "runtime_pins": PINS, "opencv_api_version": cv2.__version__,
        "api": ["cv2.aruco.CharucoBoard", "setLegacyPattern(False)", "getObjPoints", "generateImageMarker(borderBits=1)"],
        "font": {"name": "Helvetica", "type": "PDF Base 14; ReportLab bundled AFM metrics", "embedded": False, "metrics_version": "ReportLab 4.4.9", "external_assets": []},
        "coordinates": {"units": "mm", "page_origin": "top-left", "page_axes": "+x right, +y down", "board_origin_page_mm": list(ORIGIN), "board_axes": "+x right, +y down, +z into page; right-handed", "printed_face_normal": "-z", "pdf_conversion": "x_pt=x_mm*72/25.4; y_pt=(279.4-y_mm)*72/25.4", "corner_order": "top-left, top-right, bottom-right, bottom-left"},
        "charuco": {"dictionary": "DICT_5X5_100", "dictionary_enum": int(a.DICT_5X5_100), "squares": [7, 8], "square_mm": 20, "marker_mm": 14, "border_bits": 1, "legacy_pattern": False, "outer_xywh_mm": [*ORIGIN, 140, 160], "quiet_zone_mm": 5, "ids": list(range(28)), "markers": marker_layout, "chessboard_corners_mm": board.getChessboardCorners().tolist()},
        "apriltag": {"dictionary": "DICT_APRILTAG_36h11", "dictionary_enum": int(a.DICT_APRILTAG_36h11), "family": "tag36h11", "size_convention": "24 mm across external black border detected corners; excludes white quiet zone", "border_bits": 1, "modules": 8, "markers": april},
        "scale_bar": {"xywh_mm": [57.95, 242.75, 100, 0.5], "endpoint_convention": "outer x edges of bar and endpoint ticks", "label": "100 mm", "use": "independent print check; never fitted then scored as independent"},
        "limitations": ["No physical printing or measurement", "No camera calibration or pose qualification", "No benchmark execution", "No physical scaled/mirrored/wrong-dictionary rejection test", "Same OpenCV implementation generates and digitally decodes markers", "UI readiness not claimed", "Digital hashes are detached computations, not signed receipts"]
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"pdf": str(pdf.resolve()), "sha256": manifest["pdf"]["sha256"]}))

if __name__ == "__main__":
    main()

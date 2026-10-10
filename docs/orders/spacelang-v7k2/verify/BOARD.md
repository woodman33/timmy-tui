# R1 draft board — FAILED / HOLD

The deterministic generator produced a one-page US Letter draft, but the frozen digital validation attempt failed. **Do not treat this artifact as a qualified calibration board.** The benchmark remains unapproved, `measured:false`, and no physical printing, calibration, camera capture or measurement occurred.

PDF SHA-256: `3340f733e32dcac936f779dde07aabc162f4d6cf3134b918ba5c27dd4f1b450f`.

The gitignored local output is `.timmy/private/space/r1/board/run-a/timmy-fiducial-letter-draft.pdf`. The operator receives its resolved path separately; private workstation paths are deliberately absent here. The generator source and [manifest](BOARD-MANIFEST.json) retain the complete layout and dependency pins. Authority: ORDER spacelang-v7k2 §§2, 8–10; A1 measurement boundaries; A2 worktree/runtime amendment; repository AGENTS §§4–8; DOCTRINE “Write budgets,” “Evidence,” “Geometry is a ledger,” and “Delivery size.” DESIGN and decisions remain unchanged.

## Constructed layout

All lengths below are generated geometry, evidence state `constructed`; they do not describe a measured physical print. Page coordinates are millimetres from the top-left, +x right and +y down. Board origin is page `(37.95, 65)`, +z into the page, right-handed. PDF coordinates are converted explicitly from those values.

| Item | Frozen construction |
|---|---|
| Page | 215.9 × 279.4 mm; MediaBox 612 × 792 pt |
| ChArUco | 7 × 8 squares, each 20 mm; 14 mm markers; DICT_5X5_100; IDs 0–27; OpenCV legacy pattern disabled |
| ChArUco quiet zone | 5 mm around the 140 × 160 mm grid |
| AprilTag | tag36h11 IDs 0 and 1; outer detected black border 24 mm; one black border module; 4 mm white quiet zone |
| AprilTag upper-left positions | `(37.95, 28)` and `(153.95, 28)` |
| Scale check | 100 mm between outer bar/tick edges; x = 57.95 to 157.95; bar y = 242.75 to 243.25 |
| Computed content bounds | `(20, 12.2137611111)` to `(177.95, 267.5842)` mm; minimum computed margin 11.8158 mm |
| Fonts | PDF Base 14 Helvetica; ReportLab 4.4.9 bundled metrics; no external images or font assets; font not embedded |

The PDF says “DRAFT,” “benchmark not approved,” and “measured:false.” Printing instructions are actual size / 100%, fit-to-page disabled, flat mounting, and independent print-scale checks in both axes. Those are future operator instructions, not completed checks.

## Observed attempt and failure

Before execution, a private constraints file froze the expected page dimensions, 10 mm minimum margins, 100 mm bar, all marker IDs, 42 ChArUco intersections, 0.30 mm raster localization tolerance, and 0.001 mm vector tolerance. The generator, validator and constraints were hashed before the attempt. This was a local digital construction check, not an approved workflow benchmark.

Two generator invocations produced PDFs with the identical SHA-256 above. Poppler 26.04.0 rasterized the actual PDF at 300 dpi into a 2550 × 3300 image. Visual inspection observed the full grid, two tags, scale bar and draft notices. This establishes no detector or physical accuracy claim.

The frozen validator stopped with:

```text
AttributeError: module 'cv2.aruco' has no attribute 'interpolateCornersCharuco'
```

The pinned OpenCV package exposes the newer detector API, but the validator incorrectly invoked the absent legacy interpolation function. The validator and all failed-attempt artifacts remain unchanged. No repair or rerun followed. Earlier check values were buffered and never written; therefore no individual detector/dimension PASS is claimed from them. AprilTag detection and subsequent scale checks were not reached. The validator's standalone exit code was not retained; its enclosing logging command returned 0 after printing the traceback. The traceback establishes failure, and that wrapper status must not be reported as a passing validator.

The private attempt retains `CONSTRAINTS.md`, `freeze.json`, `validate.py`, `validation.log`, `failed-attempt.json`, both generated PDF/manifest pairs, the raster and installation/generation logs. Validator SHA-256: `e4527c222746c9f4835ec8641a9e63618d78e77e81b521457b1997a1e1b257e1`. Raw failure-log SHA-256: `9aa75da271d7c8a0c291192140a204ff93debfb579831a56cca6a7a11300abc1`.

## Runtime and reproducibility

Inventory found Python 3.12.14, ReportLab 4.4.9, Pillow 12.3.0 and NumPy 2.3.5 in the bundled runtime, with no OpenCV there. A separate existing system Python had OpenCV 5.0.0 and was left untouched. The private virtual environment inherits the bundled rendering libraries and pins OpenCV headless 4.12.0.88 plus NumPy 2.2.6. Cached OpenCV copies were also found by the broader inventory, but no previously isolated, compatible runtime was established. No system Python or application dependency files were modified.

The only package-network operation was:

```sh
uv pip install --python .timmy/private/space/r1/board/venv/bin/python \
  opencv-python-headless==4.12.0.88 numpy==2.2.6
```

Source: PyPI. Installer reported a 36.1 MiB OpenCV wheel download; NumPy was available from cache. OpenCV uses Apache-2.0, NumPy BSD-3-Clause and ReportLab BSD licensing. No vendor source was copied into the repository. The generator checks exact versions before writing and refuses to overwrite an existing PDF or manifest.

For a separately authorized future execution, supply an explicit Python executable matching every pin and a new private output directory:

```sh
"$BOARD_PYTHON" docs/orders/spacelang-v7k2/verify/board_generator.py \
  --output-dir .timmy/private/space/r1/board/new-attempt
```

This command is documentation, not permission to repeat the failed qualification. A new authorized attempt must retain this failure, inspect the installed ChArUco API before freezing, persist each result and process exit status as it occurs, and independently check the PDF raster. Generation and decoding currently share OpenCV dictionary implementation; there has been no independent-family implementation check. Physical scaled/mirrored/wrong-dictionary controls and printer-scale uncertainty remain NOT RUN. No observed `cite(handle_id)` handles are available; model-authored run evidence remains unknown. Digital file hashes are detached computations, not signed receipts. UI readiness not claimed.

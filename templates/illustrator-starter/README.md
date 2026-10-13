# Illustrator starter

Two ExtendScript scripts that Timmy runs inside Adobe Illustrator itself, as judged jobs:

| Script | What it does | Run it |
|---|---|---|
| `badge.jsx` | one artboard of 600 x 400 pt with a labelled badge: a charcoal rectangle with a green border, a green ring, a five-pointed star, a rule, and the point text "TIMMY" | `/illustrator author badge.jsx --name badge` |
| `edit.jsx` | changes the label to "TIMMY 2" and adds a thinner ring inside the first | `/illustrator edit out/illustrator/badge-v1.ai edit.jsx` |

`/illustrator inspect out/illustrator/badge-v2.ai` has Illustrator read a document back. The scripts hold nothing
but the shapes above: edit them freely. Their colours are Timmy Homebrew's (charcoal, off-white and green).

**Status: implemented; not run with Illustrator.** Timmy's tests run both scripts, and the harness that wraps
them, on a stand-in of Illustrator's scripting objects (`tests/fixtures/fake-illustrator.mjs`, a labelled test
double standing in for osascript and Illustrator). No run in this repository has driven the real application yet.

## What happens in a run

Illustrator is scripted only through the application, so a run starts it, or brings it forward, and its window
opens. Timmy asks it with osascript and Adobe's AppleScript command `do javascript`:

    osascript -e 'with timeout of N seconds' -e 'tell application "Adobe Illustrator" to do javascript file "<harness.jsx>"' -e 'end timeout'

1. Timmy writes the run's folder, `.timmy/native/<run>/`: a copy of your script (byte for byte, read-only),
   `harness.jsx` (generated for this run, read-only, its sha256 recorded) and `illustrator.json`.
2. The harness sets Illustrator's alert level to "don't display alerts" for the run and puts it back after;
   it writes a first result, and stops at once, touching nothing, if the document it is to open (or save as) is
   already open in Illustrator. Then:
   - `author`: a new RGB document, saved at once as `out/illustrator/<name>-v<N>.ai` (it is `TIMMY.document` in
     your script);
   - `edit`: opens the document you named and at once saves it as its next version, so nothing your script saves
     can land on the document you named;
   - `inspect`: opens the document only to read it.
3. It runs your script inside `try`/`catch`, saves the new version (not after an error), exports
   `<name>-v<N>.svg` and `<name>-v<N>.pdf` beside it, and `<name>-v<N>.png` (the artboard at 100 %) when
   Illustrator's PNG export options allow; it reads the document back (artboards and their sizes, layers, path
   items with their bounds, text frames' contents), closes it without saving again, and writes
   `.timmy/native/<run>/result.json`. An inspect run exports only an SVG, into the run's folder.
4. Timmy judges the run by that result file (this run's token, your script's sha256 echoed and as Illustrator
   read it, `ok`), the `.ai`, `.svg` and `.pdf` having been created during this run (their sha256 computed by
   Timmy after the run), the harness unchanged, and, for `edit` and `inspect`, the document you named byte for
   byte as it was. What the result lists is Illustrator's own report of its own document.

Your script runs from its copy in the run's folder. To reach files beside the original, use `TIMMY.scriptDir`
(the original script's folder) or `TIMMY.root` (the project folder); `TIMMY.saveTo` is the new version's path.

## Timmy's own reading

Beside Illustrator's report, Timmy reads the exported SVG itself, as plain text (nothing in it is run, loaded or
expanded): the artboard's size from its `viewBox` (and `width` and `height`), how many path, rect, circle,
ellipse, line, polyline and polygon elements it draws, the characters of its text elements, and the bounds of the
drawn shapes, computed from their coordinates without a renderer. It compares each with Illustrator's report and
says **agrees**, or **differs** with both numbers. The artboard is compared to the digits the SVG wrote, the
bounds to the precision the export was asked for (3 decimals), and the PNG's pixels to the artboard within one
pixel. A text's extent needs its font, so texts are compared by their characters, not their bounds.

## Before the first run

- Adobe Illustrator installed. Timmy looks for `TIMMY_ILLUSTRATOR` first (`Adobe Illustrator.app`), then in
  `/Applications/Adobe Illustrator <version>/`, newest first.
- macOS may ask once whether the app you run Timmy in (your terminal) may control Adobe Illustrator. That is
  yours to answer. If it was refused, a run ends saying osascript was "Not authorized to send Apple events"
  (-1743): turn it on under System Settings › Privacy & Security › Automation, under your terminal's name, then
  run again. Timmy never grants this permission and never opens System Settings.
- Close the document you are about to edit or inspect in Illustrator: Timmy never saves, closes or reads over a
  document open there.

## From Timmy's agent

`run_native` with `app: illustrator` and `mode: author`, `edit` or `inspect` (`script`, `project_file`,
`name`). It is asked every time.

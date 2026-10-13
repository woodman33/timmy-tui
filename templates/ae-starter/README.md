# After Effects starter

Two ExtendScript scripts that Timmy runs inside After Effects itself, as judged jobs:

| Script | What it does | Run it |
|---|---|---|
| `author.jsx` | a 1920x1080, 30 fps, 10 s comp `Main`; a dark solid `Background`; a centred text layer `Title`; a small solid `Mover` with two Position keyframes (0 s and 2 s) | `/ae author author.jsx --name promo` |
| `edit.jsx` | changes the `Title` text in `Main` to "Title, edited" and adds a text layer `Subtitle` | `/ae edit out/ae/promo-v1.aep edit.jsx` |

Both find properties by match name (`ADBE Transform Group`, `ADBE Position`, `ADBE Text Document`), so they
work in any language After Effects runs in. They hold nothing but the shapes above: edit them freely.

**Status: implemented; not run with After Effects.** Timmy's tests run both scripts, and the harness that
wraps them, on a stand-in of After Effects' scripting objects (`tests/fixtures/fake-afterfx.mjs`, a labelled
test double). No run in this repository has driven the real application yet.

## What happens in a run

After Effects is scripted only through the application, so a run starts it, or brings it forward, and its
window opens. Aerender cannot make or change a project; it renders one that exists.

1. Timmy writes the run's folder, `.timmy/native/<run>/`: a copy of your script (byte for byte, read-only),
   `harness.jsx` (generated for this run, read-only, its sha256 recorded) and `ae.json`.
2. macOS: `osascript` asks the application to `DoScriptFile` the harness, inside an AppleScript timeout.
   Windows: `AfterFX.exe -r <harness.jsx>`.
3. The harness reads (never changes) the preference that lets scripts write files, writes a first result,
   and stops at once if After Effects has a project open with unsaved changes. Then:
   - `author`: a new project, saved at once as `out/ae/<name>-v<N>.aep`;
   - `edit`: opens the project you named and at once saves it as the next version, so nothing the script saves
     can land on the project you named;
   - `inspect`: opens the project only to read it, and closes it unsaved.
4. It runs your script inside `try`/`catch`, saves the new version (not after an error), reads the comps back
   (name, size, duration, fps, each layer's name and kind, keyframe counts, the text of text layers) and writes
   `.timmy/native/<run>/result.json`.
5. Timmy judges the run by that result file (this run's token, your script's sha256 echoed and as After
   Effects read it, `ok`), the new version having been created during this run, its sha256 computed by
   Timmy after the run, the harness unchanged, and, for `edit` and `inspect`, the project you named byte for
   byte as it was. What the result lists is After Effects' own report of its own project, not an independent
   reading.

Your script runs from its copy in the run's folder. To reach files beside the original, use `TIMMY.scriptDir`
(the original script's folder) or `TIMMY.root` (the project folder); `TIMMY.saveTo` is the new version's path.

## Before the first run

- After Effects installed. Timmy looks for `TIMMY_AFTERFX` first (the `.app` on macOS, `AfterFX.exe` on
  Windows), then on macOS in `/Applications/Adobe After Effects <version>/`, newest first.
- In After Effects: Settings (Preferences in older versions) > Scripting & Expressions > "Allow Scripts to
  Write Files and Access Network" on. Without it the harness cannot write its result; when After Effects says
  the setting is off, the run stops before touching any project and says this step. Timmy never changes it.
- Save or close any project open in After Effects with unsaved changes: a run never saves or discards them.
- macOS may ask once whether your terminal may control After Effects (Automation): allow it.

## Then

- `/ae inspect out/ae/promo-v1.aep` has After Effects read a project back into JSON: the same application
  reading its own file, not an independent reader.
- `/ae out/ae/promo-v1.aep Main out/promo-v1.mov` renders it with aerender; its frames are judged as any
  render.
- From Timmy's agent: `run_native` with `app: afterfx` and `mode: author`, `edit` or `inspect` (asks first).

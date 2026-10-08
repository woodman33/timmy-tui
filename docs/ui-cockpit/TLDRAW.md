# Timmy Canvas: tldraw inside Timmy (plan F-4)

Inventory (AGENTS.md §8), first written 2026-10-07 05:18, revised for the fourth order's step 5
(tldraw bundled on this machine). Status, on the ladder from the plan's rules: proposed, installed:
yes (a pinned build-time dependency, bundled into Timmy's package), reachable: yes, exercised: yes,
qualified: no.

| | |
|---|---|
| Version | tldraw 5.5.2 and @tldraw/assets 5.5.2, exact devDependencies, and `TLDRAW_VERSION` in `src/studio/config.ts`. Tests keep the three equal; the build stops when they differ, and the page refuses a bundle built from another version |
| How it loads | `scripts/canvas/build.mjs` (run by `npm run build` and `npm run build:canvas`) bundles `companion/studio-canvas/src/canvas.js` with tldraw and React into `companion/studio-canvas/dist/canvas.js` and `canvas.css` (esbuild), and copies tldraw's fonts, icons, translations and embed icons into `dist/assets`. react and react-dom must be one version (React refuses to run otherwise; the build checks). The bundle is built, not committed (`dist/` is ignored), and ships in the npm package (`files`) |
| Where it runs | Served on 127.0.0.1 only by `src/studio/server.ts` (default port 4337); a request addressed to any other host gets 403. A canvas not built yet gets a page saying how to build it |
| Network | In Chromium the page made 42 requests, all to 127.0.0.1, with every other host blocked and logged (none tried). The one exception by design: paste a web address onto the canvas and tldraw fetches that page to make a bookmark card |
| The key | `TLDRAW_LICENSE_KEY`. In GitHub it is an Actions secret of that name (the operator, 05:04); locally it is the same environment variable from the private overlay. The server reads it at run time and hands it to the page; it is never stored in the repo, never printed, and never built in (a test builds with a key in the environment and finds none in the bundle). tldraw verifies it offline in the page, against the hosts it lists |
| What the key changes | On http://127.0.0.1 tldraw runs in its development mode, by its own check of the page's address: every feature works, nothing is sent to tldraw, and it shows a "Get a license for production" note. On a public address without a valid key, tldraw hides the editor after 5 seconds and requests a tracking image from its CDN. An expired key hides the editor after 5 seconds even on 127.0.0.1 (tldraw 5.5.2's `LicenseProvider`) |
| Control surface | The full Editor API: the page hands the live editor to Timmy as `window.timmyCanvas.editor`, and the agent's canvas tools reach it through the bridge |
| Shown status | tldraw's own license verdict (`editor.licenseManager.state`), never "licensed" because a key is present |

## The tldraw license

The license text is in tldraw's repository (read at the v5.5.2 tag; the npm package's own
LICENSE.md is one line pointing to it). The build knows the verbatim text by its sha256. In short,
it lets you use tldraw in development environments, modify it, bundle it with your own projects and
send changes to tldraw, on these conditions:

- No use in a production environment without a trial or commercial license key. Production means a
  deployment that gives functionality to end users, customers or the public; development means
  internal hosting for development, testing or staging that end users cannot reach.
- Do not disable, change or interfere with the license key checks. Timmy passes the key through
  untouched and shows tldraw's own verdict.
- Do not remove copyright or other notices, and do not relicense it in a way that overrides its terms.
- Distribute it only as part of another application, never on its own.
- Include a verbatim copy of the license in any distribution, and pass on its warranty disclaimer
  and limit of liability (both are in the copy). The build copies it beside the bundle as
  `dist/LICENSE-tldraw.md` when `companion/studio-canvas/LICENSE-tldraw.md` is present and matches
  the hash; otherwise it marks the build not distributable, and `npm pack` refuses it (`prepack`
  runs `node scripts/canvas/build.mjs --check`). The text is not in the repo yet: decision 3.
- Follow tldraw's trademark policy.
- The license ends on a breach, or on a copyright, trade secret or patent claim against tldraw or
  its users.

The other packages in the bundle (130 in all: MIT 125, ISC 1, 0BSD 1, and tldraw's 3 under the
tldraw license) are listed with their own license files in `dist/THIRD-PARTY-NOTICES.md`, written
by each build. One, react-remove-scroll-bar 2.3.8, ships no license file; its repository's MIT
license belongs at `companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE`, and until it
is there the build is not distributable either (decision 3). A test fails on any license outside
MIT, ISC, BSD, Apache-2.0, 0BSD and tldraw's.

## Decisions for the operator

1. Publishing Timmy with the canvas inside gives tldraw to Timmy's users, which the license counts as
   production use. It needs your commercial license to cover distribution in Timmy, and the key's
   hosts must cover where the canvas runs (127.0.0.1 or localhost). Until then the canvas is for
   development on your own machines; nothing is published (already the rule).
2. The license check (`.github/workflows/tldraw-license.yml`) has not run: GitHub runs a by-hand
   workflow only once the file is on the default branch. After a merge:
   `gh workflow run tldraw-license.yml --ref <branch>`, then read the `tldraw-license` commit status.
3. The two license texts each name an email address (tldraw's sales address; the MIT author's), and
   the privacy gate blocks every email address (`pii.email`). Either let the gate pass third-party
   license texts (for example an ignore path for `companion/studio-canvas/LICENSE-tldraw.md` and
   `companion/studio-canvas/licenses/`), or keep them in the private overlay for package builds on
   your machine, or keep the canvas out of the package. Until then a package cannot be built.
   On 2026-10-07 at 17:06 the operator asked for the exception, prepared for review. Its exact form,
   pinned to each file's path and bytes, is in `LICENSE-EXCEPTION.md` with `license-exception.patch`.
   It is not applied.

The Mission Map (`studio/tldraw-mission-map`, tldraw 3.15.0 from a CDN) is another hand's lab and is
left as it is.

## Next slices (fourth order, step 5)

- Save and reopen through Timmy (the canvas file on this machine, not only the browser's storage),
  one job identity and source revision shared by the terminal and the page, links to jobs and receipts.
- A blank guided board, loading and error states, public templates blank, and the Canvas tab in the
  browser companion.
- A real-browser acceptance check: 127.0.0.1 only, resize, keyboard, readability.

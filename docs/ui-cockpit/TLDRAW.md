# Timmy Canvas: tldraw inside Timmy (plan F-4)

Inventory before adoption (AGENTS.md §8), 2026-10-07. Status, on the ladder from the plan's rules:
proposed, installed: no (not an npm dependency yet), reachable: yes, exercised: yes, qualified: no.

| | |
|---|---|
| Version | tldraw 5.5.2 (published 2026-10-02), pinned exactly in `src/studio/config.ts` and the page; a test keeps the two equal |
| Where it runs | `companion/studio-canvas/index.html`, served on 127.0.0.1 only by `src/studio/server.ts` (default port 4337); requests addressed to any other host get 403 |
| How it loads | From esm.sh at that exact version (immutable URLs), with React 19.2.1, as the Mission Map already does. Bundling tldraw into Timmy's npm package waits for the decision below |
| License terms | tldraw SDK license: free in development; production deployments need a license key; hobby keys show a watermark; trial keys last 100 days |
| The key | `TLDRAW_LICENSE_KEY`. In GitHub it is an Actions secret of that name (the operator, 05:04); a workflow maps it into the environment. Locally it is the same environment variable from the private overlay. Read at run time, never stored in the repo, never printed. tldraw says keys are not secret: they are domain-locked and verified offline in the page |
| What the key changes | Nothing on 127.0.0.1 (development mode: the whole Editor API works, with a "Get a license for production" note). On a public HTTPS domain, tldraw 5 stops drawing after 5 seconds without a valid key, and collaboration and commenting turn on only if the license includes them |
| Network | The page fetches tldraw and React from esm.sh. tldraw sends a tracking request to its CDN only in production when unlicensed or watermarked, never in development (its LicenseManager code, read 05:00) |
| Control surface | The full Editor API: the live editor showed 339 methods in Chromium, and the page hands it to Timmy as `window.timmyCanvas.editor` |
| Shown status | The page shows tldraw's own license verdict (`editor.licenseManager.state`), never "licensed" because a key is present |

Real-browser runs (Chromium, 05:16): with no key and with a bad key, the canvas drew, created and read back a shape, kept rendering past 5 seconds, showed "unlicensed, fine locally", and logged no errors.

The Mission Map (`studio/tldraw-mission-map`, tldraw 3.15.0) is another hand's lab and is left as it is.

## Decisions for the operator

1. Bundle tldraw into Timmy's npm package (the code then ships to every user's machine, under the tldraw license) or keep loading it from the CDN. Check that your license covers distribution in Timmy.
2. Which domains the license lists, once the check workflow has run (it reports only the count).

## Next slices

2. The bridge: the agent's canvas tools run Editor API code on the live page and read it back, each call tied to a job ID, through the studio server.
3. A real-browser acceptance suite on the page's DOM (readability, status faults).
4. The license check workflow on the GitHub secret, and `timmy studio` with `/web studio`.
5. Custom shapes for receipts, lanes, upmd blocks and harness panes.

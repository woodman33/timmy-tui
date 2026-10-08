# The license-file privacy exception (applied)

Prepared for the operator's review on 2026-10-07 (his 17:06 PT order). He approved it at 20:14 PT,
limited to these two files, their hashes and `pii.email`. It was applied at 20:20 PT exactly as
reviewed: `license-exception.patch` (sha256 `71aca38a0e4592610a6751158252299252b42cd17c45dce3c4b1cc8649cf5195`)
plus the two texts, fetched again from the pinned commits with the hashes below. The approval covers
keeping the license texts and the scanner exception. It does not establish a commercial tldraw
license, which stays a publication gate (decision 1 in `TLDRAW.md`).

## What is blocked

| Path in the repository | Size | SHA-256 | Source | What the gate finds |
| --- | --- | --- | --- | --- |
| `companion/studio-canvas/LICENSE-tldraw.md` | 4,609 bytes, 70 lines | `9578fcddc20e404b6a29f44b6fea81d8b331698c0e7e9be34132d6f4394fa533` | `LICENSE.md` of tldraw/tldraw at tag `v5.5.2` (commit `be4d5b30cbf896c92436d634e59843a920705cef`; the tag object is `c58cfd57`) | `pii.email` (high), line 5, column 171: tldraw's published sales address |
| `companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE` | 1,093 bytes, 21 lines | `a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84` | `LICENSE` of theKashey/react-remove-scroll-bar at commit `8ca9ba5ea52de03308fe8ced94f7b159a44d28ff` (the 2.3.8 package and its tags ship none) | `pii.email` (high), line 3, column 36: the author's address in the MIT copyright line |

Those two findings are all the Timmy scan finds in either file. gitleaks 8.24.3, the version the
privacy workflow runs, finds nothing in either (a fake secret planted in the same scratch
repository did trip it). Both texts were fetched again at 17:15 PT and are byte-identical to the
copies the canvas build was checked with at 12:21. The operator's Mac fetched both once more from
the commit addresses above for its own build, with the same hashes.

They have to ship as they are. tldraw's license requires a verbatim copy in any distribution, and
MIT requires its notice, copyright line included, in all copies. The canvas build already pins the
tldraw text's SHA-256, and `prepack` refuses a package without both texts, so `npm pack` cannot
succeed until they are in the repository or supplied at build time.

## The exception: by path and exact bytes

Add a list, `exempt_blobs`, to `lanes/privacy/patterns.json` with exactly these two entries:

```json
"exempt_blobs": [
  {
    "path": "companion/studio-canvas/LICENSE-tldraw.md",
    "sha256": "9578fcddc20e404b6a29f44b6fea81d8b331698c0e7e9be34132d6f4394fa533",
    "patterns": ["pii.email"],
    "why": "the tldraw license, verbatim from the v5.5.2 tag (commit be4d5b30); it requires a verbatim copy in any distribution. Its one match is tldraw's published sales address (line 5). The canvas build pins the same sha256."
  },
  {
    "path": "companion/studio-canvas/licenses/react-remove-scroll-bar.LICENSE",
    "sha256": "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84",
    "patterns": ["pii.email"],
    "why": "the MIT license of react-remove-scroll-bar (bundled with tldraw; its 2.3.8 package ships none), verbatim from its repository at commit 8ca9ba5e; MIT requires the notice in copies. Its one match is the author's address in the copyright line (line 3)."
  }
]
```

`lanes/privacy/scan.mjs` gets a new sealed rule, `EXEMPT_RULE` (privacy.rule exempt-blob v1). The
tree, staged and history scans drop the findings of the patterns an entry names when a file's path
is the entry's path and its bytes have the entry's SHA-256. Each scan reports how many it dropped,
as `exempted`. Everything else is still scanned:

- One byte changed at a pinned path: blocked.
- The same bytes at any other path: blocked.
- A pattern the entry does not name: blocked. Adding one also changes the bytes, so the whole file
  would be scanned anyway.
- A malformed entry stops the gate (exit 2) instead of exempting anything. That covers a bad hash,
  an unknown pattern, an empty pattern list or reason, a wildcard, and a repeated path.

One side change makes the history scan stricter for every file. It now scans a blob once per path
instead of once overall, so an exemption at one path can never cover a copy of the same bytes at
another path. The negative control below found this: before the fix, that copy was skipped.

The whole change is in `license-exception.patch` beside this file. It applies cleanly to `ff77c36`:

| File | What changes | Lines added | Lines removed |
| --- | --- | --- | --- |
| `lanes/privacy/patterns.json` | the two entries | 14 | 0 |
| `lanes/privacy/scan.mjs` | the rule, the filter, the per-path history step, the `exempted` count | 41 | 15 |
| `lanes/privacy/scan.d.mts` | the matching type surface | 9 | 3 |
| `tests/privacy-exempt-blobs.test.ts` (new) | 8 cases | 118 | 0 |

In all: 182 lines added and 18 removed. gitleaks needs no exception.

## Evidence

All of this ran in a scratch clone, not on this branch.

- **Test first.** `tests/privacy-exempt-blobs.test.ts` was RED with 5 of 7 failing because the
  feature was missing. Its two negative controls passed before and after, as they must. It then went
  GREEN, 7 of 7. An eighth case, a copy at a second path in the same commit's history, was RED
  against the old once-per-blob step and GREEN after.
- **End to end, with the two texts at their paths.** The tree scan passed with 0 gated and 2
  exempted. So did the staged scan and the history scan of `origin/main..HEAD`.
- **Controls end to end.** With one byte added to the tldraw text, the tree scan blocked it
  (1 gated). With the tldraw text copied into `docs/`, the tree scan blocked it (1 gated).
- **Other checks.** The §12 fixture still trips the gate (17 gated). The suites that use the
  scanner, plus the canvas bundle, passed: 9 files, 105 tests. `tsc` reported 0 errors. gitleaks
  8.24.3 found no leaks on the commit.

## Rejected alternative

Two `ignore_paths` entries need no code, but they would let any content through at those paths
forever, including a personal address added later. The pinned rule lets through only today's bytes.

## To apply, after approval

Do it in one commit, so no scan ever sees the texts without their exemption:

1. `git apply docs/ui-cockpit/license-exception.patch`.
2. Add the two texts from the pinned sources above.
3. Check both SHA-256 values.
4. Run the test, the three scans and gitleaks.
5. Commit.

CI's privacy job should then pass, reporting `exempted: 2`.

## A separate item found by the same check

This is not part of the exception and is not applied.

gitleaks 8.24.3 over all 47 commits of this branch (`origin/main..HEAD`) finds one match:

- **What it is.** A `generic-api-key` match in `scripts/ui/replay-sandbox.sh` line 54 at `c9a4755`.
  gitleaks read the empty `OPENROUTER_API_KEY=` assignment together with the next word as a value.
  It is not a secret.
- **Where it stands.** That push's gate failed on it at the time, and `30f2942` removed it from the
  tree. It stays in history.
- **Why CI no longer sees it.** The push scan covers only each push's own commits. The
  pull-request scan on `18e3d70` covered 30 commits (`d6d39cc` to `f6d53f6`), not all 47.
- **What happens on merge.** A merge that keeps the branch's commits carries it to main, where a
  full-history gitleaks run would flag it. A squash merge avoids that.
- **To clear it.** Add one line to `.gitleaksignore`:
  `c9a475548f74f13da16c0f0cdf795bf6a6678afe:scripts/ui/replay-sandbox.sh:generic-api-key:54`. That
  file needs your approval.

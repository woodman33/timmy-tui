# C-18: the corrected candidate's acceptance record (incomplete)

The acceptance of the corrected release candidate, `timmy-tui` `2.0.0-rc.2` at `8319f8f`, for the operator's 00:28 order: C-17's two release issues fixed (the environment's model key stays transient; a cancelled request is closed in the conversation), bound to a new source revision and tarball hash under a new prospective freeze. C-17 stays as it was, in `../c17/`. It is not launch approval: merge, publish, tags and deploys wait for the operator.

**Outcome: incomplete, not a pass.** Frozen at 01:54:31 PT on 2026-10-08 at `5b82857`, with 2,284 files, Node 24.21.0 and tmux 3.4. `5b82857` differs from the candidate's code, `8319f8f`, only under `docs/ui-cockpit/`. The run started at 01:54:33 PT with the machine to itself. By 01:59:51 it had recorded 56 of its 71 checks: **53 passed, 0 failed, 3 deferred** (CLI-18, TUI-01, TUI-03, each for the reason its freeze gives). It was taking the 120-column Timmy Night captures (its last files are from 02:00:05) when the workspace it ran in was restarted. The session had gone idle waiting about 9½ hours on a folder-access prompt, and the restart ended the run. No check failed; 15 never ran: CAP-night-120, CAP-day-60, CAP-day-80, CAP-day-120, COPY-01, COPY-02, SUITE-01, SUITE-02, CANVAS-01, REPLAY-01, INSTALL-01, REPLAY-02, LIVE-01, PRES-01 and PRES-02.

The run's three files are kept exactly as it left them. `results.json` is the file it was writing when it ended: it has no final summary, and its `stopped` field is empty. The 37 negative controls failed as they should and the 9 positive controls passed before the checks began; `controls.txt` is byte for byte the frozen replay's. Observed afterwards, not as checks: the shared receipt store (10,358 bytes, SHA-256 `1319086e…`) and the tree manifest (`3e5bbf68…`) were unchanged. This attempt is not rerun or rewritten. The same candidate code takes a new prospective freeze, C-19, in `../c19/`.

The candidate: source `8319f8fce293df1b706bcb802c739f77093fe92a`; package `timmy-tui-2.0.0-rc.2.tgz`, 1,070 files, 3,291,643 bytes, SHA-256 `eae8efb1e75ea002d0ab19a8278099489e330fa7ec621327b3ae62befa5c0eb5`. The Linux build, the Mac's build and the runner's are byte-identical (`builds.json`). The version stays `2.0.0-rc.2`, so the SHA-256 is what tells this tarball from C-17's (`21270459…`); neither is published.

| File | What it is |
| --- | --- |
| `freeze.json` | The freeze, taken before the run: the commit, Node and tmux versions, the SHA-256 of the tree manifest, the runner (`scripts/ui/qualify.ts`), its fixture, the contrast gate and the lockfile, the receipt store's preimage size and hash, the monitor's home, and all 71 checks with the deferred reasons |
| `results.json` | The run as far as it got: 56 checks with their status and evidence |
| `controls.txt` | The 37 negative controls, each failing on input known to be wrong (DOCTRINE §12), and 9 positive controls |
| `REQUEST` | The request that started the frozen REPLAY-02: the commit and `mode frozen` |
| `replay-02/` | REPLAY-02's evidence: run 37751016296 replayed `8319f8f` in frozen mode on a GitHub-hosted runner (65 passed, 0 failed, 4 deferred, 2 not run there), the workflow's artifact kept unchanged, with `IDENTITY.json` and `SHA256SUMS` |
| `live-01/` | LIVE-01 on the operator's Mac at `8319f8f`, through the installed tarball: the record (`live-01.json`), the screens, the receipts' fields, and `judge.json`, which reads each turn's calculator calls from the screen |
| `builds.json` | The tarball built on Linux, on the Mac and on the runner, with each toolchain and each SHA-256 |
| `package-audit.md`, `package-audit.json` | The package audit bound to the tarball's SHA-256 and the source commit |
| `SHA256SUMS` | The SHA-256 of every other file in this folder: `sha256sum -c SHA256SUMS` from here |

What C-18 checks beyond C-17:

- LIVE-01's record must show the turn after a cancel not finishing the cancelled request, and an explicit request to continue finishing it from what had finished. Two new negative controls feed it a record whose next turn resumed the cancelled request and a record without an explicit resumption; each must be refused.
- SUITE-01 takes the two new suites: `tests/key-transient.test.ts` (a synthetic key, never printed) and `tests/repl-cancel-history.test.ts`.

The raw evidence (the tree manifest itself, PTY bytes, screens, captures, the install's logs) stays private, outside the repository, because it can show local paths. It is archived on the operator's Mac under `~/timmy/evidence/c18/`; the archives and their SHA-256 are in the ledger.
